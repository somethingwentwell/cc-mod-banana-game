import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Content, Save } from '../types'
import { DEFAULT_CONTENT } from './catalog'
import {
  MOD_VERSION,
  budgetUnits,
  canRedeem,
  coinsPerUsd,
  compareVersions,
  earn,
  emptySave,
  expire,
  isUpdateRequired,
  levelFor,
  nextExpiry,
  normalizeSave,
  parseContent,
  press,
  priceOf,
  redeem,
  rollDrop,
  sellAll,
  spend,
  windowMs,
} from './game'

const PANE_PROPS = {
  title: 'Banana',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

const SESSION = { cwd: '/tmp', surface: 'terminal' as const, isInteractive: true }

type Log = { opened: string[]; closed: string[]; stored: Record<string, unknown> }

/** The engine beneath the plugin: what a session answers and these tests never exercise. */
function stubs(on: On, store: Readonly<Record<string, unknown>> = {}): Log {
  const log: Log = { opened: [], closed: [], stored: {} }
  // An in-memory store that also records every write (mock.store would take store.set).
  const data: Record<string, unknown> = { ...store }
  on('store.get', (_, e) => ({ value: data[e.key] }))
  on('store.set', (_, e) => {
    data[e.key] = e.value
    log.stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete data[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(data) }))
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.open', (_, e) => {
    log.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    log.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('fs.read', () => ({ deny: 'no filesystem in tests' }))
  on('fs.exists', () => ({ value: false }))
  return log
}

const seq = (...values: number[]) => {
  let i = 0
  return () => values[i++] ?? 0.99
}

/** Tests get the manifest defaults (the live server) unless they say otherwise. */
const OFFLINE = { options: { serverUrl: '', contentUrl: '' } }
const CONTENT_OPTS = { options: { contentUrl: 'https://example.test/content.json', serverUrl: '' } }

const okJson = (data: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } })

// ---- pure logic ---------------------------------------------------------------

const T0 = '2026-10-06T00:00:00.000Z'
const ms = (iso: string) => Date.parse(iso)
const ECO = DEFAULT_CONTENT.economy
const TOKENS = DEFAULT_CONTENT.gifts.find(g => g.id === 'llm-tokens')!

test('versions compare numerically and gate the mod', () => {
  expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  expect(compareVersions('0.2.0', '0.10.0') < 0).toBe(true)
  expect(compareVersions('1.0', '0.9.9') > 0).toBe(true)
  expect(isUpdateRequired('0.1.0', '0.1.1')).toBe(true)
  expect(isUpdateRequired('0.1.1', '0.1.0')).toBe(false)
  expect(isUpdateRequired(MOD_VERSION, DEFAULT_CONTENT.minVersion)).toBe(false)
})

test('levels rise every 100 clicks and pay more per click', () => {
  expect(levelFor(0)).toBe(0)
  expect(levelFor(99)).toBe(0)
  expect(levelFor(100)).toBe(1)
  let s = emptySave()
  for (let i = 0; i < 100; i++) s = press(s, undefined, T0)
  expect(s.level).toBe(1)
  expect(s.coins).toBe(100)
  s = press(s, undefined, T0)
  expect(s.coins).toBe(102)
  expect(s.lifetime).toMatchObject({ clicks: 101, coins: 102 })
})

test('drops roll rarest first with independent chances', () => {
  const kinds = DEFAULT_CONTENT.specials
  // legendary, epic, rare, common are tried in that order; the value after a hit salts the id
  expect(rollDrop(seq(0.0001, 0.5), kinds, T0)?.rarity).toBe('legendary')
  expect(rollDrop(seq(0.9, 0.001, 0.5), kinds, T0)?.rarity).toBe('epic')
  expect(rollDrop(seq(0.9, 0.9, 0.01, 0.5), kinds, T0)?.rarity).toBe('rare')
  expect(rollDrop(seq(0.9, 0.9, 0.9, 0.05, 0.5), kinds, T0)?.rarity).toBe('common')
  expect(rollDrop(seq(0.9, 0.9, 0.9, 0.9), kinds, T0)).toBe(undefined)
})

test('selling clears one rarity and pays its value into the ledger', () => {
  const drop = rollDrop(seq(0.9, 0.9, 0.9, 0.05, 0.5), DEFAULT_CONTENT.specials, T0)!
  const s = press(press(emptySave(), drop, T0), { ...drop, id: 'x', rarity: 'rare', kindId: 'rare' }, T0)
  const r = sellAll(s, DEFAULT_CONTENT, 'common', T0)
  expect(r.sold).toBe(1)
  expect(r.coins).toBe(5)
  expect(r.save.inventory).toHaveLength(1)
  expect(r.save.coins).toBe(2 + 5)
  expect(r.save.ledger.reduce((n, row) => n + row.left, 0)).toBe(7)
})

