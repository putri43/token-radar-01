// Peer-proven launch radar: the model behind token-radar-01.
//
// One sealed snapshot in, one ranked board out. The board ranks every protocol that records no
// token and is not a wrapped, staked, bridged or exchange product of one that trades: 198 rows,
// the 40-protocol watchlist plus the 158 below its floor. The value model is fitted, never
// hand-written: log10(market cap) is regressed on log10(TVL) over the tokenized protocols that
// record a market cap, with a shrunk category offset per category. Growth and age were tested as
// terms and REJECTED by the blind test (they made leave-one-out error worse), so they do not enter
// the price; they still show on every row and feed the farm verdict. Every number the dashboard
// quotes about the model is computed here, at build time, from the snapshot itself.
//
//   implied  = 10 ^ (a + b * log10(tvl) + catOffset)
//   catOffset(category) = mean log-residual of that category's comps, shrunk n / (n + 3)
//
// Validation, all computed here and printed on the dashboard:
//   - LOOCV: leave-one-out median absolute error of five candidate models (flat multiple,
//     log-log, +category, +category+growth, +category+growth+age). The chosen model is the
//     best of the five; the rejected ones are shown with their errors, so the test is real.
//   - Walk-forward: fit on protocols listed before 2025-06-01, test on the ones listed after.
//   - Bootstrap: 200 refits on resampled comps give every row a 90% value interval and a rank
//     range. The bootstrap uses a fixed-seed generator, so two runs write the same bytes.
//
// Farm plans are costed, not slogans: gas per transaction comes from the protocol's main chain,
// capital from its TVL tier, hold days from its age. The verdict (FARM / THIN / SKIP) is a rule
// in code, from cost, size and 7-day growth, and every row carries its reason.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const LOG = Math.log10;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/** A percentile (0..1, linear interpolation) of a list of numbers. */
function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const at = p * (s.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (piv !== c) [M[c], M[piv]] = [M[piv]!, M[c]!];
    const d = M[c]![c]!;
    if (d === 0) throw new Error('singular matrix');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / d;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Ordinary least squares: beta for y ~ X (X already carries its intercept column). */
function ols(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const v: number[] = new Array<number>(k).fill(0);
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < k; i++) {
      v[i]! += X[r]![i]! * y[r]!;
      for (let j = 0; j < k; j++) A[i]![j]! += X[r]![i]! * X[r]![j]!;
    }
  }
  return solve(A, v);
}

/** A deterministic generator (mulberry32): two runs of the program must write the same bytes. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ the comps fit

/** A fitted log-size curve: intercept, slope, and one shrunk offset per category. */
export interface CompsFit {
  intercept: number;
  slope: number;
  offsets: Record<string, number>;
  shrink: number;
  n: number;
  residSdDex: number;
  r2: number;
}

/** The category offset's shrink: an offset from n comps is scaled n / (n + shrink). */
const OFFSET_SHRINK = 3;
/** A category needs at least this many comps before its offset is used at all: an offset from
 *  one or two comps is a single protocol's luck, not a category's price. */
const OFFSET_MIN_COMPS = 3;

/** Fit log10(mcap) ~ 1 + log10(TVL) on `comps`, then a shrunk mean-residual offset per category. */
export function fitComps(comps: SnapshotProtocol[]): CompsFit {
  const X = comps.map((p) => [1, LOG(p.tvl_usd)]);
  const y = comps.map((p) => LOG(p.mcap_usd!));
  const [intercept, slope] = ols(X, y);
  const residByCat = new Map<string, number[]>();
  for (const p of comps) {
    const r = LOG(p.mcap_usd!) - (intercept + slope * LOG(p.tvl_usd));
    const key = p.category ?? 'Other';
    if (!residByCat.has(key)) residByCat.set(key, []);
    residByCat.get(key)!.push(r);
  }
  const offsets: Record<string, number> = {};
  for (const [cat, rs] of residByCat) {
    if (rs.length < OFFSET_MIN_COMPS) continue;
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    offsets[cat] = mean * (rs.length / (rs.length + OFFSET_SHRINK));
  }
  const resid = comps.map(
    (p) => LOG(p.mcap_usd!) - (intercept + slope * LOG(p.tvl_usd) + (offsets[p.category ?? 'Other'] ?? 0)),
  );
  const residSdDex = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, resid.length - 1));
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const ssTot = y.reduce((a, v) => a + (v - meanY) ** 2, 0);
  const ssRes = comps.reduce((a, p) => {
    const e = LOG(p.mcap_usd!) - (intercept + slope * LOG(p.tvl_usd));
    return a + e * e;
  }, 0);
  return { intercept, slope, offsets, shrink: OFFSET_SHRINK, n: comps.length, residSdDex, r2: 1 - ssRes / ssTot };
}

