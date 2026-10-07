// Banana: a clicker pane that opens while Claude thinks.
//
// Content (sponsor banner, gifts, special bananas, minimum version) comes
// from a hosted content.json; a Worker adds the leaderboard, real stock and
// one-time codes. Both are optional: with no URLs set the game is single
// player on bundled content.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, UiPressArgument } from 'claude-code'

import type { Content, Leaderboard, Pending, Player, Rarity, Rate, Save, Update, View } from '../types'
import { DEFAULT_CONTENT } from './catalog'
import {
  MOD_VERSION,
  RARITY_COLOR,
  RARITY_ORDER,
  budgetUnits,
  canRedeem,
  clicksToNextLevel,
  coinsPerClick,
  coinsPerUsd,
  countByRarity,
  emptySave,
  expire,
  isUpdateRequired,
  nextExpiry,
  normalizeSave,
  parseContent,
  press,
  priceOf,
  redeem,
  rollDrop,
  sellAll,
  sellValueOf,
  stockLeft,
} from './game'

const PANE = 'banana'
const TITLE = '🍌 Banana'
const CONTENT_TTL_MS = 10 * 60 * 1000
const SYNC_EVERY_MS = 60 * 1000

const BANANA_ART = ['      _', '     //', '    //', '   ((', '    \\\\__', '     \\__)']

const BANANA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160">
  <title>banana</title>
  <path d="M30 22 C 18 72, 52 130, 118 142 C 134 145, 144 136, 138 126 C 92 124, 54 88, 48 30 C 46 18, 34 14, 30 22 Z" fill="#F7C727" stroke="#B8860B" stroke-width="4" stroke-linejoin="round"/>
  <path d="M48 34 C 56 86, 90 120, 130 130" fill="none" stroke="#FFE98A" stroke-width="6" stroke-linecap="round" opacity="0.9"/>
  <path d="M30 20 l-6 -10 l12 3 z" fill="#5B3A1A"/>
  <path d="M136 132 l10 6 l-5 7 z" fill="#5B3A1A"/>
  <ellipse cx="112" cy="134" rx="6" ry="3" fill="#8B6914" opacity="0.5"/>