test('the rate is the pool shared over the budget units, never under the floor', () => {
  expect(budgetUnits(ECO)).toBe(10)
  expect(coinsPerUsd(0, ECO)).toBe(ECO.minCoinsPerUsd)
  expect(coinsPerUsd(50000, ECO)).toBe(5000)
  expect(coinsPerUsd(50001, ECO)).toBe(5001)
  expect(priceOf(TOKENS, 5000)).toBe(5000)
  expect(priceOf({ ...TOKENS, usd: 3 }, 5000)).toBe(15000)
  expect(priceOf({ ...TOKENS, usd: undefined, priceCoins: 42 }, 5000)).toBe(42)
})

test('coins and bananas are void after the window; lifetime totals stay', () => {
  const drop = rollDrop(seq(0.9, 0.9, 0.9, 0.05, 0.5), DEFAULT_CONTENT.specials, T0)!
  let s = press(emptySave(), drop, T0)
  s = earn(s, 100, '2026-10-08T00:00:00.000Z')
  expect(s.coins).toBe(101)
  const sixDays = ms(T0) + 6 * 86400000
  expect(expire(s, sixDays, ECO).coins).toBe(101)
  const eightDays = ms(T0) + 8 * 86400000
  const later = expire(s, eightDays, ECO)
  expect(later.coins).toBe(100)
  expect(later.inventory).toHaveLength(0)
  expect(later.lifetime).toMatchObject({ clicks: 1, coins: 101, drops: 1 })
  expect(nextExpiry(s, ECO)).toBe(ms(T0) + windowMs(ECO))
})

test('spending takes the oldest coins first and refuses a short balance', () => {
  let s = earn(earn(emptySave(), 30, T0), 50, '2026-10-02T00:00:00.000Z')
  s = spend(s, 40)
  expect(s.coins).toBe(40)
  expect(s.ledger).toHaveLength(1)
  expect(s.ledger[0]).toMatchObject({ at: '2026-10-02T00:00:00.000Z', left: 40 })
  expect(() => spend(s, 41)).toThrow('need 1 more')
})

test('redeem checks the server, stock and price; a pool gift needs the server', () => {
  const rich: Save = earn(emptySave(), 100000, T0)
  expect(canRedeem(rich, TOKENS, 5000, false)).toBe('server-only')
  expect(canRedeem(rich, TOKENS, 5000, true)).toBe('ok')
  expect(canRedeem({ ...emptySave(), coins: 10 }, TOKENS, 5000, true)).toBe('no-coins')
  let s = rich
  for (let i = 0; i < 10; i++) {
    expect(canRedeem(s, TOKENS, 5000, true)).toBe('ok')
    s = redeem(s, TOKENS, 5000, `code-${i}`, T0)
  }
  expect(canRedeem(s, TOKENS, 5000, true)).toBe('no-stock')
  expect(s.coins).toBe(100000 - 10 * 5000)
  expect(s.claims).toHaveLength(10)
  const shared = { ...TOKENS, id: 'free', stock: -1, claim: { kind: 'code' as const, value: 'X' } }
  for (let i = 0; i < 5; i++) s = redeem(s, shared, 1, 'X', T0)
  expect(canRedeem(s, shared, 1, true)).toBe('ok')
})

test('an old save without a ledger becomes one batch earned now', () => {
  const old = { coins: 77, clicks: 150, level: 1, inventory: [], claims: [], stock: {} }
  const s = normalizeSave(old, T0)
  expect(s.coins).toBe(77)
  expect(s.ledger).toEqual([{ at: T0, coins: 77, left: 77 }])
  expect(s.lifetime).toMatchObject({ clicks: 150, coins: 77 })
  expect(normalizeSave('junk', T0).coins).toBe(0)
})

test('parseContent refuses a document without the required fields and fills the economy', () => {
  expect(() => parseContent({ version: '1' })).toThrow('minVersion')
  expect(() => parseContent(null)).toThrow()
  const ok = parseContent(JSON.parse(JSON.stringify({ ...DEFAULT_CONTENT, economy: undefined })))
  expect(ok.gifts).toHaveLength(DEFAULT_CONTENT.gifts.length)
  expect(ok.economy.windowHours).toBe(168)
})

// ---- the pane -------------------------------------------------------------------

