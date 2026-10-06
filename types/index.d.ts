// The banana mod's state contract: what `$.state` holds under `banana`.

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'

/** A banana kind the content defines; a drop is one of these. */
export type SpecialBanana = {
  id: string
  name: string
  glyph: string
  rarity: Rarity
  /** Probability per click, 0..1. */
  chance: number
  /** Coins it sells for from the bag. */
  sellValue: number
}

export type Drop = { id: string; kindId: string; name: string; glyph: string; rarity: Rarity; at: string }

/**
 * What a redeemed gift hands the player: a shared code, a link, (`pool`) a
 * one-time code the server holds, or (`gateway`) a top-up of the player's
 * account on the sponsor's LLM gateway, which needs the server and a linked login.
 */
export type ClaimSpec =
  | { kind: 'code'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'pool'; value?: string }
  | { kind: 'gateway'; value?: string }

export type Gift = {
  id: string
  name: string
  sponsor: string
  /** Initial stock; the save tracks what is left. -1 = unlimited. */
  stock: number
  /** Money value of one unit: its coin price is `usd × rate`. A budget gift is `usd: 1, stock: 10` for $10. */
  usd?: number
  /** Fixed coin price for a gift with no `usd`. */
  priceCoins?: number
  /** One line under the name: what the player actually gets. */
  description?: string
  claim: ClaimSpec
}

export type Claim = { giftId: string; giftName: string; at: string; claim: string }

/** One batch of coins earned at `at`; `left` is what is still unspent. */
export type LedgerRow = { at: string; coins: number; left: number }

export type Lifetime = { clicks: number; coins: number; drops: number }

export type Save = {
  /** Spendable coins: the unexpired `left` of the ledger, cached by `expire()`. */
  coins: number
  clicks: number
  level: number
  inventory: Drop[]
  claims: Claim[]
  /** Stock left per gift id; absent = the gift's initial stock. */
  stock: Record<string, number>
  /** Coins by earn time, oldest first; a row older than the window is void. */
  ledger: LedgerRow[]
  /** Never expires: what the leaderboard and the player's history show. */
  lifetime: Lifetime
}

/** The sponsor's economy: a budget per window, shared pro-rata by everything earned in it. */
export type Economy = {
  /** Coins and bananas are void after this many hours; also the pool window. Default 168 (7 days). */
  windowHours: number
  /** The sponsor's budget per window, in USD. */
  budgetUsd: number
  /** Smallest exchange, in USD; budgetUsd / unitUsd is the number of units. */
  unitUsd: number
  /** Coins per $1 never drop below this, so a quiet week is not free. */
  minCoinsPerUsd: number
  /** Coins per $1 used in single-player mode, where no pool total exists. */
  fallbackCoinsPerUsd: number
}

/** The exchange rate as last computed: by the server, or the content's fallback. */
export type Rate = {
  coinsPerUsd: number
  /** Coins everyone earned in the window (server) or 0. */
  windowCoins: number
  budgetUnits: number
  source: 'server' | 'fallback'
  updatedAt?: string
}

/** What content.json holds: hosted by you, fetched on start, and the update gate. */
export type Content = {
  /** Version of this content document. */
  version: string
  /** The oldest mod version allowed to play this content. */
  minVersion: string
  sponsor: {
    name: string
    tagline: string
    /** ASCII lines, drawn on the terminal (and wherever no logo is given). */
    banner: string[]
    color: string
    /** Optional SVG markup (<svg>…</svg>, ≤ 131072 chars), drawn instead of the banner on the desktop. */
    logo?: string
    /** CSS pixel height for the logo; default 64. */
    logoHeight?: number
    /** Extra text lines under the tagline: a message, terms, a promo. */
    lines?: string[]
    /** An https link drawn under the sponsor text. */
    url?: string
    urlLabel?: string
  }
  /** The click banana, skinnable by the sponsor. */
  banana: {
    /** "Acme Banana": shown as the pane title and over the banana. */
    name: string
    /** SVG markup for the big banana; absent, the built-in banana. */
    svg?: string
    /** ASCII lines for the terminal; absent, the built-in art. */
    art?: string[]
    /** The button's text; default "🍌 CLICK THE BANANA 🍌". */
    buttonLabel?: string
  }
  gifts: Gift[]
  specials: SpecialBanana[]
  economy: Economy
  /** Where players register to receive tokens: shown in the Shop. */
  gateway?: { name: string; url?: string; hint?: string }
  notes?: string
}

export type UpdateStatus = 'unchecked' | 'checking' | 'ok' | 'required' | 'offline'

export type Update = {
  status: UpdateStatus
  localVersion: string
  minVersion?: string
  contentVersion?: string
  message?: string
  checkedAt?: string
}

export type View = 'click' | 'bag' | 'shop' | 'top'

/** Deltas not yet reported to the server. */
export type Pending = { clicks: number; coins: number; drops: number }

/** `gateway` is the player's login on the sponsor's LLM gateway (One API username), where tokens are paid out. */
export type Player = { id: string; name: string; gateway?: string }

export type LeaderRow = { name: string; coins: number; clicks: number }

export type Leaderboard = {
  top: LeaderRow[]
  globalClicks: number
  totalPlayers: number
  rank?: number
  fetchedAt?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    banana: {
      save: Save
      view: View
      isThinking: boolean
      lastEvent: string
      content: Content
      update: Update
      pending: Pending
      rate: Rate
      player: Player
      board: Leaderboard
      serverStock: Record<string, number>
    }
  }
}