</svg>`

const noPending = (): Pending => ({ clicks: 0, coins: 0, drops: 0 })
const noBoard = (): Leaderboard => ({ top: [], globalClicks: 0, totalPlayers: 0 })

const save = atom({ plugin: 'banana', key: 'save' } as const, emptySave())
const view = atom({ plugin: 'banana', key: 'view' } as const, 'click')
const isThinking = atom({ plugin: 'banana', key: 'isThinking' } as const, false)
const lastEvent = atom({ plugin: 'banana', key: 'lastEvent' } as const, '')
const content = atom({ plugin: 'banana', key: 'content' } as const, DEFAULT_CONTENT)
const gate = atom({ plugin: 'banana', key: 'update' } as const, {
  status: 'unchecked',
  localVersion: MOD_VERSION,
})
const pending = atom({ plugin: 'banana', key: 'pending' } as const, noPending())
const rate = atom({ plugin: 'banana', key: 'rate' } as const, {
  coinsPerUsd: DEFAULT_CONTENT.economy.fallbackCoinsPerUsd,
  windowCoins: 0,
  budgetUnits: budgetUnits(DEFAULT_CONTENT.economy),
  source: 'fallback',
})
const player = atom({ plugin: 'banana', key: 'player' } as const, { id: '', name: '' })
const board = atom({ plugin: 'banana', key: 'board' } as const, noBoard())
const serverStock = atom({ plugin: 'banana', key: 'serverStock' } as const, {})

type Options = { contentUrl: string; serverUrl: string }

let surfaceName = 'unknown'

const now = () => new Date().toISOString()
const pct = (chance: number) => `${Math.round(chance * 10000) / 100}%`
const bagWorth = (s: Save, c: Content) => s.inventory.reduce((sum, d) => sum + sellValueOf(c, d.kindId), 0)
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))
/**
 * A `Link` takes only https (or http://localhost) and refuses the whole tree
 * otherwise, so any other address from the content is shown as plain text.
 */
const isLinkable = (href: string) => /^https:\/\//i.test(href) || /^http:\/\/localhost(:\d+)?(\/|$)/i.test(href)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function linkOrText(Link: any, Text: any, href: string, label: string) {
  return isLinkable(href) ? (
    <Link href={href} label={label} />
  ) : (
    <Text>
      <Text>{`${label} `}</Text>
      <Text underline color="cyan">{href}</Text>
    </Text>
  )
}

const days = (ms: number) => {
  const d = ms / 86400000
  return d >= 1 ? `${Math.floor(d)}d` : `${Math.max(1, Math.floor(ms / 3600000))}h`
}

export const register: Register = (on, options) => {
  const opts: Options = {
    contentUrl: String(options.contentUrl ?? '').trim().replace(/\/$/, ''),
    serverUrl: String(options.serverUrl ?? '').trim().replace(/\/$/, ''),
  }

  on('session.start', async ($, e, next) => {
    surfaceName = e.surface ?? 'unknown'
    await $.command.register({
      name: 'banana',
      description: 'Open the Banana clicker pane; "/banana name <text>" sets your leaderboard name; "/banana link <gateway login>" says where tokens are paid out',
      argumentHint: '[name <text> | link <gateway login>]',
    })
    const kept = await $.store.get('save')
    if (kept) await update($, save, () => normalizeSave(kept, now()))
    const keptPending = await $.store.get('pending')
    if (keptPending && typeof keptPending === 'object') {
      await update($, pending, () => keptPending as Pending)
    }
    await ensurePlayer($)
    void hello($, opts)
    void refreshContent($, opts)
    $.clock.every(SYNC_EVERY_MS, () => void tick($, opts))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, isThinking, () => true)
    void openPane($, false)
    void refreshContentIfStale($, opts)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isThinking, () => false)
      await $.ui.close({ id: PANE }).catch(() => undefined)
      // Report this turn's clicks; a slow server never holds the answer for more than a moment.
      await Promise.race([sync($, opts), $.clock.sleep(2000)])
    }
    return next(e)
  })

  on('command.run', { command: 'banana' }, async ($, e) => {
    const link = /^(?:link|login)\s+(.+)$/.exec(e.args.trim())
    if (link) {
      const gateway = (link[1] ?? '').trim().slice(0, 64)
      await update($, player, p => ({ ...p, gateway }))
      await $.store.set('gateway', gateway)
      void sync($, opts)
      return { text: `Banana: tokens will be paid out to your gateway login "${gateway}".` }
    }
    const match = /^name\s+(.+)$/.exec(e.args.trim())
    if (match) {
      const name = (match[1] ?? '').trim().slice(0, 24)
      await update($, player, p => ({ ...p, name }))
      await $.store.set('name', name)
      void sync($, opts)
      return { text: `Banana: your name is now "${name}".` }
    }
    await openPane($, true)
    return { text: 'Banana pane opened. Click the banana while Claude thinks!' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const [raw, v, thinking, last, c, u, me, b, stock, r] = await Promise.all([
      read($, save),
      read($, view),
      read($, isThinking),
      read($, lastEvent),
      read($, content),
      read($, gate),
      read($, player),
      read($, board),
      read($, serverStock),
      read($, rate),
    ])
    const nowMs = Date.now()
    const s = expire(raw, nowMs, c.economy)
    const expiry = nextExpiry(s, c.economy)
    const close = () => void $.ui.close({ id: PANE })

    if (u.status === 'required') {
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          <Text color="red" bold>
            Update required
          </Text>
          <Text>{u.message ?? 'This content needs a newer banana mod.'}</Text>
          <Text dimColor>{`Content ${u.contentVersion ?? '?'} needs mod ${u.minVersion ?? '?'}; you run ${u.localVersion}.`}</Text>
          <Box gap={1}>
            <Button key="update" variant="primary" hotkey="u" autoFocus onPress={() => void runUpdate($)}>
              Update now
            </Button>
            <Button key="recheck" hotkey="r" onPress={() => void refreshContent($, opts)}>
              Check again
            </Button>
            <Button key="close" role="dismiss" onPress={close}>
              Close
            </Button>
          </Box>
          <Text dimColor>{`Update now runs git pull in ${$.plugin.root}. Not a git checkout? Replace that folder with the new release and restart.`}</Text>
          {last ? <Text color="yellow">{last}</Text> : null}
        </Box>
      )
    }

    const tab = (id: View, label: string, hotkey: string) => (
      <Button key={`tab-${id}`} hotkey={hotkey} plain dimColor={v !== id} onPress={() => void showTab($, opts, id)}>
        {v === id ? `[${label}]` : label}
      </Button>
    )

    let body
    if (v === 'click') {
      body = (
        <Box flexDirection="column" alignItems="center" gap={1}>
          <Text color={c.sponsor.color} bold>
            {c.banana.name}
          </Text>
          {bananaArt($, e, c)}
          <Button key="banana" hotkey="1" variant="primary" autoFocus onPress={() => void pressBanana($)}>
            {c.banana.buttonLabel ?? '🍌 CLICK THE BANANA 🍌'}
          </Button>
          <Text dimColor>{`${s.clicks} clicks · +${coinsPerClick(s.level)} per click · ${clicksToNextLevel(s.clicks)} to Lv ${s.level + 1}`}</Text>
          {last ? <Text color="green">{last}</Text> : null}
        </Box>
      )
    } else if (v === 'bag') {
      const counts = countByRarity(s.inventory)
      body = (
        <Box flexDirection="column" gap={0}>
          <Text dimColor>{`Each banana sells for coins; coins buy LLM tokens in the Shop. Bag worth: ${bagWorth(s, c)} coins. Bananas are void ${c.economy.windowHours / 24} days after they drop.`}</Text>
          {RARITY_ORDER.map(rarity => {
            const kinds = c.specials.filter(k => k.rarity === rarity)
            const owned = s.inventory.filter(d => d.rarity === rarity)
            const worth = owned.reduce((sum, d) => sum + sellValueOf(c, d.kindId), 0)
            const names = kinds.map(k => `${k.glyph} ${k.name} = ${k.sellValue}c, ${pct(k.chance)} per click`).join(' · ') || 'none defined'
            return (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={RARITY_COLOR[rarity]} bold>
                    {`${rarity.padEnd(9)} ×${counts[rarity]}`}
                  </Text>
                  <Text>{counts[rarity] > 0 ? `worth ${worth}c` : ''}</Text>
                  {counts[rarity] > 0 ? (
                    <Button key={`sell-${rarity}`} onPress={() => void sellRarity($, rarity)}>
                      {`Sell all for ${worth}c`}
                    </Button>
                  ) : null}
                </Box>
                <Text dimColor>{`  ${names}`}</Text>
              </Box>
            )
          })}
          {s.inventory.length === 0 ? <Text dimColor>Your bag is empty. Bananas drop while you click.</Text> : null}
        </Box>
      )
    } else if (v === 'shop') {
      const lastClaim = s.claims[s.claims.length - 1]
      const unit = `$${c.economy.unitUsd}`
      body = (
        <Box flexDirection="column" gap={0}>
          <Text>
            <Text bold>{`Rate: ${unit} = ${r.coinsPerUsd} coins`}</Text>
            <Text dimColor>
              {r.source === 'server'
                ? `  (${r.windowCoins} coins earned by everyone in the last ${c.economy.windowHours / 24} days ÷ ${r.budgetUnits} units of $${c.economy.budgetUsd})`
                : '  (single-player fallback rate; set banana.serverUrl for the live pool rate)'}
            </Text>
          </Text>
          <Text dimColor>{`You have ${s.coins} coins${bagWorth(s, c) > 0 ? ` + ${bagWorth(s, c)}c of bananas in the Bag` : ''}${expiry ? ` · oldest void in ${days(expiry - nowMs)}` : ''}`}</Text>
          {me.gateway ? (
            <Text dimColor>{`Tokens are paid out to your ${c.gateway?.name ?? 'gateway'} login "${me.gateway}" (change: /banana link <username>)`}</Text>
          ) : (
            <Box flexDirection="column">
              <Text color="yellow">{`No gateway login linked. ${c.gateway?.hint ?? 'Register on the sponsor gateway, then run /banana link <your username>.'}`}</Text>
              {c.gateway?.url ? linkOrText(Link, Text, c.gateway.url, `Register on ${c.gateway.name}`) : null}
            </Box>
          )}
          {c.gifts.map((gift, i) => {
            const left = (opts.serverUrl ? stock[gift.id] : undefined) ?? stockLeft(s, gift)
            const price = priceOf(gift, r.coinsPerUsd)
            const check = canRedeem(s, gift, price, !!opts.serverUrl)
            const why = left === 0 ? 'no-stock' : check === 'server-only' ? check : gift.claim.kind === 'gateway' && !me.gateway ? 'no-link' : check
            const value = gift.usd !== undefined ? `$${gift.usd}` : `${price}c`
            const stockText = left < 0 ? 'unlimited' : `${left} × ${value} left`
            const status =
              why === 'no-stock' ? 'sold out'
              : why === 'no-link' ? 'link your gateway login first'
              : why === 'server-only' ? 'needs the online server'
              : why === 'no-coins' ? `need ${price - s.coins} more coins`
              : 'affordable'
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box gap={1}>
                  <Text bold color={c.sponsor.color}>{`${value} of ${gift.name}`}</Text>
                  <Text>{`= ${price} coins`}</Text>
                  <Button key={`redeem-${gift.id}`} hotkey={i < 9 ? String(i + 1) : undefined} dimColor={why !== 'ok'} onPress={() => void redeemGift($, opts, gift.id)}>
                    {why === 'no-stock' ? 'Sold out' : `Redeem ${value} for ${price}c`}
                  </Button>
                </Box>
                <Text dimColor>{`${gift.description ?? ''}${gift.description ? ' · ' : ''}by ${gift.sponsor} · ${stockText} · ${status}`}</Text>
              </Box>
            )
          })}
          {lastClaim ? (
            <Box gap={1} marginTop={1}>
              <Text color="green">{`🎁 ${lastClaim.giftName}: ${lastClaim.claim}`}</Text>
              <Button key="copy" onPress={(p: UiPressArgument) => void $.ui.copy({ text: lastClaim.claim, surface: p.surface })}>
                Copy
              </Button>
            </Box>
          ) : null}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column" gap={0}>
          {!opts.serverUrl ? (
            <Text dimColor>Single-player mode. Set banana.serverUrl in config to join the leaderboard.</Text>
          ) : b.error ? (
            <Text color="red">{`Leaderboard unavailable: ${b.error}`}</Text>
          ) : (
            <Box flexDirection="column">
              <Text dimColor>{`${b.globalClicks} bananas clicked worldwide by ${b.totalPlayers} players${b.rank ? ` · you are #${b.rank}` : ''}`}</Text>
              {b.top.map((row, i) => (
                <Text color={row.name === me.name && me.name ? 'yellow' : undefined}>
                  {`${String(i + 1).padStart(2)}. ${(row.name || 'anonymous').padEnd(24)} ${row.coins}c  ${row.clicks} clicks`}
                </Text>
              ))}
              {b.top.length === 0 ? <Text dimColor>No players yet.</Text> : null}
            </Box>
          )}
          <Text dimColor>{`You: ${me.name || 'anonymous'} · /banana name <text> to change`}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          {sponsorArt($, e, c)}
          <Text>
            <Text bold color={c.sponsor.color}>{c.sponsor.name}</Text>
            <Text dimColor>{` · ${c.sponsor.tagline}`}</Text>
          </Text>
          {(c.sponsor.lines ?? []).map(line => (
            <Text dimColor>{line}</Text>
          ))}
          {c.sponsor.url ? linkOrText(Link, Text, c.sponsor.url, c.sponsor.urlLabel ?? c.sponsor.url) : null}
        </Box>
        <Box flexDirection="column">
          <Box gap={2}>
            <Box key="coins">
              <Text bold color="yellow">{`🪙 ${s.coins} coins`}</Text>
            </Box>
            <Text>{`Lv ${s.level}`}</Text>
            <Text color={thinking ? 'cyan' : undefined} dimColor={!thinking}>
              {thinking ? 'Claude is thinking… click!' : 'Claude is idle'}
            </Text>
          </Box>
          <Text dimColor>{`void in ${expiry ? days(expiry - nowMs) : '—'} · lifetime ${s.lifetime.coins} coins, ${s.lifetime.clicks} clicks`}</Text>
        </Box>
        <Box gap={1}>
          {tab('click', 'Click', 'c')}
          {tab('bag', 'Bag', 'b')}
          {tab('shop', 'Shop', 's')}
          {tab('top', 'Top', 't')}
          <Button key="close" role="dismiss" onPress={close}>
            Close
          </Button>
        </Box>
        {body}
        {u.status === 'offline' ? <Text dimColor>{`offline: using cached content (${u.message ?? ''})`}</Text> : null}
        {u.status === 'checking' ? <Text dimColor>checking for content updates…</Text> : null}
      </Box>
    )
  })
}

// ---- pane ------------------------------------------------------------------

/** The banana: vector on the surfaces that draw Svg, ASCII on the terminal. */
function bananaArt($: EngineInterface, e: RenderInput<'Pane'>, c: Content) {
  if (e.surface === 'terminal') {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {(c.banana.art ?? BANANA_ART).map(line => (
          <Text color="yellow">{line}</Text>
        ))}
      </Box>
    )
  }
  const { Svg } = $.ui.resolve(e)
  return <Svg source={c.banana.svg ?? BANANA_SVG} alt={c.banana.name} width={140} height={140} />
}

/** The sponsor's logo when the content carries SVG and the surface draws it; else the ASCII banner. */
function sponsorArt($: EngineInterface, e: RenderInput<'Pane'>, c: Content) {
  if (e.surface !== 'terminal' && c.sponsor.logo) {
    const { Svg } = $.ui.resolve(e)
    return <Svg source={c.sponsor.logo} alt={`${c.sponsor.name} logo`} height={c.sponsor.logoHeight ?? 64} />
  }
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {c.sponsor.banner.map(line => (
        <Text color={c.sponsor.color}>{line}</Text>
      ))}
    </Box>
  )
}

async function openPane($: EngineInterface, asked: boolean) {
  const c = await read($, content)
  const title = c.banana.name === 'Banana' ? TITLE : `🍌 ${c.banana.name}`
  const opened = await $.ui.open(asked ? { id: PANE, title, focus: true } : { id: PANE, title })
  if (!opened.isPlaced && asked) $.ui.toast('Banana: widen the terminal or go fullscreen to see the pane')
}

async function showTab($: EngineInterface, opts: Options, id: View) {
  await update($, view, () => id)
  if (id === 'top' && opts.serverUrl) void refreshBoard($, opts)
  if (id === 'shop' && opts.serverUrl) void refreshStock($, opts)
}

// ---- play ------------------------------------------------------------------

async function commit($: EngineInterface, fn: (s: Save) => Save): Promise<Save> {
  const next = await update($, save, fn)
  await $.store.set('save', next)
  return next
}

async function addPending($: EngineInterface, delta: Pending) {
  const next = await update($, pending, p => ({
    clicks: p.clicks + delta.clicks,
    coins: p.coins + delta.coins,
    drops: p.drops + delta.drops,
  }))
  await $.store.set('pending', next)
}

async function pressBanana($: EngineInterface) {
  const u = await read($, gate)
  if (u.status === 'required') {
    $.ui.toast('Banana: update the mod before playing')
    return
  }
  const c = await read($, content)
  const at = now()
  const drop = rollDrop(Math.random, c.specials, at)
  const before = await read($, save)
  await commit($, s => press(expire(s, Date.now(), c.economy), drop, at))
  await addPending($, { clicks: 1, coins: coinsPerClick(before.level), drops: drop ? 1 : 0 })
  if (drop) {
    const line = `${drop.glyph} ${drop.name} dropped! (${drop.rarity})`
    await update($, lastEvent, () => line)
    $.ui.toast(line)
  }
}

async function sellRarity($: EngineInterface, rarity: Rarity) {
  const c = await read($, content)
  let sold = 0
  let coins = 0
  const at = now()
  await commit($, s => {
    const r = sellAll(expire(s, Date.now(), c.economy), c, rarity, at)
    sold = r.sold
    coins = r.coins
    return r.save
  })
  if (sold > 0) {
    await addPending($, { clicks: 0, coins, drops: 0 })
    await update($, lastEvent, () => `Sold ${sold} ${rarity} banana${sold === 1 ? '' : 's'} for ${coins} coins`)
  }
}

async function redeemGift($: EngineInterface, opts: Options, giftId: string) {
  const u = await read($, gate)
  if (u.status === 'required') {
    $.ui.toast('Banana: update the mod before redeeming')
    return
  }
  const [raw, c, r] = await Promise.all([read($, save), read($, content), read($, rate)])
  const s = expire(raw, Date.now(), c.economy)
  const gift = c.gifts.find(g => g.id === giftId)
  if (!gift) return
  let price = priceOf(gift, r.coinsPerUsd)
  const why = canRedeem(s, gift, price, !!opts.serverUrl)
  if (why === 'server-only') {
    $.ui.toast(`Banana: ${gift.name} is paid out by the sponsor server; set banana.serverUrl`)
    return
  }
  if (why === 'no-coins') {
    $.ui.toast(`Banana: need ${price - s.coins} more coins for ${gift.name}`)
    return
  }
  if (why === 'no-stock') {
    $.ui.toast(`Banana: ${gift.name} is sold out`)
    return
  }
  const me0 = await read($, player)
  if (gift.claim.kind === 'gateway' && !me0.gateway) {
    $.ui.toast('Banana: link your gateway login first: /banana link <username>')
    await update($, lastEvent, () => 'Tokens are paid to your gateway account. Register on the sponsor gateway, then run /banana link <your username>.')
    return
  }
  const at = now()
  let claim = gift.claim.value ?? ''
  let serverCoins: number | undefined
  if (opts.serverUrl) {
    await sync($, opts)
    const me = await read($, player)
    try {
      const res = await postJson($, `${opts.serverUrl}/redeem`, { playerId: me.id, giftId, gateway: me.gateway, modVersion: u.localVersion })
      const body = res as { claim?: string; coins?: number; price?: number; stockLeft?: number; error?: string }
      if (body.error || typeof body.claim !== 'string') throw new Error(body.error ?? 'no claim in response')
      claim = body.claim
      serverCoins = body.coins
      if (typeof body.price === 'number') price = body.price
      if (typeof body.stockLeft === 'number') {
        await update($, serverStock, st => ({ ...st, [giftId]: body.stockLeft as number }))
      }
    } catch (err) {
      $.ui.toast(`Banana: sponsor refused: ${reason(err)}`)
      return
    }
  }
  await commit($, s2 => {
    const live = expire(s2, Date.now(), c.economy)
    // In server mode the server already took the coins from its ledger; mirror it locally as far as the local ledger allows.
    const localPrice = Math.min(price, live.coins)
    const next = canRedeem(live, gift, localPrice, !!opts.serverUrl) === 'ok' ? redeem(live, gift, localPrice, claim, at) : live
    return serverCoins === undefined ? next : { ...next, coins: Math.min(next.coins, serverCoins) }
  })
  await update($, lastEvent, () => `Redeemed ${gift.name}: ${claim}`)
  $.ui.toast(`🎁 ${gift.name}: ${claim}`, { timeoutMs: 10000 })
}

// ---- content and the update gate --------------------------------------------

async function readLocalVersion($: EngineInterface): Promise<string> {
  try {
    const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    const v = (JSON.parse(text) as { version?: unknown }).version
    if (typeof v === 'string') return v
  } catch {
    // no manifest readable (tests): the constant stands
  }
  return MOD_VERSION
}

function gateFor(localVersion: string, c: Content, fallback: Update['status'], message?: string): Update {
  const required = isUpdateRequired(localVersion, c.minVersion)
  return {
    status: required ? 'required' : fallback,
    localVersion,
    minVersion: c.minVersion,
    contentVersion: c.version,
    checkedAt: now(),
    message: required ? `Mod ${localVersion} is too old for content ${c.version} (needs ${c.minVersion}).` : message,
  }
}

async function applyFallbackRate($: EngineInterface, opts: Options) {
  if (opts.serverUrl) return
  const c = await read($, content)
  await update($, rate, (): Rate => ({
    coinsPerUsd: coinsPerUsd(0, c.economy) > c.economy.fallbackCoinsPerUsd ? coinsPerUsd(0, c.economy) : c.economy.fallbackCoinsPerUsd,
    windowCoins: 0,
    budgetUnits: budgetUnits(c.economy),
    source: 'fallback',
    updatedAt: now(),
  }))
}

async function refreshContent($: EngineInterface, opts: Options) {
  const localVersion = await readLocalVersion($)
  if (!opts.contentUrl) {
    await update($, gate, (): Update => ({ status: 'ok', localVersion, checkedAt: now() }))
    await applyFallbackRate($, opts)
    return
  }
  const before = await read($, gate)
  await update($, gate, (u): Update => ({ ...u, status: 'checking', localVersion }))
  try {
    const res = await $.http.fetch(opts.contentUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const fresh = parseContent(JSON.parse(res.text))
    await update($, content, () => fresh)
    await $.store.set('content', fresh)
    const next = gateFor(localVersion, fresh, 'ok')
    await update($, gate, () => next)
    await applyFallbackRate($, opts)
    if (next.status === 'required' && before.status !== 'required') {
      $.ui.toast(`Banana: update required (${localVersion} → ${fresh.minVersion}). Open /banana.`, { timeoutMs: 8000 })
    }
  } catch (err) {
    let cached: Content | undefined
    try {
      const kept = await $.store.get('content')
      if (kept) cached = parseContent(kept)
    } catch {
      cached = undefined
    }
    if (cached) await update($, content, () => cached as Content)
    const basis = cached ?? (await read($, content))
    await update($, gate, () => gateFor(localVersion, basis, 'offline', reason(err)))
  }
}

async function refreshContentIfStale($: EngineInterface, opts: Options) {
  if (!opts.contentUrl) return
  const u = await read($, gate)
  const age = u.checkedAt ? Date.now() - Date.parse(u.checkedAt) : Infinity
  if (u.status !== 'checking' && age > CONTENT_TTL_MS) await refreshContent($, opts)
}

async function runUpdate($: EngineInterface) {
  const root = $.plugin.root
  const isGit = await $.fs.exists(`${root}/.git`).catch(() => false)
  if (!isGit) {
    await update($, lastEvent, () => 'This copy is not a git checkout: replace the mod folder with the new release, then restart Claude Code.')
    return
  }
  await update($, lastEvent, () => 'Running git pull…')
  try {
    const r = await $.process.run(['git', '-C', root, 'pull', '--ff-only'], { timeoutMs: 60000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git exited ${r.exitCode}`)
    await update($, lastEvent, () => 'Updated. The mod reloads by itself; if this screen stays, restart Claude Code.')
    $.ui.toast('Banana updated')
  } catch (err) {
    await update($, lastEvent, () => `Update failed: ${reason(err)}`)
    $.ui.toast(`Banana update failed: ${reason(err)}`)
  }
}