test('clicking the banana earns coins on every surface', OFFLINE, async ($, on) => {
  stubs(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'banana', surface, component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
    const before = (await ui.find({ key: 'coins' }))?.text ?? ''
    const start = parseInt(before.replace(/\D/g, ''), 10) || 0
    await ui.press({ key: 'banana' })
    await ui.press({ key: 'banana' })
    await ui.press({ key: 'banana' })
    expect((await ui.find({ key: 'coins' }))?.text).toContain(`${start + 3} coins`)
    await ui.unmount()
  }
})

test('tabs switch the body and the shop lists the gifts', OFFLINE, async ($, on) => {
  stubs(on)
  const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
  await ui.press({ key: 'tab-shop' })
  expect(await ui.find({ key: 'redeem-llm-tokens' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Rate: \$1 = 1000 coins/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /needs the online server/ })).toBeDefined()
  expect(await ui.find({ key: 'banana' })).toBe(undefined)
  await ui.press({ key: 'tab-bag' })
  expect(await ui.find({ type: 'Text', text: /bag is empty/ })).toBeDefined()
  await ui.press({ key: 'tab-click' })
  expect(await ui.find({ key: 'banana' })).toBeDefined()
  await ui.unmount()
})

test('a shared-code gift from hosted content can be redeemed offline and the claim persists', CONTENT_OPTS, async ($, on) => {
  const rich: Save = earn(emptySave(), 2500, '2026-10-06T00:00:00.000Z')
  const log = stubs(on, { save: rich })
  const hosted: Content = {
    ...DEFAULT_CONTENT,
    gifts: [{ id: 'sticker', name: 'Sticker', sponsor: 'S', usd: 2, stock: -1, claim: { kind: 'code', value: 'STICK-1' } }],
  }
  on('http.fetch', () => okJson(hosted))
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
  await ui.press({ key: 'tab-shop' })
  expect(await ui.find({ type: 'Text', text: /\$2 of Sticker/ })).toBeDefined()
  await ui.press({ key: 'redeem-sticker' })
  expect((await ui.find({ key: 'coins' }))?.text).toContain('500 coins')
  expect(await ui.find({ type: 'Text', text: /STICK-1/ })).toBeDefined()
  const kept = log.stored.save as Save
  expect(kept.coins).toBe(500)
  expect(kept.claims).toHaveLength(1)
  expect(kept.lifetime.coins).toBe(2500)
  await ui.unmount()
})

test('the pane opens when a turn starts and closes when it completes', OFFLINE, async ($, on) => {
  const log = stubs(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(log.opened).toContain('banana')
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(log.closed).toContain('banana')
})

test('a subagent finishing does not close the pane', OFFLINE, async ($, on) => {
  const log = stubs(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'sub', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' })
  expect(log.closed).toHaveLength(0)
})

// ---- the update gate --------------------------------------------------------------

test('content that needs a newer mod locks the pane until updated', CONTENT_OPTS, async ($, on) => {
  stubs(on)
  on('http.fetch', () => okJson({ ...DEFAULT_CONTENT, version: '99', minVersion: '99.0.0' }))
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
  expect(await ui.find({ key: 'update' })).toBeDefined()
  expect(await ui.find({ key: 'banana' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Update required/ })).toBeDefined()
  await ui.unmount()
})

test('fresh content refreshes the sponsor banner and keeps play open', CONTENT_OPTS, async ($, on) => {
  stubs(on)
  const fresh: Content = { ...DEFAULT_CONTENT, version: '2', sponsor: { ...DEFAULT_CONTENT.sponsor, name: 'Acme Fruit' } }
  on('http.fetch', () => okJson(fresh))
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
  expect(await ui.find({ type: 'Text', text: /Acme Fruit/ })).toBeDefined()
  expect(await ui.find({ key: 'banana' })).toBeDefined()
  await ui.unmount()
})

test('an unreachable content URL falls back to the cached copy', CONTENT_OPTS, async ($, on) => {
  const cached: Content = { ...DEFAULT_CONTENT, version: '7', sponsor: { ...DEFAULT_CONTENT.sponsor, name: 'Cached Co' } }
  stubs(on, { content: cached })
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
  expect(await ui.find({ type: 'Text', text: /Cached Co/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /offline/ })).toBeDefined()
  await ui.unmount()
})

test('a gateway gift without a linked login tells the player to register', { options: { serverUrl: 'https://banana.example.test', contentUrl: '' } }, async ($, on) => {
  stubs(on, { save: earn(emptySave(), 9000, '2026-10-06T00:00:00.000Z'), playerId: 'p-2' })
  on('http.fetch', () => okJson({ ok: true }))
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
  await ui.press({ key: 'tab-shop' })
  expect(await ui.find({ type: 'Text', text: /No gateway login linked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /link your gateway login first/ })).toBeDefined()
  await ui.unmount()
})

test('an http registration link is drawn as text, not refused', CONTENT_OPTS, async ($, on) => {
  stubs(on)
  const hosted: Content = { ...DEFAULT_CONTENT, gateway: { name: 'Test gateway', url: 'http://4.194.42.84:3000/register' } }
  on('http.fetch', () => okJson(hosted))
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'banana', surface, component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
    await ui.press({ key: 'tab-shop' })
    expect(await ui.find({ type: 'Text', text: 'http://4.194.42.84:3000/register' })).toBeDefined()
    const links = await ui.findAll({ type: 'Link' })
    expect(links.some(l => String(l.props.href ?? '').startsWith('http://'))).toBe(false)
    await ui.unmount()
  }
})

test('with no settings, a new player talks to the sponsor server', async ($, on) => {
  stubs(on)
  const urls: string[] = []
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    if (e.url.endsWith('/content')) return okJson(DEFAULT_CONTENT)
    if (e.url.endsWith('/rate')) return okJson({ coinsPerUsd: 777, windowCoins: 7770, budgetUnits: 10 })
    return okJson({ ok: true, '\u006clm-tokens': 10 })
  })
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
  await ui.press({ key: 'tab-shop' })
  expect(urls, JSON.stringify(urls)).toContain('https://banana.jevable.ai/game/hello')
  expect(urls, JSON.stringify(urls)).toContain('https://banana.jevable.ai/game/content')
  expect(await ui.find({ type: 'Text', text: /Rate: \$1 = 777 coins/ })).toBeDefined()
  const links = await ui.findAll({ type: 'Link' })
  expect(links.some(l => l.props.href === 'https://banana.jevable.ai/register')).toBe(true)
  await ui.unmount()
})

