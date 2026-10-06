// Banana server: one Node process over a SQLite file. No dependencies.
//
// Player routes
//   POST /hello        { playerId, modVersion, surface }                     -> { ok }          one per session: counts installs and players
//   POST /sync         { playerId, name?, gateway?, clicks, coins, drops }  -> { rank, totalPlayers, globalClicks, player, spendable, rate }
//   GET  /leaderboard                                                        -> { top: [{ name, coins, clicks }], globalClicks, totalPlayers }   (lifetime)
//   GET  /rate                                                               -> { coinsPerUsd, windowCoins, budgetUnits, windowHours, ... }
//   GET  /stock                                                              -> { [giftId]: left }
//   GET  /content                                                            -> the content.json the admin uploaded (404 before that)
//   POST /redeem       { playerId, giftId, gateway? }                        -> { claim, stockLeft, coins, price } | { error }
//
// Admin routes (header x-admin-token: $ADMIN_TOKEN)
//   PUT  /content      content.json                                          -> { ok } and seeds stock for new gifts
//   PUT  /stock        { giftId, left }                                      -> { ok }   (-1 = unlimited)
//   POST /codes        { giftId, codes: [] }                                 -> { ok, added, free }   one-time codes for a `pool` gift
//   GET  /codes        ?giftId=                                              -> { gifts: [{ gift_id, free, used }] }
//   GET  /claims       ?giftId=                                              -> { claims: [{ at, giftId, code, playerId, name, gateway, status }] }
//   GET  /stats                                                              -> installs, players, active counts, payouts
//
// Economy (content.economy): coins per $1 = coins everyone earned in the last
// windowHours ÷ (budgetUsd / unitUsd), never under minCoinsPerUsd. Coins older
// than the window are void; lifetime totals in `players` never are.
//
// Fulfilment of a `gateway` gift: the player's linked login on the LLM gateway
// (New API or One API) is topped up by usd × GATEWAY_QUOTA_PER_USD through the
// gateway's admin API. A `pool` gift hands out a one-time code; `code` and `url`
// gifts hand out their shared value.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)
const DATA_DIR = process.env.DATA_DIR ?? path.join(HERE, '..', 'data')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''
const GATEWAY = {
  kind: (process.env.GATEWAY_KIND ?? 'newapi').toLowerCase(),
  url: (process.env.GATEWAY_URL ?? '').replace(/\/+$/, ''),
  token: process.env.GATEWAY_TOKEN ?? '',
  quotaPerUsd: Number(process.env.GATEWAY_QUOTA_PER_USD ?? 500000),
}

const MAX_CLICKS_PER_SYNC = 600
const CLICKS_PER_LEVEL = 100
const NAME_MAX = 24
const DEFAULT_ECONOMY = { windowHours: 168, budgetUsd: 10, unitUsd: 1, minCoinsPerUsd: 500, fallbackCoinsPerUsd: 1000 }

