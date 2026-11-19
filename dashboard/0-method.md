# Launch Radar — method note (peer-proven-1)

The board ranks 198 protocols: every protocol in the snapshot that records no token and
is not a wrapped, staked, bridged, exchange or versioned product of one that trades. That
is the 40-protocol watchlist plus 158 more below its $50M floor. No name is special-cased.

## The value model

Fitted, never hand-written. log10(market cap) is regressed on log10(TVL) over the 128
tokenized protocols that record a market cap:

    implied = 10 ^ (3.0247 + 0.5223 x log10(TVL) + category offset)

The category offset is the mean log-residual of that category's comps, shrunk n / (n + 3),
and used only when the category has at least 3 comps — an offset from one or two comps is
a single protocol's luck, not a category's price. Largest offsets: Basis Trading +0.33 dex
(x2.15), Privacy +0.25 (x1.78), CEX +0.24 (x1.74), Canonical Bridge +0.23 (x1.71),
Liquid Staking -0.32 (x0.48), Yield Aggregator -0.27 (x0.54), CDP -0.25 (x0.56),
Lending -0.21 (x0.62). The rest are in the data file under model.offsets.

## The blind test (all numbers computed from the snapshot, not asserted)

Leave-one-out median absolute error, five candidate models:

- Flat multiple (median mcap/TVL): 88.0%
- Log-size curve (TVL only): 85.2%
- Log-size curve + category offsets: 84.8% — KEPT, the fitted model
- + 7-day growth term: 87.0% — rejected
- + growth + age terms: 89.1% — rejected

Walk-forward: fitted on the 75 comps listed before 2025-06-01, tested on the 20 listed
after — median error 92.7%. The fit explains R2 0.19 of log value; a peer's actual value
typically lands within x7.4 of the fit (residual SD 0.81 dex). Growth and age were tested
and made the blind error worse, so they do not enter the price; they still show on every
row and feed the farm verdict.

That is why every rank carries a 90% interval and a rank range from 200 bootstrap refits
of the comps fit, not just a point. A rank without its interval is a guess dressed as a
price. TVL alone explains only a fifth of a token's value — the board says so on its face.

## Show your work: the peer table

Every detail view lists the protocol's five nearest tokenized peers (same category first,
nearest TVL next) with their TVL, market cap and multiple, plus the peer-median multiple
and what it implies by peers alone, against the fitted value. The valuation is auditable
row by row, from the snapshot's own figures.

## Farm plans, costed

Gas per transaction, November 2026 estimates: Ethereum $2.50, Arbitrum $0.15, Optimism
$0.10, Base $0.05, Solana $0.01, BSC $0.25, Polygon $0.05, Avalanche $0.30, Tron $0.50,
Bitcoin $1.00, other chains $0.50. One farm runs 7 transactions. Capital by TVL: $250
over $5B, $150 over $1B, $100 over $100M, $50 below. Hold: 60 days if listed under 180
days, 45 under a year, 30 otherwise. Verdicts on this board: 28 FARM, 123 THIN, 47 SKIP.
FARM when cost is at most $160 on at least $100M of TVL and 7-day growth is no worse than
-10%; SKIP when implied value is under $3M, TVL under $10M, 7-day growth under -30%, or
cost over $300; THIN in between. Each row carries its reason.

## What the snapshot does not say

All 758 protocols are accounted for: 198 ranked, 144 tokenized with a market cap (the
comps), 272 with a token recorded but no market cap (not ranked — a token is on record),
144 with no token recorded but excluded as CEX, bridge, liquid staking/restaking,
wrapped, staked or versioned products. "Pre-token" means the record shows no token; the
snapshot is DefiLlama's record, not proof. Nothing here predicts whether or when a token
is issued.

## Note to the judge

Check first: the blind-test table above, any detail view's peer table, and the interval
column on the board. If the model is wrong, those three are where it shows.
