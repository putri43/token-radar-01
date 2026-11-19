[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/putri43/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/putri43/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Launch Radar — every rank shows its peers

A token launch radar for make.fun's `token-radar-01` bounty. It reads a sealed snapshot
of 758 DeFi protocols and ranks **all of them**: the 198 that record no token (the
40-protocol watchlist plus 158 below its $50M floor) by fitted implied launch value, the
128 that already trade at their recorded market cap, the 288 with a token recorded but no
market cap at a fitted value flagged as not a launch price, and the 144 wrapped, staked,
bridged or exchange products at a fitted value flagged as not a launch of their own. The
dashboard hands a reader the board, a detail view for every protocol, and costed farm
plans — and opens on the launch candidates, the radar's subject.

v1 scored 947.181 on the dev ladder (rank 154 of 13,027) — 12.469 points short of the top
10. v2 keeps the model that earned it and closes the gaps the leaders show: full 758-row
coverage, a KPI strip, and deposit-sized farm plans.

## The model (peer-proven-2)

Fitted, never hand-written. `log10(market cap)` is regressed on `log10(TVL)` over the 128
tokenized protocols that record a market cap, with a shrunk category offset per category
(used only when the category has at least 3 comps):

```
implied = 10 ^ (3.0247 + 0.5223 x log10(TVL) + category offset)
```

For v2 the model was retested against 18 candidates — growth, age, chains count, a
quadratic TVL term, clipped growth, median offsets and four shrink values — and none beat
the v1 fit, so the fit stands. That is stated on the page, with the full table: the model
is honestly weak and the board says so. Every rank carries a 90% interval and a rank range
from 200 bootstrap refits. The full method, the blind-test table and the farm-cost
assumptions are in `dashboard/0-method.md` and on the page.

## Validation (computed from the snapshot at build time)

- Leave-one-out median error, best of eighteen candidate models: **84.8%**
  (flat multiple 88.0%, log-size curve 85.2%, +category 84.8% kept; growth, age, chains,
  quadratic TVL, clipped growth, median offsets and shrink 1/5/10 all rejected — shrink 10
  tied at 84.8% and the earlier candidate wins ties)
- Walk-forward at three cutoffs: **91.1%** (2024-06-01, 43 tested), **90.3%**
  (2025-01-01, 31 tested), **92.7%** (2025-06-01, 20 tested)
- R² 0.26 with category offsets (0.19 from TVL alone); a peer's actual value typically
  lands within ×7.4 of the fit

TVL alone explains only a fifth of a token's value — the board says so on its face.

## Farm plans

Every launch plan is costed at three deposit sizes — $100, $500 and $1,000 — each netted
to the dollar (deposit plus gas for the whole 7-transaction farm). The recommended tier is
$1,000 on $1B+ of TVL, $500 on $100M+, $100 below. Verdicts on the launch rows: 29 FARM,
122 THIN, 47 SKIP. Rows that are not launch candidates carry no farm plan: their steps say
why, in plain words.

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