// ---- the server -------------------------------------------------------------------

test(
  'with a server, clicks are reported as deltas, the rate comes back, and redeem takes the server code',
  { options: { serverUrl: 'https://banana.example.test', contentUrl: '' } },
  async ($, on) => {
    const rich: Save = earn(emptySave(), 6000, '2026-10-06T00:00:00.000Z')
    const log = stubs(on, { save: rich, playerId: 'p-1', name: 'Tester', gateway: 'tester@gw' })
    const calls: { url: string; body: unknown }[] = []
    on('http.fetch', (_, e) => {
      const body = e.init?.body ? JSON.parse(e.init.body) : undefined
      calls.push({ url: e.url, body })
      if (e.url.endsWith('/sync')) return okJson({ rank: 1, totalPlayers: 1, globalClicks: 42, spendable: 6002, rate: { coinsPerUsd: 5000, windowCoins: 50000, budgetUnits: 10 } })
      if (e.url.endsWith('/hello')) return okJson({ ok: true })
      if (e.url.endsWith('/redeem')) return okJson({ claim: 'Topped up $1 (500000 quota) to tester@gw', coins: 1002, price: 5000, stockLeft: 9 })
      if (e.url.endsWith('/stock')) return okJson({ 'llm-tokens': 9 })
      if (e.url.endsWith('/rate')) return okJson({ coinsPerUsd: 5000, windowCoins: 50000, budgetUnits: 10 })
      return { value: { status: 404, ok: false, headers: {}, text: '' } }
    })
    await $.session.start(SESSION)
    const ui = await $.ui.mount({ plugin: 'banana', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'banana' })
    await ui.press({ key: 'banana' })
    await ui.press({ key: 'banana' })
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    const sync = calls.find(c => c.url.endsWith('/sync'))
    expect(sync).toBeDefined()
    expect(sync!.body, JSON.stringify(calls)).toMatchObject({ playerId: 'p-1', name: 'Tester', gateway: 'tester@gw', clicks: 2, coins: 2 })
    expect(calls.find(c => c.url.endsWith('/hello'))?.body).toMatchObject({ playerId: 'p-1' })
    expect(log.stored.pending).toMatchObject({ clicks: 0, coins: 0 })

    await ui.press({ key: 'tab-shop' })
    expect(await ui.find({ type: 'Text', text: /Rate: \$1 = 5000 coins/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50000 coins earned by everyone/ })).toBeDefined()
    await ui.press({ key: 'redeem-llm-tokens' })
    const redeemCall = calls.find(c => c.url.endsWith('/redeem'))
    expect(redeemCall!.body).toMatchObject({ playerId: 'p-1', giftId: 'llm-tokens', gateway: 'tester@gw' })
    expect(await ui.find({ type: 'Text', text: /Topped up \$1/ })).toBeDefined()
    expect((await ui.find({ key: 'coins' }))?.text).toContain('1002 coins')
    await ui.unmount()
  },
)
