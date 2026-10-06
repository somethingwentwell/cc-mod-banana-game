// Pure game logic: no `$`, so tests hit it directly and the hooks stay thin.

import type { Content, Drop, Economy, Gift, Rarity, Save, SpecialBanana } from '../types'

export const MOD_VERSION = '0.1.0'
export const CLICKS_PER_LEVEL = 100

export const RARITY_ORDER: Rarity[] = ['legendary', 'epic', 'rare', 'common']

export const RARITY_COLOR: Record<Rarity, string> = {
  common: 'green',
  rare: 'blue',
  epic: 'magenta',
  legendary: 'yellow',
}

export const DEFAULT_ECONOMY: Economy = {
  windowHours: 168,
  budgetUsd: 10,
  unitUsd: 1,
  minCoinsPerUsd: 500,
  fallbackCoinsPerUsd: 1000,
}

export const emptySave = (): Save => ({
  coins: 0,
  clicks: 0,
  level: 0,
  inventory: [],
  claims: [],
  stock: {},
  ledger: [],
  lifetime: { clicks: 0, coins: 0, drops: 0 },
})

/** An older save (no ledger) becomes one batch earned now; a foreign value becomes empty. */
export function normalizeSave(v: unknown, at: string): Save {
  const s = v as Partial<Save> | null
  if (!s || typeof s !== 'object' || typeof s.coins !== 'number') return emptySave()
  const base = { ...emptySave(), ...s }
  if (!Array.isArray(s.ledger)) base.ledger = s.coins > 0 ? [{ at, coins: s.coins, left: s.coins }] : []
  if (!s.lifetime) base.lifetime = { clicks: s.clicks ?? 0, coins: s.coins, drops: (s.inventory ?? []).length }
  return base
}

export const windowMs = (eco: Economy): number => eco.windowHours * 3600 * 1000

export const budgetUnits = (eco: Economy): number => Math.max(1, Math.round(eco.budgetUsd / eco.unitUsd))

/** Coins per $1 from what everyone earned in the window, never under the floor. */
export const coinsPerUsd = (windowCoins: number, eco: Economy): number =>
  Math.max(eco.minCoinsPerUsd, Math.ceil(windowCoins / budgetUnits(eco)))

/** A gift's coin price at a rate: `usd × rate`, or its fixed price. */
export const priceOf = (gift: Gift, rate: number): number =>
  gift.usd !== undefined ? Math.ceil(gift.usd * rate) : (gift.priceCoins ?? 0)

const isLive = (at: string, nowMs: number, eco: Economy): boolean => nowMs - Date.parse(at) < windowMs(eco)

/** Drops the void ledger rows and bananas and recomputes the spendable balance. */
export function expire(save: Save, nowMs: number, eco: Economy): Save {
  const ledger = save.ledger.filter(row => row.left > 0 && isLive(row.at, nowMs, eco))
  const inventory = save.inventory.filter(drop => isLive(drop.at, nowMs, eco))
  const coins = ledger.reduce((sum, row) => sum + row.left, 0)
  if (ledger.length === save.ledger.length && inventory.length === save.inventory.length && coins === save.coins) return save
  return { ...save, ledger, inventory, coins }
}

/** When the oldest live coins or banana go void, as a time; undefined with nothing held. */
export function nextExpiry(save: Save, eco: Economy): number | undefined {
  const times = [...save.ledger.map(r => r.at), ...save.inventory.map(d => d.at)].map(at => Date.parse(at) + windowMs(eco))
  return times.length ? Math.min(...times) : undefined
}

export function earn(save: Save, coins: number, at: string): Save {
  if (coins <= 0) return save
  return {
    ...save,
    coins: save.coins + coins,
    ledger: [...save.ledger, { at, coins, left: coins }].slice(-2000),
    lifetime: { ...save.lifetime, coins: save.lifetime.coins + coins },
  }
}