// ---- server ----------------------------------------------------------------

async function ensurePlayer($: EngineInterface) {
  let id = await $.store.get('playerId')
  if (typeof id !== 'string' || !id) {
    id = crypto.randomUUID()
    await $.store.set('playerId', id)
  }
  const name = await $.store.get('name')
  const gateway = await $.store.get('gateway')
  const me: Player = { id: id as string, name: typeof name === 'string' ? name : '', gateway: typeof gateway === 'string' && gateway ? gateway : undefined }
  await update($, player, () => me)
}

async function postJson($: EngineInterface, url: string, body: unknown): Promise<unknown> {
  const res = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: unknown = {}
  try {
    parsed = res.text ? JSON.parse(res.text) : {}
  } catch {
    parsed = {}
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string }).error
    throw new Error(msg ?? `HTTP ${res.status}`)
  }
  return parsed
}

/** One beacon per session so the sponsor can count installs and players; nothing but the id, version and surface. */
async function hello($: EngineInterface, opts: Options) {
  if (!opts.serverUrl) return
  try {
    const [me, u] = await Promise.all([read($, player), read($, gate)])
    if (!me.id) return
    await postJson($, `${opts.serverUrl}/hello`, { playerId: me.id, modVersion: u.localVersion, surface: surfaceName })
  } catch {
    // counting is best effort
  }
}