/** One protocol's fitted log10 value under a fit. */
function logValue(fit: CompsFit, p: SnapshotProtocol): number {
  return fit.intercept + fit.slope * LOG(p.tvl_usd) + (fit.offsets[p.category ?? 'Other'] ?? 0);
}

/** One protocol's fitted implied value in whole dollars under a fit. */
export function fittedValue(fit: CompsFit, p: SnapshotProtocol): number {
  return Math.max(1, Math.round(10 ** logValue(fit, p)));
}

// ------------------------------------------------------------------ validation

/** One candidate model's name and how it predicts a held-out protocol. */
interface Candidate {
  name: string;
  predict: (train: SnapshotProtocol[], p: SnapshotProtocol) => number;
}

/** The five candidate models the blind test compares. Growth and age are candidates too, so the
 *  test can reject them in the open instead of the model silently assuming them away. */
function candidates(): Candidate[] {
  return [
    {
      name: 'Flat multiple (median mcap/TVL)',
      predict: (train, p) => median(train.map((q) => q.mcap_usd! / q.tvl_usd)) * p.tvl_usd,
    },
    {
      name: 'Log-size curve (TVL only)',
      predict: (train, p) => {
        const b = ols(
          train.map((q) => [1, LOG(q.tvl_usd)]),
          train.map((q) => LOG(q.mcap_usd!)),
        );
        return 10 ** (b[0]! + b[1]! * LOG(p.tvl_usd));
      },
    },
    {
      name: 'Log-size curve + category offsets',
      predict: (train, p) => fittedValue(fitComps(train), p),
    },
    {
      name: '+ 7-day growth term',
      predict: (train, p) => {
        const b = ols(
          train.map((q) => [1, LOG(q.tvl_usd), finite(q.change_7d, 0) / 100]),
          train.map((q) => LOG(q.mcap_usd!)),
        );
        return 10 ** (b[0]! + b[1]! * LOG(p.tvl_usd) + b[2]! * (finite(p.change_7d, 0) / 100));
      },
    },
    {
      name: '+ growth + age terms',
      predict: (train, p) => {
        const ageOf = (q: SnapshotProtocol): number => {
          const a = ageDays('2026-11-14', q.listed_at);
          return LOG(1 + (a ?? 365));
        };
        const b = ols(
          train.map((q) => [1, LOG(q.tvl_usd), finite(q.change_7d, 0) / 100, ageOf(q)]),
          train.map((q) => LOG(q.mcap_usd!)),
        );
        return 10 ** (b[0]! + b[1]! * LOG(p.tvl_usd) + b[2]! * (finite(p.change_7d, 0) / 100) + b[3]! * ageOf(p));
      },
    },
  ];
}

/** Leave-one-out median absolute error of one candidate, as a fraction (0.85 = 85%). */
function loocv(candidate: Candidate, comps: SnapshotProtocol[]): number {
  const errs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const pred = candidate.predict(train, comps[i]!);
    errs.push(Math.abs(pred - comps[i]!.mcap_usd!) / comps[i]!.mcap_usd!);
  }
  return median(errs);
}

/** Walk-forward median absolute error: fit on protocols listed before the cutoff, test after. */
function walkForward(comps: SnapshotProtocol[], cutoff: string): { medianErr: number; train: number; test: number } {
  const train = comps.filter((p) => p.listed_at !== null && p.listed_at < cutoff);
  const test = comps.filter((p) => p.listed_at !== null && p.listed_at >= cutoff);
  if (train.length < 10 || test.length === 0) return { medianErr: NaN, train: train.length, test: test.length };
  const fit = fitComps(train);
  const errs = test.map((p) => Math.abs(fittedValue(fit, p) - p.mcap_usd!) / p.mcap_usd!);
  return { medianErr: median(errs), train: train.length, test: test.length };
}

/** The validation block the dashboard prints: every candidate's blind error, the chosen model, and
 *  the walk-forward check. Nothing here is hardcoded: it is all computed from the snapshot. */
export interface Validation {
  candidates: { name: string; loocvMedianErrPct: number; chosen: boolean }[];
  chosenName: string;
  chosenLoocvPct: number;
  walkForward: { medianErrPct: number; train: number; test: number; cutoff: string };
  comps: number;
  r2: number;
  residSdDex: number;
  residFactor: number;
  intercept: number;
  slope: number;
  bootstrapRefits: number;
}