/** Spends `amount` from the oldest batches first; throws when the balance is short. */
export function spend(save: Save, amount: number): Save {
  if (amount > save.coins) throw new Error(`need ${amount - save.coins} more coins`)
  let todo = amount
  const ledger = save.ledger.map(row => {
    if (todo === 0 || row.left === 0) return row
    const take = Math.min(row.left, todo)
    todo -= take
    return { ...row, left: row.left - take }
  })
  return { ...save, coins: save.coins - amount, ledger: ledger.filter(row => row.left > 0) }
}

export const levelFor = (clicks: number): number => Math.floor(clicks / CLICKS_PER_LEVEL)

export const coinsPerClick = (level: number): number => 1 + level

export const clicksToNextLevel = (clicks: number): number =>
  CLICKS_PER_LEVEL - (clicks % CLICKS_PER_LEVEL)

/** Semver-ish compare: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(part => parseInt(part, 10) || 0)
  const pb = b.split('.').map(part => parseInt(part, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export const isUpdateRequired = (localVersion: string, minVersion: string): boolean =>
  compareVersions(localVersion, minVersion) < 0

/**
 * Rolls one click's drop: the rarest kinds are tried first, each with its own
 * chance, so chances are independent per kind and the rarest wins a tie.
 */
export function rollDrop(rng: () => number, specials: readonly SpecialBanana[], now: string): Drop | undefined {
  const byRarity = [...specials].sort(
    (x, y) => RARITY_ORDER.indexOf(x.rarity) - RARITY_ORDER.indexOf(y.rarity),
  )
  for (const kind of byRarity) {
    if (rng() < kind.chance) {
      return {
        id: `${kind.id}-${now}-${Math.floor(rng() * 1e6)}`,
        kindId: kind.id,
        name: kind.name,
        glyph: kind.glyph,
        rarity: kind.rarity,
        at: now,
      }
    }
  }
  return undefined
}

export function press(save: Save, drop: Drop | undefined, at: string): Save {
  const clicks = save.clicks + 1
  const earned = earn(save, coinsPerClick(save.level), at)
  return {
    ...earned,
    clicks,
    level: levelFor(clicks),
    inventory: drop ? [...save.inventory, drop].slice(-500) : save.inventory,
    lifetime: { ...earned.lifetime, clicks: earned.lifetime.clicks + 1, drops: earned.lifetime.drops + (drop ? 1 : 0) },
  }
}

export const sellValueOf = (content: Content, kindId: string): number =>
  content.specials.find(kind => kind.id === kindId)?.sellValue ?? 0

export function sellAll(save: Save, content: Content, rarity: Rarity, at: string): { save: Save; sold: number; coins: number } {
  const keep: Drop[] = []
  let coins = 0
  let sold = 0
  for (const drop of save.inventory) {
    if (drop.rarity === rarity) {
      coins += sellValueOf(content, drop.kindId)
      sold += 1
    } else keep.push(drop)
  }
  return { save: earn({ ...save, inventory: keep }, coins, at), sold, coins }
}

export const stockLeft = (save: Save, gift: Gift): number => save.stock[gift.id] ?? gift.stock

export type RedeemCheck = 'ok' | 'no-coins' | 'no-stock' | 'server-only'

export const canRedeem = (save: Save, gift: Gift, price: number, hasServer = true): RedeemCheck => {
  if ((gift.claim.kind === 'pool' || gift.claim.kind === 'gateway') && !hasServer) return 'server-only'
  if (stockLeft(save, gift) === 0) return 'no-stock'
  if (save.coins < price) return 'no-coins'
  return 'ok'
}

export const giftValue = (gift: Gift): string => (gift.usd ? `$${gift.usd}` : gift.name)

/** Takes `price` (oldest coins first) and one unit of stock; the claim text is what the person receives. */
export function redeem(save: Save, gift: Gift, price: number, claim: string, at: string): Save {
  const left = stockLeft(save, gift)
  const paid = spend(save, price)
  return {
    ...paid,
    stock: { ...paid.stock, [gift.id]: left < 0 ? left : left - 1 },
    claims: [...paid.claims, { giftId: gift.id, giftName: gift.name, at, claim }].slice(-200),
  }
}

