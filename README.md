# 🍌 Banana — a Claude Code mod

A clicker in the spirit of Steam's *Banana*, living inside Claude Code. While Claude is thinking a pane opens with a banana. Click it to earn Banana Coins, catch rare banana drops, and spend coins on **$1 of LLM tokens** from the game's sponsor. The pane closes when the answer lands.

The economy is a shared pool: the sponsor puts a budget on the table per week, and the coin price of $1 floats with how much everyone earned that week. Coins and bananas are void after 7 days; lifetime totals never are.

```
  _______
 / _____ \      🪙 240 coins   Lv 2   Claude is thinking… click!
| |BANANA| |
 \_______/     [Click]  Bag  Shop  Top   [ Close ]
                      _
                     //
                    //        [ 🍌 CLICK THE BANANA 🍌 ]
                   ((
                    \\__      213 clicks · +3 per click · 87 to Lv 3
                     \__)     🟢 Green Banana dropped! (rare)
```

## Layout

| Path | What |
|---|---|
| `.claude-plugin/plugin.json` | manifest, version, config fields `contentUrl` and `serverUrl` |
| `hooks/register.tsx` | the mod: pane, turn hooks, `/banana` command, sync |
| `hooks/game.ts` | pure rules: levels, drops, selling, redeeming, version gate |
| `hooks/catalog.ts` | bundled content, used when no `contentUrl` is set |
| `hooks/banana.test.ts` | `claude plugin test .` |
| `types/index.d.ts` | state contract |
| `content.json` | the file you host: sponsor look, the banana skin, economy, special bananas, gifts, `minVersion` |
| `server/` | Docker Compose: New API gateway + the banana server (Node, SQLite): pool rate, coin ledger with expiry, leaderboard, install counter, gateway top-ups, admin |
| `docs-pane-preview.jpg` | the pane rendered from the real draw code |

## Play

Load the mod for one session:

```bash
claude --plugin-dir /path/to/cc-mod-banana
```

For the desktop app or any host where you cannot pass a flag, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

- The pane opens by itself when a turn starts (on a terminal it needs 144 columns or fullscreen; the desktop app always places it) and closes when Claude answers.
- `/banana` opens it any time. `/banana name Warren` sets your leaderboard name. `/banana link alice` says which gateway account receives your tokens.
- Hotkeys while the pane has focus: `1` click, `c` `b` `s` `t` tabs, `u` update, `r` re-check.
- Every click pays `1 + level` coins; a level is 100 clicks. Drops land in the Bag and sell for coins. The Shop trades coins for $1 of LLM tokens and shows the one-time code, with a Copy button.
- The header shows spendable coins, when the oldest batch goes void, and lifetime coins and clicks. The Shop shows the live rate and how it was computed.
- Progress is saved in the plugin's own store under `~/.claude` and survives restarts.

## The economy

```json
"economy": { "windowHours": 168, "budgetUsd": 10, "unitUsd": 1, "minCoinsPerUsd": 500, "fallbackCoinsPerUsd": 1000 }
```

| Rule | Where it runs |
|---|---|
| **Rate.** coins per $1 = coins everyone earned in the last `windowHours` ÷ (`budgetUsd` / `unitUsd`), never below `minCoinsPerUsd`. With a $10 weekly budget and 50,000 coins earned by all players this week, $1 costs 5,000 coins. | Server, on every sync and redeem. Single-player mode uses `fallbackCoinsPerUsd`. |
| **Price.** Every gift carries a `usd` value; its coin price is `usd × rate`. | Mod shows it, server charges it. |
| **Expiry.** Each coin batch and each banana carries its earn time and is void after `windowHours`. Redeeming spends the oldest coins first. | Both: the mod prunes locally, the server's `ledger` table is authoritative. |
| **History.** Lifetime clicks, coins and drops never expire; the leaderboard ranks lifetime coins. | `players` table and the save's `lifetime` block. |

The mod reports deltas, so a player cannot redeem more than they reported; the server's caps (600 clicks per report, coins bounded by level and drops) stop casual cheating.

## Content: change the game without shipping code

Everything a sponsor wants to change is data in `content.json`:

```json
{
  "version": "2",
  "minVersion": "0.1.0",
  "sponsor": { "name": "Acme Fruit", "tagline": "…", "color": "yellow", "banner": ["ascii", "lines"] },
  "specials": [ { "id": "golden", "name": "Golden Banana", "glyph": "⭐", "rarity": "legendary", "chance": 0.0005, "sellValue": 1000 } ],
  "banana": { "name": "Acme Banana", "svg": "<svg …>", "art": ["ascii", "lines"], "buttonLabel": "🍌 CLICK THE ACME BANANA 🍌" },
  "economy": { "windowHours": 168, "budgetUsd": 10, "unitUsd": 1, "minCoinsPerUsd": 500, "fallbackCoinsPerUsd": 1000 },
  "gifts": [ { "id": "llm-tokens", "name": "LLM tokens", "sponsor": "Acme Fruit", "usd": 1, "stock": 10, "description": "$1 of LLM API credit, sent as a one-time code", "claim": { "kind": "pool" } } ]
}
```

- `sponsor.logo` is SVG markup drawn on the desktop (`logoHeight` sizes it); `banner` is the ASCII fallback for the terminal. `lines` and `url` give the sponsor more room under the tagline.
- `banana.svg` reskins the click banana itself, `banana.name` titles the pane ("Acme Banana"), `banana.art` is the terminal version.
- A gift's `claim.kind` is `gateway` (the server tops up the player's gateway account; needs a linked login), `pool` (one-time codes held by the server), `code` (one shared code) or `url` (a link). Tokens are `gateway`.
- `gateway` names where players register (`name`, `url`, `hint`); the Shop shows it until they run `/banana link <username>`.