// ---- database -----------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true })
export const db = new DatabaseSync(path.join(DATA_DIR, 'banana.sqlite'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
db.exec(fs.readFileSync(path.join(HERE, '..', 'schema.sql'), 'utf8'))

const q = {
  player: db.prepare('SELECT id, name, gateway, clicks, coins, drops, updated_at FROM players WHERE id = ?'),
  upsertPlayer: db.prepare(`INSERT INTO players (id, name, gateway, clicks, coins, drops, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      clicks = clicks + excluded.clicks, coins = coins + excluded.coins, drops = drops + excluded.drops,
      name = CASE WHEN ? IS NULL THEN name ELSE excluded.name END,
      gateway = CASE WHEN ? IS NULL THEN gateway ELSE excluded.gateway END,
      updated_at = excluded.updated_at`),
  setGateway: db.prepare('UPDATE players SET gateway = ? WHERE id = ?'),
  earn: db.prepare('INSERT INTO ledger (player_id, coins, remaining, earned_at) VALUES (?, ?, ?, ?)'),
  rank: db.prepare('SELECT COUNT(*) + 1 AS rank FROM players WHERE coins > ?'),
  totals: db.prepare('SELECT COUNT(*) AS totalPlayers, COALESCE(SUM(clicks), 0) AS globalClicks FROM players'),
  top: db.prepare('SELECT name, coins, clicks FROM players ORDER BY coins DESC, clicks DESC LIMIT 20'),
  windowCoins: db.prepare('SELECT COALESCE(SUM(coins), 0) AS n FROM ledger WHERE earned_at > ?'),
  spendable: db.prepare('SELECT COALESCE(SUM(remaining), 0) AS n FROM ledger WHERE player_id = ? AND earned_at > ?'),
  liveRows: db.prepare('SELECT id, remaining FROM ledger WHERE player_id = ? AND earned_at > ? AND remaining > 0 ORDER BY earned_at, id'),
  spendRow: db.prepare('UPDATE ledger SET remaining = remaining - ? WHERE id = ?'),
  stock: db.prepare('SELECT gift_id, left FROM stock'),
  stockOf: db.prepare('SELECT left FROM stock WHERE gift_id = ?'),
  setStock: db.prepare('INSERT OR REPLACE INTO stock (gift_id, left) VALUES (?, ?)'),
  seedStock: db.prepare('INSERT OR IGNORE INTO stock (gift_id, left) VALUES (?, ?)'),
  takeStock: db.prepare('UPDATE stock SET left = left - 1 WHERE gift_id = ? AND left > 0'),
  content: db.prepare('SELECT json FROM content WHERE id = 1'),
  setContent: db.prepare('INSERT OR REPLACE INTO content (id, json) VALUES (1, ?)'),
  freeCode: db.prepare('SELECT id, code FROM codes WHERE gift_id = ? AND used_by IS NULL ORDER BY id LIMIT 1'),
  useCode: db.prepare('UPDATE codes SET used_by = ? WHERE id = ? AND used_by IS NULL'),
  addCode: db.prepare('INSERT INTO codes (gift_id, code) VALUES (?, ?)'),
  codeCounts: db.prepare('SELECT gift_id, SUM(used_by IS NULL) AS free, SUM(used_by IS NOT NULL) AS used FROM codes GROUP BY gift_id'),
  claim: db.prepare('INSERT INTO claims (player_id, gift_id, code, at, status, detail) VALUES (?, ?, ?, ?, ?, ?)'),
  setClaimStatus: db.prepare('UPDATE claims SET status = ?, detail = ? WHERE id = ?'),
  claims: db.prepare(`SELECT c.id, c.at, c.gift_id AS giftId, c.code, c.status, c.detail, c.player_id AS playerId, p.name, p.gateway
    FROM claims c LEFT JOIN players p ON p.id = c.player_id WHERE (? IS NULL OR c.gift_id = ?) ORDER BY c.id DESC LIMIT 500`),
  hello: db.prepare(`INSERT INTO installs (player_id, first_seen, last_seen, sessions, mod_version, surface) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET last_seen = excluded.last_seen, sessions = sessions + 1, mod_version = excluded.mod_version, surface = excluded.surface`),
  stats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM installs) AS installs,
      (SELECT COALESCE(SUM(sessions), 0) FROM installs) AS sessions,
      (SELECT COUNT(*) FROM installs WHERE last_seen > ?) AS installsActive24h,
      (SELECT COUNT(*) FROM installs WHERE last_seen > ?) AS installsActive7d,
      (SELECT COUNT(*) FROM players WHERE clicks > 0) AS playersWhoClicked,
      (SELECT COUNT(*) FROM players WHERE updated_at > ? AND clicks > 0) AS playersActive24h,
      (SELECT COUNT(*) FROM players WHERE updated_at > ? AND clicks > 0) AS playersActive7d,
      (SELECT COUNT(*) FROM players WHERE gateway IS NOT NULL AND gateway != '') AS playersLinked,
      (SELECT COALESCE(SUM(clicks), 0) FROM players) AS globalClicks,
      (SELECT COALESCE(SUM(coins), 0) FROM players) AS lifetimeCoins,
      (SELECT COUNT(*) FROM claims WHERE status = 'paid') AS payoutsPaid,
      (SELECT COUNT(*) FROM claims WHERE status = 'failed') AS payoutsFailed`),
  versions: db.prepare('SELECT mod_version AS version, COUNT(*) AS installs FROM installs GROUP BY mod_version ORDER BY installs DESC'),
  surfaces: db.prepare('SELECT surface, COUNT(*) AS installs FROM installs GROUP BY surface ORDER BY installs DESC'),
}

// ---- helpers ------------------------------------------------------------------

const nowIso = () => new Date().toISOString()
const isoAgo = ms => new Date(Date.now() - ms).toISOString()
const isId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s)
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)))
const loadContent = () => {
  const row = q.content.get()
  return row ? JSON.parse(row.json) : null
}
const economyOf = content => ({ ...DEFAULT_ECONOMY, ...(content?.economy ?? {}) })
const cutoffOf = eco => isoAgo(eco.windowHours * 3600 * 1000)
const unitsOf = eco => Math.max(1, Math.round(eco.budgetUsd / eco.unitUsd))
const priceOf = (gift, rate) => (gift.usd !== undefined ? Math.ceil(gift.usd * rate) : gift.priceCoins ?? 0)

export function rateOf(content = loadContent()) {
  const eco = economyOf(content)
  const windowCoins = q.windowCoins.get(cutoffOf(eco)).n
  const budgetUnits = unitsOf(eco)
  return {
    coinsPerUsd: Math.max(eco.minCoinsPerUsd, Math.ceil(windowCoins / budgetUnits)),
    windowCoins,
    budgetUnits,
    windowHours: eco.windowHours,
    budgetUsd: eco.budgetUsd,
    unitUsd: eco.unitUsd,
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const bad = (message, status = 400) => new HttpError(status, message)

// ---- gateway top-up -----------------------------------------------------------

async function gatewayFetch(pathname, init = {}) {
  if (!GATEWAY.url || !GATEWAY.token) throw bad('gateway not configured on the server (GATEWAY_URL / GATEWAY_TOKEN)', 503)
  const res = await fetch(`${GATEWAY.url}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${GATEWAY.token}`, 'content-type': 'application/json', 'new-api-user': '1', ...(init.headers ?? {}) },
  })
  let body = {}
  try {
    body = await res.json()
  } catch {
    body = {}
  }
  if (!res.ok) throw bad(`gateway HTTP ${res.status}`, 502)
  if (body && body.success === false) throw bad(`gateway: ${body.message ?? 'refused'}`, 502)
  return body
}

/** Finds the gateway user by exact username (case-insensitive); both gateways answer GET /api/user/search?keyword=. */
async function gatewayUser(username) {
  const body = await gatewayFetch(`/api/user/search?keyword=${encodeURIComponent(username)}&p=1&page_size=50`)
  const data = body.data ?? []
  const list = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : []
  const hit = list.find(u => typeof u.username === 'string' && u.username.toLowerCase() === username.toLowerCase())
  if (!hit) throw bad(`no "${username}" on the gateway: register there first, then /banana link <your username>`, 404)
  return hit
}

/** Adds `usd` worth of quota to the player's gateway account. Returns a human line for the claim. */
export async function gatewayTopUp(username, usd, remark) {
  const user = await gatewayUser(username)
  const quota = Math.round(usd * GATEWAY.quotaPerUsd)
  if (GATEWAY.kind === 'oneapi') {
    // songquanpeng/one-api: AdminTopUp { user_id, quota, remark } (model.IncreaseUserQuota)
    await gatewayFetch(ONE_API_TOPUP_PATH, { method: 'POST', body: JSON.stringify({ user_id: user.id, quota, remark }) })
  } else {
    // QuantumNous/new-api: POST /api/user/manage { id, action: "add_quota", mode: "add", value } (model.AdjustUserQuota)
    await gatewayFetch('/api/user/manage', { method: 'POST', body: JSON.stringify({ id: user.id, action: 'add_quota', mode: 'add', value: quota }) })
  }
  return `Topped up $${usd} (${quota} quota) to ${user.username} on the gateway`
}
// songquanpeng/one-api router: apiRouter.POST("/topup", middleware.AdminAuth(), controller.AdminTopUp)
const ONE_API_TOPUP_PATH = process.env.GATEWAY_ONEAPI_TOPUP_PATH ?? '/api/topup'

// ---- routes -------------------------------------------------------------------

function hello(body) {
  const { playerId } = body ?? {}
  if (!isId(playerId)) throw bad('playerId missing')
  const at = nowIso()
  q.hello.run(playerId, at, at, String(body.modVersion ?? '').slice(0, 20), String(body.surface ?? 'unknown').slice(0, 20))
  return { ok: true }
}

function sync(body) {
  const { playerId } = body ?? {}
  if (!isId(playerId)) throw bad('playerId missing')
  const content = loadContent()
  const clicks = int(body.clicks, MAX_CLICKS_PER_SYNC)
  const name = typeof body.name === 'string' ? body.name.slice(0, NAME_MAX) : null
  const gateway = typeof body.gateway === 'string' ? body.gateway.trim().slice(0, 64) : null
  const at = nowIso()

  const before = q.player.get(playerId)
  const level = Math.floor((before?.clicks ?? 0) / CLICKS_PER_LEVEL)
  // Caps from the content: a click pays 1 + level, a drop sells for at most the
  // dearest banana, and drops per click cannot beat the summed drop chances.
  const specials = content?.specials ?? []
  const maxSell = Math.max(0, ...specials.map(k => Number(k.sellValue) || 0)) || 1000
  const dropRate = Math.min(1, specials.reduce((sum, k) => sum + (Number(k.chance) || 0), 0)) || 0.15
  const drops = int(body.drops, Math.ceil(clicks * dropRate) + 1)
  const coins = int(body.coins, clicks * (1 + level) + drops * maxSell)

  db.exec('BEGIN')
  try {
    q.upsertPlayer.run(playerId, name ?? '', gateway ?? '', clicks, coins, drops, at, name, gateway)
    if (coins > 0) q.earn.run(playerId, coins, coins, at)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  const player = q.player.get(playerId)
  const eco = economyOf(content)
  return {
    rank: q.rank.get(player.coins).rank,
    ...q.totals.get(),
    player,
    spendable: q.spendable.get(playerId, cutoffOf(eco)).n,
    rate: rateOf(content),
  }
}

function leaderboard() {
  return { top: q.top.all(), ...q.totals.get() }
}

function stock() {
  const out = {}
  for (const r of q.stock.all()) out[r.gift_id] = r.left
  return out
}

async function redeem(body) {
  const { playerId, giftId } = body ?? {}
  if (!isId(playerId)) throw bad('playerId missing')
  if (typeof giftId !== 'string' || !giftId) throw bad('giftId missing')

  const content = loadContent()
  const gift = content?.gifts?.find(g => g.id === giftId)
  if (!gift) throw bad('unknown gift (upload content.json to the server first)', 404)
  const player = q.player.get(playerId)
  if (!player) throw bad('unknown player: sync first')
  const gatewayLogin = ((typeof body.gateway === 'string' && body.gateway.trim()) || player.gateway || '').slice(0, 64)
  if (gatewayLogin && gatewayLogin !== player.gateway) q.setGateway.run(gatewayLogin, playerId)
  const kind = gift.claim?.kind ?? 'code'
  if (kind === 'gateway' && !gatewayLogin) throw bad('link your gateway login first: /banana link <username>')

  const eco = economyOf(content)
  const rate = rateOf(content)
  const price = priceOf(gift, rate.coinsPerUsd)
  if (price <= 0) throw bad('gift has no price')

  // 1. Take the coins, the stock and (for a pool gift) a code in one transaction.
  let claimText
  let claimId
  let freeCode
  db.exec('BEGIN IMMEDIATE')
  try {
    const spendable = q.spendable.get(playerId, cutoffOf(eco)).n
    if (spendable < price) throw bad(`need ${price - spendable} more coins (rate: ${rate.coinsPerUsd} coins per $${eco.unitUsd})`)
    const left = q.stockOf.get(giftId)?.left
    if (left === 0) throw bad('sold out')
    if (kind === 'pool') {
      freeCode = q.freeCode.get(giftId)
      if (!freeCode) throw bad('no code left for this gift: the sponsor has to load more', 409)
      claimText = freeCode.code
    } else if (kind === 'gateway') {
      claimText = `$${gift.usd ?? '?'} top-up to ${gatewayLogin} pending`
    } else {
      claimText = gift.claim?.value
      if (!claimText) throw bad('gift has no claim value')
    }
    let todo = price
    for (const row of q.liveRows.all(playerId, cutoffOf(eco))) {
      if (todo === 0) break
      const take = Math.min(row.remaining, todo)
      q.spendRow.run(take, row.id)
      todo -= take
    }
    if (left !== undefined && left > 0) q.takeStock.run(giftId)
    if (freeCode) q.useCode.run(playerId, freeCode.id)
    const status = kind === 'gateway' ? 'pending' : 'paid'
    claimId = q.claim.run(playerId, giftId, claimText, nowIso(), status, null).lastInsertRowid
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // 2. Pay out on the gateway. On failure the coins and stock go back.
  if (kind === 'gateway') {
    try {
      claimText = await gatewayTopUp(gatewayLogin, gift.usd ?? 1, `banana: ${gift.name} for player ${playerId}`)
      q.setClaimStatus.run('paid', claimText, claimId)
      db.prepare('UPDATE claims SET code = ? WHERE id = ?').run(claimText, claimId)
    } catch (err) {
      db.exec('BEGIN IMMEDIATE')
      try {
        q.setClaimStatus.run('failed', String(err.message), claimId)
        q.earn.run(playerId, 0, price, nowIso()) // refund as a fresh batch (not counted in the pool: coins = 0)
        db.prepare('UPDATE stock SET left = left + 1 WHERE gift_id = ? AND left >= 0').run(giftId)
        db.exec('COMMIT')
      } catch (inner) {
        db.exec('ROLLBACK')
        throw inner
      }
      throw bad(`payout failed, coins returned: ${err.message}`, err.status ?? 502)
    }
  }

  return {
    claim: claimText,
    coins: q.spendable.get(playerId, cutoffOf(eco)).n,
    price,
    stockLeft: q.stockOf.get(giftId)?.left ?? -1,
  }
}

function putContent(content) {
  if (!Array.isArray(content?.gifts) || typeof content.minVersion !== 'string') throw bad('not a content document')
  db.exec('BEGIN')
  try {
    q.setContent.run(JSON.stringify(content))
    for (const gift of content.gifts) q.seedStock.run(gift.id, gift.stock ?? -1)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { ok: true, gifts: content.gifts.length }
}

function putStock(body) {
  const { giftId, left } = body ?? {}
  if (typeof giftId !== 'string' || !Number.isInteger(left) || left < -1) throw bad('giftId and an integer left (-1 = unlimited)')
  q.setStock.run(giftId, left)
  return { ok: true, giftId, left }
}

function addCodes(body) {
  const { giftId, codes } = body ?? {}
  if (typeof giftId !== 'string' || !Array.isArray(codes) || codes.length === 0) throw bad('giftId and a non-empty codes array')
  const clean = [...new Set(codes.map(c => String(c).trim()).filter(Boolean))]
  db.exec('BEGIN')
  try {
    for (const code of clean) q.addCode.run(giftId, code)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const free = q.codeCounts.all().find(r => r.gift_id === giftId)?.free ?? 0
  return { ok: true, added: clean.length, free }
}

function stats() {
  const day = isoAgo(86400000)
  const week = isoAgo(7 * 86400000)
  return { ...q.stats.get(day, week, day, week), byVersion: q.versions.all(), bySurface: q.surfaces.all(), rate: rateOf() }
}

// ---- http ---------------------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type,x-admin-token',
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(data))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', chunk => {
      text += chunk
      if (text.length > 1_000_000) reject(bad('body too large', 413))
    })
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(bad('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

const isAdmin = req => !!ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const m = req.method
  try {
    if (m === 'OPTIONS') return send(res, 204, {})
    if (m === 'GET' && p === '/') return send(res, 200, { ok: true, service: 'banana', gateway: GATEWAY.kind })
    if (m === 'POST' && p === '/hello') return send(res, 200, hello(await readJson(req)))
    if (m === 'POST' && p === '/sync') return send(res, 200, sync(await readJson(req)))
    if (m === 'GET' && p === '/leaderboard') return send(res, 200, leaderboard())
    if (m === 'GET' && p === '/rate') return send(res, 200, rateOf())
    if (m === 'GET' && p === '/stock') return send(res, 200, stock())
    if (m === 'GET' && p === '/content') {
      const c = loadContent()
      return c ? send(res, 200, c) : send(res, 404, { error: 'no content uploaded' })
    }
    if (m === 'POST' && p === '/redeem') return send(res, 200, await redeem(await readJson(req)))
    if (p === '/content' || p === '/stock' || p === '/codes' || p === '/claims' || p === '/stats') {
      if (!isAdmin(req)) return send(res, 403, { error: 'forbidden' })
      if (m === 'PUT' && p === '/content') return send(res, 200, putContent(await readJson(req)))
      if (m === 'PUT' && p === '/stock') return send(res, 200, putStock(await readJson(req)))
      if (m === 'POST' && p === '/codes') return send(res, 200, addCodes(await readJson(req)))
      if (m === 'GET' && p === '/codes') {
        const giftId = url.searchParams.get('giftId')
        return send(res, 200, { gifts: q.codeCounts.all().filter(r => !giftId || r.gift_id === giftId) })
      }
      if (m === 'GET' && p === '/claims') {
        const giftId = url.searchParams.get('giftId')
        return send(res, 200, { claims: q.claims.all(giftId, giftId) })
      }
      if (m === 'GET' && p === '/stats') return send(res, 200, stats())
    }
    return send(res, 404, { error: 'not found' })
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    return send(res, status, { error: err.message ?? String(err) })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`banana server on :${PORT}, data in ${DATA_DIR}, gateway ${GATEWAY.kind} at ${GATEWAY.url || '(unset)'}`)
  })
}