export function countByRarity(inventory: readonly Drop[]): Record<Rarity, number> {
  const counts: Record<Rarity, number> = { common: 0, rare: 0, epic: 0, legendary: 0 }
  for (const drop of inventory) counts[drop.rarity] += 1
  return counts
}

function parseEconomy(v: unknown): Economy {
  const e = (v ?? {}) as Partial<Economy>
  const num = (x: unknown, d: number, min: number) => (typeof x === 'number' && isFinite(x) && x >= min ? x : d)
  return {
    windowHours: num(e.windowHours, DEFAULT_ECONOMY.windowHours, 1),
    budgetUsd: num(e.budgetUsd, DEFAULT_ECONOMY.budgetUsd, 0),
    unitUsd: num(e.unitUsd, DEFAULT_ECONOMY.unitUsd, 0.01),
    minCoinsPerUsd: num(e.minCoinsPerUsd, DEFAULT_ECONOMY.minCoinsPerUsd, 1),
    fallbackCoinsPerUsd: num(e.fallbackCoinsPerUsd, DEFAULT_ECONOMY.fallbackCoinsPerUsd, 1),
  }
}

const svgOrUndefined = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\s*<svg[\s>]/i.test(v) ? v.slice(0, 131072) : undefined

/** Narrow unknown JSON to Content; throws with a reason when it is not one. */
export function parseContent(json: unknown): Content {
  const c = json as Partial<Content> | null
  if (!c || typeof c !== 'object') throw new Error('content is not an object')
  if (typeof c.version !== 'string') throw new Error('content.version missing')
  if (typeof c.minVersion !== 'string') throw new Error('content.minVersion missing')
  if (!c.sponsor || typeof c.sponsor.name !== 'string') throw new Error('content.sponsor missing')
  if (!Array.isArray(c.gifts)) throw new Error('content.gifts missing')
  if (!Array.isArray(c.specials)) throw new Error('content.specials missing')
  return {
    version: c.version,
    minVersion: c.minVersion,
    sponsor: {
      name: c.sponsor.name,
      tagline: c.sponsor.tagline ?? '',
      banner: Array.isArray(c.sponsor.banner) ? c.sponsor.banner.map(String) : [],
      color: c.sponsor.color ?? 'yellow',
      logo: svgOrUndefined(c.sponsor.logo),
      logoHeight: typeof c.sponsor.logoHeight === 'number' ? Math.max(16, Math.min(400, c.sponsor.logoHeight)) : undefined,
      lines: Array.isArray(c.sponsor.lines) ? c.sponsor.lines.map(String).slice(0, 12) : undefined,
      url: typeof c.sponsor.url === 'string' && /^https:\/\//.test(c.sponsor.url) ? c.sponsor.url : undefined,
      urlLabel: typeof c.sponsor.urlLabel === 'string' ? c.sponsor.urlLabel : undefined,
    },
    banana: {
      name: typeof c.banana?.name === 'string' && c.banana.name.trim() ? c.banana.name.trim().slice(0, 40) : 'Banana',
      svg: svgOrUndefined(c.banana?.svg),
      art: Array.isArray(c.banana?.art) ? c.banana.art.map(String).slice(0, 12) : undefined,
      buttonLabel: typeof c.banana?.buttonLabel === 'string' ? c.banana.buttonLabel.slice(0, 60) : undefined,
    },
    gifts: c.gifts,
    specials: c.specials,
    economy: parseEconomy(c.economy),
    gateway:
      c.gateway && typeof c.gateway.name === 'string'
        ? { name: c.gateway.name, url: typeof c.gateway.url === 'string' ? c.gateway.url : undefined, hint: typeof c.gateway.hint === 'string' ? c.gateway.hint : undefined }
        : undefined,
    notes: typeof c.notes === 'string' ? c.notes : undefined,
  }
}
