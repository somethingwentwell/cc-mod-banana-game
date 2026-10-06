// node --test test/   (Node 24+). Runs the server in-process against the mock gateway.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-test-'))
process.env.DATA_DIR = dataDir
process.env.ADMIN_TOKEN = 'test-admin'
process.env.GATEWAY_KIND = 'newapi'
process.env.GATEWAY_URL = 'http://127.0.0.1:3998'
process.env.GATEWAY_TOKEN = 'gw-admin-token'
process.env.GATEWAY_QUOTA_PER_USD = '500000'

const { handle } = await import('../src/server.js')
const gw = await import('./mock-gateway.js')

let base
const srv = http.createServer(handle)
before(async () => {
  await new Promise(r => gw.server.listen(3998, r))
  await new Promise(r => srv.listen(0, r))
  base = `http://127.0.0.1:${srv.address().port}`
})
after(() => {
  srv.close()
  gw.server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const call = async (method, p, body, admin = false) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': 'test-admin' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const CONTENT = JSON.parse(fs.readFileSync(new URL('../../content.json', import.meta.url), 'utf8'))
const ALICE = 'player-alice-0000-0001'
const BOB = 'player-bob-00000-0002'

test('admin uploads content; players are counted by hello', async () => {
  assert.equal((await call('PUT', '/content', CONTENT)).status, 403)
  assert.deepEqual((await call('PUT', '/content', CONTENT, true)).body, { ok: true, gifts: 1 })
  await call('POST', '/hello', { playerId: ALICE, modVersion: '0.1.0', surface: 'desktop' })
  await call('POST', '/hello', { playerId: ALICE, modVersion: '0.1.0', surface: 'desktop' })
  await call('POST', '/hello', { playerId: 'player-lurker-000-0009', modVersion: '0.1.0', surface: 'terminal' })
  const { body: stats } = await call('GET', '/stats', undefined, true)
  assert.equal(stats.installs, 2)
  assert.equal(stats.sessions, 3)
  assert.equal(stats.playersWhoClicked, 0)
})

test('the rate is the weekly pool over the budget units, floored', async () => {
  assert.equal((await call('GET', '/rate')).body.coinsPerUsd, 500)
  const a = await call('POST', '/sync', { playerId: ALICE, name: 'Alice', gateway: 'alice', clicks: 600, coins: 30000, drops: 90 })
  assert.equal(a.body.spendable, 30000)
  assert.equal(a.body.rate.coinsPerUsd, 3000)
  const b = await call('POST', '/sync', { playerId: BOB, name: 'Bob', clicks: 600, coins: 20000, drops: 90 })
  assert.equal(b.body.rate.coinsPerUsd, 5000)
  assert.equal(b.body.rate.windowCoins, 50000)
})

test('redeem tops up the linked gateway login and spends the oldest coins', async () => {
  const before = gw.users.find(u => u.username === 'alice').quota
  const { body } = await call('POST', '/redeem', { playerId: ALICE, giftId: 'llm-tokens' })
  assert.equal(body.price, 5000)
  assert.equal(body.coins, 25000)
  assert.match(body.claim, /Topped up \$1 \(500000 quota\) to alice/)
  assert.equal(gw.users.find(u => u.username === 'alice').quota, before + 500000)
  assert.equal(body.stockLeft, 9)
})

test('redeem refuses without a link, and refunds when the login is unknown on the gateway', async () => {
  const noLink = await call('POST', '/redeem', { playerId: BOB, giftId: 'llm-tokens' })
  assert.match(noLink.body.error, /link your gateway login/)
  const unknown = await call('POST', '/redeem', { playerId: BOB, giftId: 'llm-tokens', gateway: 'nobody' })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /coins returned/)
  const { body } = await call('POST', '/sync', { playerId: BOB, clicks: 0, coins: 0, drops: 0 })
  assert.equal(body.spendable, 20000)
  assert.equal(body.rate.windowCoins, 50000, 'a refund does not inflate the pool')
  const { body: claims } = await call('GET', '/claims', undefined, true)
  assert.equal(claims.claims.find(c => c.playerId === BOB).status, 'failed')
})

test('the budget runs out: stock hits zero and the gift is sold out', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/redeem', { playerId: BOB, giftId: 'llm-tokens', gateway: 'bob' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  }
  const broke = await call('POST', '/redeem', { playerId: BOB, giftId: 'llm-tokens' })
  assert.match(broke.body.error, /need 5000 more coins/)
  await call('PUT', '/stock', { giftId: 'llm-tokens', left: 0 }, true)
  const out = await call('POST', '/redeem', { playerId: ALICE, giftId: 'llm-tokens' })
  assert.equal(out.body.error, 'sold out')
  const { body: stats } = await call('GET', '/stats', undefined, true)
  assert.equal(stats.payoutsPaid, 5)
  assert.equal(stats.payoutsFailed, 1)
  assert.equal(stats.playersLinked, 2)
})

test('the leaderboard is lifetime, not spendable', async () => {
  const { body } = await call('GET', '/leaderboard')
  assert.equal(body.top[0].name, 'Alice')
  assert.equal(body.top[0].coins, 30000)
})

test('sync caps implausible reports', async () => {
  const { body } = await call('POST', '/sync', { playerId: 'player-cheat-000-0003', clicks: 99999, coins: 99999999, drops: 99999 })
  assert.equal(body.player.clicks, 600)
  assert.ok(body.player.coins <= 600 * 1 + 91 * 1000)
})