/** Reports pending deltas; on failure they stay pending. */
async function sync($: EngineInterface, opts: Options) {
  if (!opts.serverUrl) return
  const [delta, me, u] = await Promise.all([read($, pending), read($, player), read($, gate)])
  if (!me.id) return
  if (delta.clicks === 0 && delta.coins === 0 && delta.drops === 0 && !me.name && !me.gateway) return
  try {
    const res = (await postJson($, `${opts.serverUrl}/sync`, {
      playerId: me.id,
      name: me.name || undefined,
      gateway: me.gateway,
      clicks: delta.clicks,
      coins: delta.coins,
      drops: delta.drops,
      modVersion: u.localVersion,
    })) as { rank?: number; totalPlayers?: number; globalClicks?: number; rate?: Partial<Rate> }
    if (res.rate && typeof res.rate.coinsPerUsd === 'number') {
      const r = res.rate
      await update($, rate, (): Rate => ({
        coinsPerUsd: r.coinsPerUsd as number,
        windowCoins: r.windowCoins ?? 0,
        budgetUnits: r.budgetUnits ?? 1,
        source: 'server',
        updatedAt: now(),
      }))
    }
    const next = await update($, pending, p => ({
      clicks: p.clicks - delta.clicks,
      coins: p.coins - delta.coins,
      drops: p.drops - delta.drops,
    }))
    await $.store.set('pending', next)
    await update($, board, b => ({
      ...b,
      rank: res.rank ?? b.rank,
      totalPlayers: res.totalPlayers ?? b.totalPlayers,
      globalClicks: res.globalClicks ?? b.globalClicks,
      error: undefined,
    }))
  } catch (err) {
    await update($, board, b => ({ ...b, error: reason(err) }))
  }
}

