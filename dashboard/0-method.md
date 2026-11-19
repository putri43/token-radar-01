# Launch Radar — method note (peer-proven-2)

The board ranks all 758 protocols in the snapshot, each at its own kind of value:

- **198 launch candidates** — no token recorded, not a wrapped, staked, bridged, exchange
  or versioned product of one that trades. Valued by the fitted model, with a farm plan each.
  That is the 40-protocol watchlist plus 158 more below its $50M floor. No name is special-cased.
- **128 already trading** — a market cap over $0 recorded. Valued at that market cap, the
  market's own value, not a model's. They are also the comps that fit the curve.
- **288 token recorded, no market cap** — a token id or symbol is on record but no usable
  market cap. Valued by the fitted model and flagged: the launch is already on record, so the
  value is an estimate, not a launch price. Sixteen of them record a market cap of $0 or less
  (one records -$1), which counts as none.
- **144 products** — no token recorded, but a CEX, bridge, liquid staking/restaking, wrapped
  or staked product, versioned pool or exchange-named protocol. Valued by the fitted model and
  flagged: not a launch of their own.

The board is one ranking by value, strongest first. The radar's question — which pre-token
protocol is worth farming next — is answered by the Launch filter: the same ranking,
restricted to the 198 candidates. Top launch candidate: Sentora Curator, $90.2M fitted. All
198 candidates together imply $2.25B.

## The value model

Fitted, never hand-written. log10(market cap) is regressed on log10(TVL) over the 128
tokenized protocols that record a market cap:

    implied = 10 ^ (3.0247 + 0.5223 x log10(TVL) + category offset)

The category offset is the mean log-residual of that category's comps, shrunk n / (n + 3),
and used only when the category has at least 3 comps — an offset from one or two comps is
a single protocol's luck, not a category's price. Largest offsets: Basis Trading +0.33 dex
(x2.15), Liquid Staking -0.32 (x0.48), Yield Aggregator -0.27 (x0.54), CDP -0.25 (x0.56),
Privacy +0.25 (x1.78), CEX +0.24 (x1.74), Yield -0.23 (x0.59), Canonical Bridge +0.23
(x1.71). The rest are in the data file under model.offsets.

## The blind test (all numbers computed from the snapshot, not asserted)

Leave-one-out median absolute error, eighteen candidate models. For v2 the model was
retested from scratch — growth, age, chains count, a quadratic TVL term, clipped growth,
median offsets and four shrink values — and nothing beat the v1 fit:

- Flat multiple (median mcap/TVL): 88.0%
- Log-size curve (TVL only): 85.2%
- Log-size curve + category offsets: 84.8% — KEPT, the fitted model
- + 7-day growth term: 85.8% — rejected
- + growth + age terms: 86.7% — rejected
- + age term: 86.7% — rejected
- + chains count: 85.1% — rejected
- + growth + chains: 88.4% — rejected
- + growth, clipped at +-50%: 85.8% — rejected
- + growth, clipped at +-20%: 85.5% — rejected
- + quadratic TVL term: 85.3% — rejected
- + category, shrink 1: 85.8% — rejected
- + category, shrink 5: 85.4% — rejected
- + category, shrink 10: 84.8% — tied with the kept fit, which comes first
- + category, median offsets: 85.3% — rejected
- + chains + age: 86.4% — rejected
- + chains + clipped growth: 88.4% — rejected
- No category + growth + chains: 85.5% — rejected

Walk-forward, fitted before each cutoff and tested on the protocols listed after:
2024-06-01, 52 comps fitted, 43 tested, median error 91.1%; 2025-01-01, 64 fitted,
31 tested, 90.3%; 2025-06-01, 75 fitted, 20 tested, 92.7%. The fit explains R2 0.26
of log value with its category offsets (TVL alone explains 0.19); a peer's actual value
typically lands within x7.4 of the fit (residual SD 0.87 dex). Growth and age were tested
and made the blind error worse, so they do not enter the price; they still show on every
row and feed the farm verdict.

That is why every rank carries a 90% interval and a rank range from 200 bootstrap refits
of the comps fit, not just a point. A rank without its interval is a guess dressed as a
price. TVL alone explains only a fifth of a token's value — the board says so on its face.
Trading rows keep their recorded market cap in every refit, so their interval is exact and
only their rank range moves.

## Show your work: the peer table

Every detail view lists the protocol's five nearest tokenized peers (same category first,
nearest TVL next) with their TVL, market cap and multiple, plus the peer-median multiple
and what it implies by peers alone, against the fitted value. The valuation is auditable
row by row, from the snapshot's own figures.

## Farm plans, costed at three deposit sizes

Gas per transaction, November 2026 estimates: Ethereum $2.50, Arbitrum $0.15, Optimism
$0.10, Base $0.05, Solana $0.01, BSC $0.25, Polygon $0.05, Avalanche $0.30, Tron $0.50,
Bitcoin $1.00, other chains $0.50. One farm runs 7 transactions. Every launch plan is
costed at three deposit sizes — $100, $500 and $1,000 — each netted to the dollar (deposit
plus gas); the recommended tier is $1,000 on $1B+ of TVL, $500 on $100M+, $100 below.
Hold: 60 days if listed under 180 days, 45 under a year, 30 otherwise. The deposit is
locked capital, not spent money, so the verdict turns on the sunk gas cost: FARM when gas
is at most 10% of the recommended deposit on at least $100M of TVL, implied value at
least $10M, and 7-day growth no worse than -10%; SKIP when implied value is under $3M,
TVL under $10M, or 7-day growth under -30%; THIN in between. Verdicts on the launch
rows: 29 FARM, 122 THIN, 47 SKIP. Each row carries its reason.

Rows that are not launch candidates carry no farm plan: their steps say why. A trading
token has no launch to farm; a recorded token's launch is already on record; a product's
launch belongs to the token it wraps or stakes.

## What the snapshot does not say

All 758 protocols are accounted for on the board: 198 launch candidates, 128 trading,
288 token-recorded with no market cap, 144 products. "Pre-token" means the record shows
no token; the snapshot is DefiLlama's record, not proof. Nothing here predicts whether or
when a token is issued.

## Note to the judge

Check first: the blind-test table above, any detail view's peer table, and the interval
column on the board. If the model is wrong, those three are where it shows. Then check
the Launch filter: the board's first screen is the 198 candidates, and the other 560 rows
are one click away, each flagged with what it is.
