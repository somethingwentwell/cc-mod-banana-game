# 🍌 Banana for Claude Code

**Claude is thinking. Your hands are free. Click the banana.**

Banana is a mod for Claude Code. Every time Claude starts thinking, a banana pops up beside your chat. Click it to earn coins, catch rare bananas, and trade your coins for **real LLM tokens** from the sponsor. When the answer lands, the banana gets out of your way.

![Claude Code with the Banana pane docked beside the chat](docs/hero.png)

<sub>Real capture: Claude Code 2.1.291 in a terminal with the mod loaded.</sub>

## Why you'll keep it on

- **Waiting pays.** Every turn Claude spends thinking is a few hundred clicks you can cash in.
- **Rare drops.** Each click can drop a banana: 🍌 common, 🟢 rare, 🔵 epic, or the ⭐ Golden Banana at 1 in 2,000.
- **Real rewards.** Coins buy **$1 of LLM tokens**, topped up straight onto your account on the sponsor's gateway. No setup: the mod is already connected.
- **A live leaderboard.** See how many bananas everyone has clicked this week, and where you rank.
- **It stays out of the way.** The pane opens when Claude thinks and closes when Claude answers. Nothing touches your code or your conversation.

## Get started

In Claude Code:

```text
/plugin marketplace add somethingwentwell/cc-mod-banana-game
/plugin install banana@banana
```

Restart Claude Code. If the install mentions options that are not set yet, skip it: the defaults already connect you to the sponsor's server.

Then type `/banana` to open the pane, or just ask Claude something: the banana opens by itself while Claude thinks. Press `1` (or click the button) to click the banana.

> The pane opens on its own when your terminal is at least 144 columns wide. On a narrower terminal, `/banana` always opens it.

You need a recent [Claude Code](https://claude.com/claude-code) (tested on 2.1.291).

## How to play

| | |
|---|---|
| ![Click tab](docs/click.png) | **Click.** Each click pays `1 + level` coins, and every 100 clicks is a new level. Drops show up as a toast and land in your Bag. |
| ![Bag tab](docs/bag.png) | **Bag.** Your bananas by rarity, what each kind sells for, and its drop chance. Sell a whole rarity for coins in one press. |
| ![Shop tab before linking a gateway account](docs/shop-link.png) | **Shop.** The live price of $1 of LLM tokens. Register on the sponsor's gateway once, then type `/banana link <your username>`. |
| ![Shop tab after redeeming](docs/shop.png) | **Redeem.** Press the redeem button and $1 of tokens is added to your gateway account. The receipt stays in the Shop. |
| ![Top tab with the leaderboard](docs/top.png) | **Top.** Bananas clicked worldwide this week, the top players, and your rank. Pick a name with `/banana name <text>`. |

**Keys while the pane is focused:** `1` clicks the banana · `c` `b` `s` `t` switch tabs · `1` in the Shop redeems · `Esc` returns to the prompt.

**Commands**

| Command | What it does |
|---|---|
| `/banana` | Open the pane now |
| `/banana link <username>` | Where your tokens are paid: your login on the sponsor's gateway |
| `/banana name <text>` | Your name on the leaderboard |

### The rules in one minute

- **The price floats.** The sponsor puts a fixed budget of tokens on the table each week. The more coins everyone earns, the more coins $1 of tokens costs. The Shop shows the current rate and why.
- **Spend it or lose it.** Coins and bananas expire 7 days after you earn them, oldest first, so cash in regularly. The header shows when your oldest coins expire.
- **Glory is forever.** Your lifetime clicks and coins never expire, and the leaderboard ranks lifetime coins.
- **Saved on your machine.** Progress lives in Claude Code's plugin store and survives restarts.

## Get your tokens

The mod connects to the sponsor's server on its own; there is nothing to configure. To be paid, you need an account on the sponsor's LLM gateway:

1. Register at **[banana.jevable.ai/register](https://banana.jevable.ai/register)** (the Shop shows the same link).
2. In Claude Code, type `/banana link <your username>`.
3. Redeem in the Shop. The $1 of tokens lands on that account. Create an API key there and use `https://banana.jevable.ai/v1` as the base URL in any OpenAI-compatible tool.

Prefer to play offline? Set **Server URL** and **Content URL** to empty under the plugin's settings in `/config`.

## Updating

```bash
claude plugin update banana@banana
```

Then restart Claude Code. When the sponsor ships something that needs a newer mod (a new kind of banana, say), the pane shows **Update required** and an **Update now** button that runs the same update for you.

## What it sends

Only game data, to the sponsor's server: a random player id made on your machine, click and coin counts, your leaderboard name and gateway login if you set them, the mod version, and whether you play in the terminal or the desktop app. Never your prompts, code, files or conversation. Empty the **Server URL** setting and nothing is sent.

## Run from source

```bash
git clone https://github.com/somethingwentwell/cc-mod-banana-game.git
cd cc-mod-banana-game
claude --plugin-dir "$(pwd)"
```

The mod hot-reloads as you edit it. `claude plugin validate .` checks the manifests and hooks, and `claude plugin test .` runs the tests. Where you can't pass `--plugin-dir`, such as the Claude desktop app, list the folder under `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

---

The sponsor side (the token gateway, prices and payouts) lives in its own repo, `cc-mod-banana-server`.