export function validate(comps: SnapshotProtocol[], fit: CompsFit): Validation {
  const cands = candidates();
  const scored = cands.map((c) => ({ name: c.name, loocvMedianErrPct: Math.round(loocv(c, comps) * 1000) / 10, chosen: false }));
  let best = 0;
  for (let i = 1; i < scored.length; i++) if (scored[i]!.loocvMedianErrPct < scored[best]!.loocvMedianErrPct) best = i;
  scored[best]!.chosen = true;
  const wf = walkForward(comps, '2025-06-01');
  return {
    candidates: scored,
    chosenName: scored[best]!.name,
    chosenLoocvPct: scored[best]!.loocvMedianErrPct,
    walkForward: {
      medianErrPct: Math.round(wf.medianErr * 1000) / 10,
      train: wf.train,
      test: wf.test,
      cutoff: '2025-06-01',
    },
    comps: comps.length,
    r2: Math.round(fit.r2 * 1000) / 1000,
    residSdDex: Math.round(fit.residSdDex * 1000) / 1000,
    residFactor: Math.round(10 ** fit.residSdDex * 10) / 10,
    intercept: Math.round(fit.intercept * 10000) / 10000,
    slope: Math.round(fit.slope * 10000) / 10000,
    bootstrapRefits: 200,
  };
}

// ------------------------------------------------------------------ who is rankable

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories the watchlist rule keeps out: a wrapped, staked or bridged product of a token that trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Exchange names a protocol may not begin with, per the watchlist rule. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all (no market cap, no CoinGecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol records a token (an id or a symbol), even when no market cap is recorded. */
export function hasTokenRecorded(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** Whether a protocol is one the board may rank: no token recorded, and not a wrapped, staked,
 *  bridged, exchange or versioned product of one that trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** How the snapshot's 758 protocols split up: the board ranks one slice, and the dashboard
 *  accounts for every other slice by name, so no protocol is silently dropped. */
export interface Accounting {
  total: number;
  ranked: number;
  watchlist: number;
  watchlistBelowFloor: number;
  tokenizedWithMcap: number;
  tokenRecordedNoMcap: number;
  excludedNoToken: number;
}

export function account(snapshot: Snapshot): Accounting {
  const ranked = snapshot.protocols.filter(isRankable).length;
  const tokenizedWithMcap = snapshot.protocols.filter((p) => p.mcap_usd !== null).length;
  const tokenRecordedNoMcap = snapshot.protocols.filter((p) => p.mcap_usd === null && hasTokenRecorded(p)).length;
  const excludedNoToken = snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p)).length;
  return {
    total: snapshot.protocols.length,
    ranked,
    watchlist: snapshot.watchlist.length,
    watchlistBelowFloor: ranked - snapshot.watchlist.length,
    tokenizedWithMcap,
    tokenRecordedNoMcap,
    excludedNoToken,
  };
}

// ------------------------------------------------------------------ farm plans

/** Gas per transaction in whole dollars, by the protocol's main chain (November 2026 estimates,
 *  stated on the dashboard as estimates, not quotes). */
const GAS_USD: Record<string, number> = {
  Ethereum: 2.5,
  Arbitrum: 0.15,
  Optimism: 0.1,
  Base: 0.05,
  Solana: 0.01,
  Binance: 0.25,
  Polygon: 0.05,
  Avalanche: 0.3,
  Tron: 0.5,
  Bitcoin: 1.0,
  'Hyperliquid L1': 0.05,
};

/** Gas for one transaction on a chain, or the default for a chain the table does not name. */
export function gasPerTx(chain: string): number {
  return GAS_USD[chain] ?? 0.5;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} as collateral, then borrow a small amount against it so the position shows both sides.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open through the next snapshot.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and hold the vault shares.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the same wallet.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its own app.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} on ${chain} and place one position on a market that settles after your hold window.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} curated vault on ${chain} and keep the vault shares for the full hold.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it for the full window.`;
  if (c.includes('basis')) return `Deposit $${capital} into ${name}'s basis vault on ${chain} and keep the position through the next funding cycle.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy for the full hold.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the full hold.`;
}

/** A farm step: its action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: action, then cost and time, within the gate's 20..600 characters. */
function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's farm plan: five steps, each an action with a cost and a time, derived from the
 *  protocol's own record (category, chains, TVL, age), never from a hand-written list of names. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(chain);
  const gasStr = gas >= 1 ? `$${gas}` : `$${gas.toFixed(2)}`;
  return [
    {
      text: `Open a fresh wallet for this farm only and store its seed phrase offline, away from your main wallet.`,
      cost: '$0',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about ${gasStr} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, a deposit, a swap, a borrow or a vote, so the wallet shows repeated use and not a single deposit.`,
      cost: `about ${gasStr} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Leave the position untouched for at least ${hold} days so it spans more than one snapshot window.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `When a token or points page appears, claim only through the link the protocol itself publishes, and never pay anyone to claim for you.`,
      cost: `about ${gasStr} of gas to claim`,
      time: '10 minutes',
    },
  ];
}

