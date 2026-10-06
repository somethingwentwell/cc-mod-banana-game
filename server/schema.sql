-- Banana server schema (SQLite). The server applies it on start; every
-- statement is idempotent, so re-running is safe.

-- Lifetime totals: never decay, never spent. The leaderboard reads these.
-- `gateway` is the player's login on the LLM gateway, where tokens are paid out.
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  gateway TEXT NOT NULL DEFAULT '',
  clicks INTEGER NOT NULL DEFAULT 0,
  coins INTEGER NOT NULL DEFAULT 0,
  drops INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS players_coins ON players (coins DESC);

-- Coins by earn time. A row older than the economy window is void; `remaining`
-- is what is still unspent (redeem takes the oldest rows first). The sum of
-- `coins` over the window is the pool that sets the exchange rate.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  coins INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  earned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_player ON ledger (player_id, earned_at);
CREATE INDEX IF NOT EXISTS ledger_time ON ledger (earned_at);

-- Stock left per gift. -1 = unlimited. Seed from content.json (see README).
CREATE TABLE IF NOT EXISTS stock (
  gift_id TEXT PRIMARY KEY,
  left INTEGER NOT NULL
);

-- A pool of one-time codes per gift. When empty, /redeem falls back to the
-- gift's shared claim from content.
CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_id TEXT NOT NULL,
  code TEXT NOT NULL,
  used_by TEXT
);
CREATE INDEX IF NOT EXISTS codes_free ON codes (gift_id, used_by);

-- One row per redemption. `status`: paid (code handed out or gateway topped
-- up), pending (gateway call in flight), failed (coins were refunded).
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  gift_id TEXT NOT NULL,
  code TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  detail TEXT
);

-- One row per mod install (player id), bumped once per session by POST /hello:
-- how many people downloaded the mod and opened Claude Code with it.
CREATE TABLE IF NOT EXISTS installs (
  player_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  mod_version TEXT NOT NULL DEFAULT '',
  surface TEXT NOT NULL DEFAULT ''
);

-- The hosted content document, one row. Optional: GitHub raw works too.
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