1. Commit `content.json` to this repo (or any host) and take its raw URL.
2. Players set it once: Claude Code config → plugin `banana` → **Content URL**. Or in `~/.claude/settings.json`:
   ```json
   { "pluginConfigs": { "banana": { "contentUrl": "https://raw.githubusercontent.com/<you>/cc-mod-banana/main/content.json" } } }
   ```
3. Edit the JSON, push (or `PUT /content` on the server, which also serves it at `/content`). Mods re-read it on session start, on a turn start when the last check is older than 10 minutes, and on **Check again**. Offline, the last fetched copy is used and the pane says so.

Rarity is one of `common`, `rare`, `epic`, `legendary`. `chance` is per click; rarest kinds are rolled first. `stock: -1` means unlimited.

### Admin: running the token shop

The sponsor budget is `economy.budgetUsd` per window, handed out as `stock` units of `usd` each (10 × $1). To change it, edit `content.json` and PUT it again; to put more units on the table mid-week, `PUT /stock`. Everything else is in the backend section below.

## Forcing players to update

When a change needs new code (a new mechanic, a new look), bump `version` in `.claude-plugin/plugin.json`, push, then set `minVersion` in the hosted `content.json` to that version. Any older mod shows **Update required** instead of the game and refuses clicks and redeems until updated:

- **Update now** runs `git pull --ff-only` in the mod folder when it is a git checkout and the mod reloads by itself.
- Otherwise the player replaces the folder with the new release and restarts.

The gate also applies to cached content, so going offline does not unlock an old mod.

## Backend: one VM, one `docker compose up`

`server/docker-compose.yml` runs two containers:

| Service | Port | What |
|---|---|---|
| `new-api` | 3000 | the LLM gateway players register on and spend their tokens through (QuantumNous/new-api; One API works too) |
| `banana` | 8787 | the banana server: pool rate, coin ledger with expiry, leaderboard, stock, install counter, and the top-ups |

No Cloudflare, no external database: the banana server is one Node 24 process over a SQLite file in a volume, with no npm dependencies.

### Deploy

```bash
cd server
cp .env.example .env            # set ADMIN_TOKEN (any long random string)
docker compose up -d
```

1. Open `http://<vm>:3000/setup` once and create the root admin (New API has no default password). Then wire the banana server to it in one go:
   ```bash
   ./bootstrap-gateway.sh root '<root password>'
   ```
   It logs in, passes New API's security verification, creates an access token named `banana-server`, writes it to `.env` as `GATEWAY_TOKEN`, restarts the banana container and uploads `../content.json`. (Or do it by hand: Settings → Personal → Access tokens, paste it into `.env`, `docker compose up -d`.)
2. Upload the content so the server knows the economy and the gift:
   ```bash
   curl -X PUT http://<vm>:8787/content -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" --data-binary @content.json
   ```
3. Players set **Server URL** in the plugin config to `http://<vm>:8787` (and **Content URL** to `http://<vm>:8787/content` or the GitHub raw file).
4. For TLS, set `DOMAIN` in `.env`, point `gateway.<domain>` and `banana.<domain>` at the VM, and uncomment the `caddy` service.

### How a player gets tokens

1. They register on your gateway (the Shop shows the link and `/banana link <username>`).
2. They click while Claude thinks, and redeem "$1 of LLM tokens" in the Shop at the live rate.
3. The banana server finds that username on the gateway (`GET /api/user/search`) and adds `usd × GATEWAY_QUOTA_PER_USD` quota to the account (New API: `POST /api/user/manage` with `add_quota`; One API: `POST /api/topup`). The claim shows "Topped up $1 (500000 quota) to alice".
4. If the login does not exist on the gateway, the redeem fails, the coins come back, and the claim is recorded as `failed` so you can see it.

### Counting players

Every session the mod sends one `POST /hello` with its player id, version and surface. `GET /stats` (admin) answers:

```
installs, sessions, installsActive24h, installsActive7d,
playersWhoClicked, playersActive24h, playersActive7d, playersLinked,
globalClicks, lifetimeCoins, payoutsPaid, payoutsFailed, byVersion, bySurface, rate
```

`installs` is how many people downloaded the mod and opened Claude Code with it at least once; `playersWhoClicked` how many actually played.

### Admin calls

All with `x-admin-token: $ADMIN_TOKEN`.

```bash
S=http://<vm>:8787
curl -X PUT  $S/content -H "$A" -H "$J" --data-binary @content.json     # economy, sponsor look, gifts
curl -X PUT  $S/stock   -H "$A" -H "$J" -d '{"giftId":"llm-tokens","left":10}'   # units on the table this week (-1 = unlimited)
curl         $S/rate                                                    # coins per $1 now and the pool behind it
curl         $S/stats   -H "$A"                                         # installs, players, payouts
curl         $S/claims  -H "$A"                                         # who got what, when, paid / failed and why
curl -X POST $S/codes   -H "$A" -H "$J" -d '{"giftId":"x","codes":["…"]}'  # only for a `pool` gift (one-time codes)
```

### Local development

```bash
cd server
npm test                                  # in-process tests against the mock gateway
node test/mock-gateway.js 3999 &          # a fake New API with users alice and bob
ADMIN_TOKEN=dev GATEWAY_URL=http://127.0.0.1:3999 GATEWAY_TOKEN=gw-admin-token node src/server.js
```

Then set `serverUrl` to `http://localhost:8787` and play.

## Developing the mod

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .      # after the mod has loaded once (the engine writes .claude-plugin/types)
```

Inside a Claude Code session the mod hot-reloads when its folder is a `--plugin-dir`.