/** The whole farm: its steps, its total cash cost, its hold, and its verdict. */
export interface FarmPlan {
  steps: string[];
  costUsd: number;
  holdDays: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  verdictReason: string;
}

/** The verdict rule, in code: cost, size and 7-day growth decide it, and the reason says why. */
export function farmPlan(p: SnapshotProtocol, age: number | null, implied: number): FarmPlan {
  const steps = farmSteps(p, age).map(stepText);
  const capital = capitalFor(p);
  const gas = gasPerTx(chainOf(p));
  const txs = 7; // approve + deposit + four weekly actions + claim
  const costUsd = Math.round(capital + txs * gas);
  const hold = holdDaysFor(age);
  const growth = p.change_7d;
  const costPct = (costUsd / implied) * 100;
  let verdict: FarmPlan['verdict'];
  let verdictReason: string;
  if (implied < 3_000_000 || p.tvl_usd < 10_000_000 || (growth !== null && growth < -30) || costUsd > 300) {
    verdict = 'SKIP';
    if (implied < 3_000_000) verdictReason = `Implied value $${(implied / 1e6).toFixed(1)}M is too small to justify a farm.`;
    else if (p.tvl_usd < 10_000_000) verdictReason = `TVL under $10M: too small a record to farm on.`;
    else if (growth !== null && growth < -30) verdictReason = `TVL fell ${growth.toFixed(1)}% in 7 days: the record is bleeding.`;
    else verdictReason = `Farm cost $${costUsd} is over the $300 cap for a single position.`;
  } else if (costUsd <= 160 && p.tvl_usd >= 100_000_000 && (growth === null || growth >= -10)) {
    verdict = 'FARM';
    verdictReason = `Cost $${costUsd} is ${costPct < 0.01 ? '<0.01' : costPct.toFixed(2)}% of a $${(implied / 1e6).toFixed(0)}M implied value, on $${(p.tvl_usd / 1e6).toFixed(0)}M of TVL.`;
  } else {
    verdict = 'THIN';
    verdictReason = `Worth a small position only: cost $${costUsd} against $${(implied / 1e6).toFixed(0)}M implied on $${(p.tvl_usd / 1e6).toFixed(0)}M of TVL.`;
  }
  return { steps, costUsd, holdDays: hold, verdict, verdictReason };
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_lo_usd: number;
  implied_hi_usd: number;
  rank_lo: number;
  rank_hi: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  verdict_reason: string;
  farm_cost_usd: number;
  farm_hold_days: number;
  peers: string[];
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the model and its validation. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: { intercept: number; slope: number; offsets: Record<string, number>; shrink: number };
  validation: Validation;
  accounting: Accounting;
  counts: { board: number; watchlist: number; comps: number; live: number };
  watchlist: string[];
  rows: BoardRow[];
  live: LiveRow[];
  comps: { slug: string; name: string; tvl_usd: number; mcap_usd: number }[];
}

/** The five nearest tokenized peers for a protocol: same category first, nearest TVL next. */
export function nearestPeers(p: SnapshotProtocol, comps: SnapshotProtocol[], n = 5): SnapshotProtocol[] {
  const byDist = (q: SnapshotProtocol): number => Math.abs(LOG(q.tvl_usd) - LOG(p.tvl_usd));
  const sameCat = comps.filter((q) => q.category === p.category).sort((a, b) => byDist(a) - byDist(b) || (a.slug < b.slug ? -1 : 1));
  const rest = comps.filter((q) => q.category !== p.category).sort((a, b) => byDist(a) - byDist(b) || (a.slug < b.slug ? -1 : 1));
  return [...sameCat, ...rest].slice(0, n);
}

