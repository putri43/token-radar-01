[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/putri43/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/putri43/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Launch Radar — every rank shows its peers

A token launch radar for make.fun's `token-radar-01` bounty. It reads a sealed snapshot
of 758 DeFi protocols, ranks the 198 that record no token (the 40-protocol watchlist plus
158 below its $50M floor) by implied launch value, and hands in a dashboard a reader can
use: the board, a detail view for every protocol, and costed farm plans.

## The model (peer-proven-1)

Fitted, never hand-written. `log10(market cap)` is regressed on `log10(TVL)` over the 128
tokenized protocols that record a market cap, with a shrunk category offset per category
(used only when the category has at least 3 comps):

```
implied = 10 ^ (3.0247 + 0.5223 x log10(TVL) + category offset)
```

Growth and age were tested as terms and rejected by the blind test — they made
leave-one-out error worse — so they do not enter the price. Every rank carries a 90%
interval and a rank range from 200 bootstrap refits. The full method, the blind-test
table and the farm-cost assumptions are in `dashboard/0-method.md` and on the page.

## Validation (computed from the snapshot at build time)

- Leave-one-out median error, best of five candidate models: **84.8%**
  (flat multiple 88.0%, log-size curve 85.2%, +category 84.8% kept, +growth 87.0%,
  +growth+age 89.1% rejected)
- Walk-forward (fit before 2025-06-01, test after): **92.7%** on 20 later-listed protocols
- R² 0.19; a peer's actual value typically lands within ×7.4 of the fit

TVL alone explains only a fifth of a token's value — the board says so on its face.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, standard library only. `main.ts` reads the snapshot, writes `board.json`, the
dashboard's data (`dashboard/z-data.js`), and `dossier.json` via `vendor/makefun-board.ts`.
The dashboard is static, renders with no network, and its three screenshots are taken
with a headless browser (`screenshot.py`).

## Layout

- `main.ts` — entrypoint: snapshot in, board + dashboard + dossier out
- `lib/model.ts` — the fit, the blind tests, the bootstrap, the farm plans
- `dashboard/` — `index.html`, `app.css`, `app.js`, `0-method.md`, `z-data.js` (generated)
- `screenshots/` — the board, a protocol detail view, a filtered view
- `vendor/makefun-board.ts` — make.fun's dossier library, as shipped in the kit