async function refreshBoard($: EngineInterface, opts: Options) {
  if (!opts.serverUrl) return
  try {
    const res = await $.http.fetch(`${opts.serverUrl}/leaderboard`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = JSON.parse(res.text) as Partial<Leaderboard>
    await update($, board, b => ({
      top: Array.isArray(body.top) ? body.top : [],
      globalClicks: body.globalClicks ?? 0,
      totalPlayers: body.totalPlayers ?? 0,
      rank: b.rank,
      fetchedAt: now(),
      error: undefined,
    }))
  } catch (err) {
    await update($, board, b => ({ ...b, error: reason(err) }))
  }
}

async function refreshStock($: EngineInterface, opts: Options) {
  if (!opts.serverUrl) return
  try {
    const [stockRes, rateRes] = await Promise.all([$.http.fetch(`${opts.serverUrl}/stock`), $.http.fetch(`${opts.serverUrl}/rate`)])
    if (stockRes.ok) await update($, serverStock, () => JSON.parse(stockRes.text) as Record<string, number>)
    if (rateRes.ok) {
      const r = JSON.parse(rateRes.text) as Partial<Rate>
      if (typeof r.coinsPerUsd === 'number') {
        await update($, rate, (): Rate => ({
          coinsPerUsd: r.coinsPerUsd as number,
          windowCoins: r.windowCoins ?? 0,
          budgetUnits: r.budgetUnits ?? 1,
          source: 'server',
          updatedAt: now(),
        }))
      }
    }
  } catch {
    // the local stock and rate stand
  }
}

/** Once a minute: report deltas and, while the pane shows, refresh the board. */
async function tick($: EngineInterface, opts: Options) {
  if (!opts.serverUrl) return
  await sync($, opts)
  const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
  if (shown) {
    const v = await read($, view)
    if (v === 'top') await refreshBoard($, opts)
    if (v === 'shop') await refreshStock($, opts)
  }
}