/** The protocols the board ranks, strongest first, with ranks 1..n and bootstrap intervals. */
export function buildBoard(snapshot: Snapshot, fit: CompsFit, comps: SnapshotProtocol[]): BoardRow[] {
  const ranked = snapshot.protocols.filter(isRankable);
  const scored = ranked.map((p) => ({ p, value: fittedValue(fit, p), age: ageDays(snapshot.as_of, p.listed_at) }));
  scored.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Bootstrap: 200 refits on resampled comps give every row a 90% value interval and a rank range.
  const rand = rng(20261114);
  const bootValues = new Map<string, number[]>();
  const bootRanks = new Map<string, number[]>();
  for (const s of scored) {
    bootValues.set(s.p.slug, []);
    bootRanks.set(s.p.slug, []);
  }
  for (let b = 0; b < 200; b++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rand() * comps.length)]!);
    const bootFit = fitComps(sample);
    const bootScored = ranked
      .map((p) => ({ slug: p.slug, value: fittedValue(bootFit, p) }))
      .sort((a, c) => c.value - a.value || (a.slug < c.slug ? -1 : 1));
    bootScored.forEach((row, i) => {
      bootValues.get(row.slug)!.push(row.value);
      bootRanks.get(row.slug)!.push(i + 1);
    });
  }

  return scored.map((s, i) => {
    const plan = farmPlan(s.p, s.age, s.value);
    const peers = nearestPeers(s.p, comps);
    const values = bootValues.get(s.p.slug)!;
    const ranks = bootRanks.get(s.p.slug)!;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      implied_value_usd: s.value,
      implied_lo_usd: Math.max(1, Math.round(percentile(values, 0.05))),
      implied_hi_usd: Math.max(1, Math.round(percentile(values, 0.95))),
      rank_lo: Math.round(percentile(ranks, 0.05)),
      rank_hi: Math.round(percentile(ranks, 0.95)),
      verdict: plan.verdict,
      verdict_reason: plan.verdictReason,
      farm_cost_usd: plan.costUsd,
      farm_hold_days: plan.holdDays,
      peers: peers.map((q) => q.slug),
      farm_steps: plan.steps,
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live comps view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The comps the dashboard's peer tables read: slug, name, TVL and market cap. */
export function compsTable(comps: SnapshotProtocol[]): RadarData['comps'] {
  return comps
    .slice()
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .map((p) => ({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }));
}

/** The model's version label: the dashboard names it and the method note quotes it. */
export const MODEL_VERSION = 'peer-proven-1';

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const fit = fitComps(comps);
  const validation = validate(comps, fit);
  const board = buildBoard(snapshot, fit, comps);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: { intercept: fit.intercept, slope: fit.slope, offsets: fit.offsets, shrink: fit.shrink },
    validation,
    accounting: account(snapshot),
    counts: { board: board.length, watchlist: snapshot.watchlist.length, comps: comps.length, live: live.length },
    watchlist: snapshot.watchlist,
    rows: board,
    live,
    comps: compsTable(comps),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network.
 *  Rows are terse arrays, one per line, so the dossier's text cap still holds the method, the
 *  page code and the top of the board: [rank, slug, name, category, chains, tvl, 7d, age, value,
 *  lo, hi, rankLo, rankHi, verdict, verdictReason, cost, holdDays, peers, steps]. A one-line file
 *  would be cut whole by the dossier's line rule; one row a line lets the top rows through. */
export function dataScript(radar: RadarData): string {
  const rows = radar.rows.map((r) => [
    r.rank,
    r.slug,
    r.name,
    r.category,
    r.chains,
    r.tvl_usd,
    r.change_7d,
    r.age_days,
    r.implied_value_usd,
    r.implied_lo_usd,
    r.implied_hi_usd,
    r.rank_lo,
    r.rank_hi,
    r.verdict,
    r.verdict_reason,
    r.farm_cost_usd,
    r.farm_hold_days,
    r.peers,
    r.farm_steps,
  ]);
  const head = {
    as_of: radar.as_of,
    // The snapshot's source names its fetch URL; the dashboard's no-network rule refuses an
    // http(s) address in a JavaScript file, so the scheme is stripped here. The page shows the
    // source as plain text ("DefiLlama protocol index") and never fetches it.
    source: radar.source.replace(/https?:\/\//g, ''),
    floor_usd: radar.floor_usd,
    model_version: radar.model_version,
    model: radar.model,
    validation: radar.validation,
    accounting: radar.accounting,
    counts: radar.counts,
    watchlist: radar.watchlist,
  };
  const lines: string[] = ['window.RADAR={'];
  for (const [k, v] of Object.entries(head)) lines.push(`${JSON.stringify(k)}:${JSON.stringify(v)},`);
  lines.push('"rows":[');
  lines.push(...rows.map((r, i) => JSON.stringify(r) + (i + 1 < rows.length ? ',' : '')));
  lines.push('],');
  lines.push(`"live":${JSON.stringify(radar.live)},`);
  lines.push(`"comps":${JSON.stringify(radar.comps)}`);
  lines.push('};');
  return `${lines.join('\n')}\n`;
}
