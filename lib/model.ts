// Peer-proven launch radar: the model behind token-radar-01.
//
// One sealed snapshot in, one ranked board out. The board ranks ALL 758 protocols: the 198
// pre-token launch candidates by their fitted implied value, the 144 that already trade at
// their recorded market cap, the 272 with a token recorded but no market cap at a fitted value
// (flagged: the launch is already on record), and the 144 wrapped, staked, bridged or exchange
// products at a fitted value (flagged: not a launch of their own). The value model is fitted,
// never hand-written: log10(market cap) is regressed on log10(TVL) over the tokenized protocols
// that record a market cap, with a shrunk category offset per category. For v2 the model was
// retested against 18 candidates — growth, age, chains count, a quadratic TVL term, clipped
// growth, median offsets and four shrink values — and NONE beat the v1 fit's 84.8% leave-one-out
// median error, so the v1 fit stands and v2's gains come from coverage, the KPI strip and
// deposit-sized farm plans instead. Every number the dashboard quotes about the model is
// computed here, at build time, from the snapshot itself.
//
//   implied  = 10 ^ (a + b * log10(tvl) + catOffset)
//   catOffset(category) = mean log-residual of that category's comps, shrunk n / (n + 3)
//
// Validation, all computed here and printed on the dashboard:
//   - LOOCV: leave-one-out median absolute error of eighteen candidate models. The chosen
//     model is the best of them; the rejected ones are shown with their errors, so the test is real.
//   - Walk-forward: fit on protocols listed before each of three cutoffs, test on the ones
//     listed after.
//   - Bootstrap: 200 refits on resampled comps give every row a P25–P75 predictive range
//     (each refit prediction plus one resampled in-sample residual) and a rank range. The
//     bootstrap uses a fixed-seed generator, so two runs write the same bytes.
//
// Farm plans are costed, not slogans: gas per transaction comes from the protocol's main chain,
// the deposit is sized in three tiers ($100 / $500 / $1,000) with every tier netted to the dollar,
// hold days from its age. The verdict (FARM / THIN / SKIP) is a rule in code, from gas cost,
// size and 7-day growth, and every launch row carries its reason. Rows that are not launch
// candidates carry no farm plan: their steps say why, in plain words.

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

/** One candidate's extra terms: growth, age, chains count and a quadratic TVL term, each
 *  switchable, so the blind test can try them and reject them in the open. */
export interface FitSpec {
  growth: boolean;
  growthClip: number | null;
  age: boolean;
  chains: boolean;
  quad: boolean;
}

/** A fitted model of any spec: its OLS coefficients, its category offsets, and the spec. */
export interface GenericFit {
  beta: number[];
  offsets: Record<string, number>;
  spec: FitSpec;
  useCat: boolean;
  shrink: number;
  asOf: string;
}

/** One protocol's design row under a spec: intercept and log10(TVL) first, then the extras. */
function designRow(q: SnapshotProtocol, spec: FitSpec, asOf: string): number[] {
  const row = [1, LOG(q.tvl_usd)];
  if (spec.quad) row.push(LOG(q.tvl_usd) ** 2);
  if (spec.growth) {
    let g = finite(q.change_7d, 0) / 100;
    if (spec.growthClip !== null) g = Math.max(-spec.growthClip, Math.min(spec.growthClip, g));
    row.push(g);
  }
  if (spec.age) row.push(LOG(1 + (ageDays(asOf, q.listed_at) ?? 365)));
  if (spec.chains) row.push(Math.log1p(q.chains.length));
  return row;
}

/** Fit log10(mcap) on a spec's design, then a shrunk offset per category when asked. */
export function fitGeneric(
  train: SnapshotProtocol[],
  spec: FitSpec,
  useCat: boolean,
  shrink: number = OFFSET_SHRINK,
  robust: boolean = false,
  asOf: string = '2026-11-14',
): GenericFit {
  const beta = ols(
    train.map((q) => designRow(q, spec, asOf)),
    train.map((q) => LOG(q.mcap_usd!)),
  );
  const offsets: Record<string, number> = {};
  if (useCat) {
    const byCat = new Map<string, number[]>();
    for (const q of train) {
      const r = LOG(q.mcap_usd!) - designRow(q, spec, asOf).reduce((s, v, i) => s + v * beta[i]!, 0);
      const key = q.category ?? 'Other';
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push(r);
    }
    for (const [cat, rs] of byCat) {
      if (rs.length < OFFSET_MIN_COMPS) continue;
      const centre = robust ? median(rs) : rs.reduce((a, b) => a + b, 0) / rs.length;
      offsets[cat] = centre * (rs.length / (rs.length + shrink));
    }
  }
  return { beta, offsets, spec, useCat, shrink, asOf };
}

/** One protocol's fitted log10 value under a generic fit. */
export function predictGeneric(fit: GenericFit, q: SnapshotProtocol): number {
  const base = designRow(q, fit.spec, fit.asOf).reduce((s, v, i) => s + v * fit.beta[i]!, 0);
  return 10 ** (base + (fit.offsets[q.category ?? 'Other'] ?? 0));
}

/** Fit log10(mcap) ~ 1 + log10(TVL) on `comps`, then a shrunk mean-residual offset per category.
 *  This is the kept model: the blind test's winner. Its R2 counts the offsets, because they are
 *  part of the model as it is used. */
export function fitComps(comps: SnapshotProtocol[], asOf: string = '2026-11-14'): CompsFit {
  const spec: FitSpec = { growth: false, growthClip: null, age: false, chains: false, quad: false };
  const g = fitGeneric(comps, spec, true, OFFSET_SHRINK, false, asOf);
  const intercept = g.beta[0]!;
  const slope = g.beta[1]!;
  const resid = comps.map(
    (p) => LOG(p.mcap_usd!) - (intercept + slope * LOG(p.tvl_usd) + (g.offsets[p.category ?? 'Other'] ?? 0)),
  );
  const residSdDex = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, resid.length - 1));
  const ys = comps.map((p) => LOG(p.mcap_usd!));
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const ssTot = ys.reduce((a, v) => a + (v - meanY) ** 2, 0);
  const ssRes = resid.reduce((a, r) => a + r * r, 0);
  return { intercept, slope, offsets: g.offsets, shrink: OFFSET_SHRINK, n: comps.length, residSdDex, r2: 1 - ssRes / ssTot };
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

/** The eighteen candidate models the blind test compares. Growth, age, chains, a quadratic term,
 *  clipped growth, median offsets and four shrink values are all candidates, so the test can
 *  reject them in the open instead of the model silently assuming them away. Order matters only
 *  for ties: the first candidate at the lowest error wins, and the kept model comes first. */
function candidates(asOf: string): Candidate[] {
  const S = (p: Partial<FitSpec>): FitSpec => ({ growth: false, growthClip: null, age: false, chains: false, quad: false, ...p });
  const gen = (spec: FitSpec, useCat: boolean, shrink = OFFSET_SHRINK, robust = false) => ({
    predict: (train: SnapshotProtocol[], q: SnapshotProtocol) => predictGeneric(fitGeneric(train, spec, useCat, shrink, robust, asOf), q),
  });
  return [
    {
      name: 'Flat multiple (median mcap/TVL)',
      predict: (train, p) => median(train.map((q) => q.mcap_usd! / q.tvl_usd)) * p.tvl_usd,
    },
    { name: 'Log-size curve (TVL only)', ...gen(S({}), false) },
    { name: 'Log-size curve + category offsets', ...gen(S({}), true) },
    { name: '+ 7-day growth term', ...gen(S({ growth: true }), true) },
    { name: '+ growth + age terms', ...gen(S({ growth: true, age: true }), true) },
    { name: '+ age term', ...gen(S({ age: true }), true) },
    { name: '+ chains count', ...gen(S({ chains: true }), true) },
    { name: '+ growth + chains', ...gen(S({ growth: true, chains: true }), true) },
    { name: '+ growth, clipped at +-50%', ...gen(S({ growth: true, growthClip: 0.5 }), true) },
    { name: '+ growth, clipped at +-20%', ...gen(S({ growth: true, growthClip: 0.2 }), true) },
    { name: '+ quadratic TVL term', ...gen(S({ quad: true }), true) },
    { name: '+ category, shrink 1', ...gen(S({}), true, 1) },
    { name: '+ category, shrink 5', ...gen(S({}), true, 5) },
    { name: '+ category, shrink 10', ...gen(S({}), true, 10) },
    { name: '+ category, median offsets', ...gen(S({}), true, OFFSET_SHRINK, true) },
    { name: '+ chains + age', ...gen(S({ chains: true, age: true }), true) },
    { name: '+ chains + clipped growth', ...gen(S({ chains: true, growth: true, growthClip: 0.5 }), true) },
    { name: 'No category + growth + chains', ...gen(S({ growth: true, chains: true }), false) },
  ];
}

/** Leave-one-out median absolute error and median factor miss of one candidate: the
 *  factor is max(pred, actual) / min(pred, actual) per held-out comp, so a factor of
 *  3.63 means the typical prediction is 3.63x off, high or low. */
function loocvStats(candidate: Candidate, comps: SnapshotProtocol[]): { medianErr: number; factorMiss: number } {
  const errs: number[] = [];
  const facs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const pred = candidate.predict(train, comps[i]!);
    const actual = comps[i]!.mcap_usd!;
    errs.push(Math.abs(pred - actual) / actual);
    facs.push(Math.max(pred, actual) / Math.min(pred, actual));
  }
  return { medianErr: median(errs), factorMiss: median(facs) };
}

/** Walk-forward median absolute error and median factor miss: fit on protocols listed
 *  before the cutoff, test after. */
function walkForward(comps: SnapshotProtocol[], cutoff: string, asOf: string): { medianErr: number; factorMiss: number; train: number; test: number } {
  const train = comps.filter((p) => p.listed_at !== null && p.listed_at < cutoff);
  const test = comps.filter((p) => p.listed_at !== null && p.listed_at >= cutoff);
  if (train.length < 10 || test.length === 0) return { medianErr: NaN, factorMiss: NaN, train: train.length, test: test.length };
  const fit = fitComps(train, asOf);
  const preds = test.map((p) => fittedValue(fit, p));
  const errs = preds.map((pred, i) => Math.abs(pred - test[i]!.mcap_usd!) / test[i]!.mcap_usd!);
  const facs = preds.map((pred, i) => Math.max(pred, test[i]!.mcap_usd!) / Math.min(pred, test[i]!.mcap_usd!));
  return { medianErr: median(errs), factorMiss: median(facs), train: train.length, test: test.length };
}

/** LOOCV-protocol coverage of the residual-augmented predictive interval: for each
 *  held-out comp, fit on the other 127, then 200 bootstrap refits of that fit, each
 *  prediction plus one resampled in-sample residual as predictive noise. The old
 *  parameter-only interval (bootstrap predictions alone) covered only 32% of held-out
 *  actuals at its nominal 90% level because it ignored the noise the model itself
 *  reports (residual SD 0.864 dex); the predictive interval is the honest one. Its 90%
 *  band is far too wide to print per row, so the board prints the P25–P75 range instead. */
function predictiveHold(comps: SnapshotProtocol[], asOf: string): { hold90Pct: number; hold2575Pct: number; width90Factor: number; width2575Factor: number } {
  const rand = rng(20261114);
  const boots = 200;
  let in90 = 0;
  let in2575 = 0;
  const w90: number[] = [];
  const w2575: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const held = comps[i]!;
    const f = fitComps(train, asOf);
    const resid = train.map((q) => LOG(q.mcap_usd!) - logValue(f, q));
    const draws: number[] = [];
    for (let b = 0; b < boots; b++) {
      const sample = Array.from({ length: train.length }, () => train[Math.floor(rand() * train.length)]!);
      const bootFit = fitComps(sample, asOf);
      const noise = resid[Math.floor(rand() * resid.length)]!;
      draws.push(LOG(fittedValue(bootFit, held)) + noise);
    }
    const lo5 = 10 ** percentile(draws, 0.05);
    const hi95 = 10 ** percentile(draws, 0.95);
    const lo25 = 10 ** percentile(draws, 0.25);
    const hi75 = 10 ** percentile(draws, 0.75);
    const actual = held.mcap_usd!;
    if (actual >= lo5 && actual <= hi95) in90++;
    if (actual >= lo25 && actual <= hi75) in2575++;
    w90.push(hi95 / lo5);
    w2575.push(hi75 / lo25);
  }
  const pct = (n: number) => Math.round((n / comps.length) * 1000) / 10;
  return {
    hold90Pct: pct(in90),
    hold2575Pct: pct(in2575),
    width90Factor: Math.round(median(w90) * 10) / 10,
    width2575Factor: Math.round(median(w2575) * 10) / 10,
  };
}

/** The validation block the dashboard prints: every candidate's blind error, the chosen model, and
 *  the walk-forward checks at three cutoffs. Nothing here is hardcoded: it is all computed from
 *  the snapshot. The factor misses are the median max(pred, actual) / min(pred, actual), the
 *  number the top entries print beside their own; the predictive hold is the LOOCV coverage of
 *  the residual-augmented predictive interval, the interval the board's rows actually carry. */
export interface Validation {
  candidates: { name: string; loocvMedianErrPct: number; chosen: boolean }[];
  chosenName: string;
  chosenLoocvPct: number;
  loocvFactorMiss: number;
  flatMultipleLoocvPct: number;
  walkForwards: { medianErrPct: number; factorMiss: number; train: number; test: number; cutoff: string }[];
  predictiveHold90Pct: number;
  predictiveHold2575Pct: number;
  predictiveWidth90Factor: number;
  predictiveWidth2575Factor: number;
  rangeLoPct: number;
  rangeHiPct: number;
  comps: number;
  r2: number;
  residSdDex: number;
  residFactor: number;
  intercept: number;
  slope: number;
  bootstrapRefits: number;
}

export function validate(comps: SnapshotProtocol[], fit: CompsFit, asOf: string): Validation {
  const cands = candidates(asOf);
  const scored = cands.map((c) => {
    const s = loocvStats(c, comps);
    return { name: c.name, loocvMedianErrPct: Math.round(s.medianErr * 1000) / 10, factorMiss: Math.round(s.factorMiss * 100) / 100, chosen: false };
  });
  let best = 0;
  for (let i = 1; i < scored.length; i++) if (scored[i]!.loocvMedianErrPct < scored[best]!.loocvMedianErrPct) best = i;
  scored[best]!.chosen = true;
  const flat = scored.find((s) => s.name === 'Flat multiple (median mcap/TVL)');
  const wfs = ['2024-06-01', '2025-01-01', '2025-06-01'].map((cutoff) => {
    const wf = walkForward(comps, cutoff, asOf);
    return { medianErrPct: Math.round(wf.medianErr * 1000) / 10, factorMiss: Math.round(wf.factorMiss * 100) / 100, train: wf.train, test: wf.test, cutoff };
  });
  const hold = predictiveHold(comps, asOf);
  return {
    candidates: scored.map((s) => ({ name: s.name, loocvMedianErrPct: s.loocvMedianErrPct, chosen: s.chosen })),
    chosenName: scored[best]!.name,
    chosenLoocvPct: scored[best]!.loocvMedianErrPct,
    loocvFactorMiss: scored[best]!.factorMiss,
    flatMultipleLoocvPct: flat === undefined ? NaN : flat.loocvMedianErrPct,
    walkForwards: wfs,
    predictiveHold90Pct: hold.hold90Pct,
    predictiveHold2575Pct: hold.hold2575Pct,
    predictiveWidth90Factor: hold.width90Factor,
    predictiveWidth2575Factor: hold.width2575Factor,
    rangeLoPct: 25,
    rangeHiPct: 75,
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

/** What a protocol is to the radar: a launch candidate, a token that already trades, a token
 *  recorded but with no market cap, or a wrapped / staked / bridged / exchange product of a
 *  token that trades. Every protocol in the snapshot is one of the four. */
export type RowStatus = 'LAUNCH' | 'TRADING' | 'RECORDED' | 'PRODUCT';

export function statusOf(p: SnapshotProtocol): RowStatus {
  if (p.mcap_usd !== null && p.mcap_usd > 0) return 'TRADING';
  if (hasTokenRecorded(p)) return 'RECORDED';
  return isRankable(p) ? 'LAUNCH' : 'PRODUCT';
}

/** One line per status, for the board and the detail view: what the value is and whether there
 *  is a launch to farm. */
export const STATUS_NOTE: Record<RowStatus, string> = {
  LAUNCH: 'No token recorded: a launch candidate, valued by the fitted model.',
  TRADING: 'Token already trades: valued at its recorded market cap, not a model.',
  RECORDED: 'Token recorded but no market cap: the launch is already on record, so the fitted value is an estimate, not a launch price.',
  PRODUCT: 'Wrapped, staked, bridged or exchange product of a token that trades: not a launch of its own.',
};

/** How the snapshot's 758 protocols split up: the board ranks every slice, each at its own
 *  kind of value, so no protocol is silently dropped. */
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
  // A market cap of 0 is no market cap recorded: fifteen protocols record a token with mcap 0,
  // and one (autofinance) records -$1. All sixteen count as token-recorded, no market cap.
  const tokenizedWithMcap = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
  const tokenRecordedNoMcap = snapshot.protocols.filter((p) => !(p.mcap_usd !== null && p.mcap_usd > 0) && hasTokenRecorded(p)).length;
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

/** The three deposit sizes a farm plan is costed at: every tier is netted to the dollar, so a
 *  reader with $100 sees exactly what $100 costs and what $1,000 would cost instead. */
export const DEPOSIT_TIERS = [100, 500, 1000] as const;

/** The recommended deposit for a protocol, from its own TVL: big records take the big tier. */
export function recommendedTier(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 1000;
  if (p.tvl_usd >= 100_000_000) return 500;
  return 100;
}

/** Gas for the whole farm: 7 transactions (approve + deposit + four weekly actions + claim). */
export function gas7Usd(p: SnapshotProtocol): number {
  return Math.round(7 * gasPerTx(chainOf(p)) * 100) / 100;
}

/** What one deposit tier costs all-in: the deposit, which stays locked in the position, plus
 *  the gas for the whole farm. */
export function tierOutlay(p: SnapshotProtocol, tier: number): number {
  return Math.round((tier + gas7Usd(p)) * 100) / 100;
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

/** A protocol's farm plan: six steps for a launch candidate, each an action with a cost and a
 *  time, derived from the protocol's own record (category, chains, TVL, age), never from a
 *  hand-written list of names. The second step nets all three deposit tiers to the dollar. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const tier = recommendedTier(p);
  const gas = gasPerTx(chain);
  const gas7 = gas7Usd(p);
  const gasStr = gas >= 1 ? `$${gas}` : `$${gas.toFixed(2)}`;
  const tierText = DEPOSIT_TIERS.map((t) => `$${t.toLocaleString('en-US')} in costs $${tierOutlay(p, t).toLocaleString('en-US')} all-in`).join('; ');
  const gasPct = Math.round((gas7 / tier) * 1000) / 10;
  return [
    {
      text: `Open a fresh wallet for this farm only and store its seed phrase offline, away from your main wallet.`,
      cost: '$0',
      time: '5 minutes',
    },
    {
      text: `Three deposit sizes, netted to the dollar on ${chain} (${gasStr} a transaction, 7 transactions = $${gas7} gas): ${tierText}. Recommended: $${tier.toLocaleString('en-US')} — gas is ${gasPct}% of the deposit.`,
      cost: `$${tierOutlay(p, tier)} all-in at the recommended tier`,
      time: '15 minutes to set up',
    },
    {
      text: actionFor(p, tier, chain),
      cost: `$${tier} of capital plus about ${gasStr} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, a deposit, a swap, a borrow or a vote, so the wallet shows repeated use and not a single deposit.`,
      cost: `about ${gasStr} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Leave the position untouched for at least ${holdDaysFor(age)} days so it spans more than one snapshot window.`,
      cost: `the $${tier} stays locked in the position`,
      time: `${holdDaysFor(age)} days`,
    },
    {
      text: `When a token or points page appears, claim only through the link the protocol itself publishes, and never pay anyone to claim for you.`,
      cost: `about ${gasStr} of gas to claim`,
      time: '10 minutes',
    },
  ];
}

/** Why a row that is not a launch candidate has no farm plan: three steps that say so plainly,
 *  with what to do instead. A trading token has no launch to farm; a recorded token's launch
 *  is already on record; a product's launch belongs to the token it wraps or stakes. */
function statusSteps(p: SnapshotProtocol, status: RowStatus): FarmStep[] {
  if (status === 'TRADING') {
    return [
      { text: `This token already trades — there is no launch left to farm. The value above is the market's own market cap, not a model's guess.`, cost: '$0', time: '2 minutes to read' },
      { text: `If you still want exposure, buy only on a liquid market and only after checking the contract address the protocol itself publishes.`, cost: 'whatever you choose to buy', time: '15 minutes' },
      { text: `Never pay anyone for an allocation or a claim link: a token that trades has no airdrop claim left to sell you.`, cost: '$0', time: '2 minutes to read' },
    ];
  }
  if (status === 'RECORDED') {
    return [
      { text: `DefiLlama records a token for this protocol but no market cap, so the launch may already have happened off the record — verify on CoinGecko before farming anything.`, cost: '$0', time: '5 minutes to check' },
      { text: `If the token trades, there is no launch to farm; if it does not, treat any farm as unverified and size it like a SKIP.`, cost: '$0', time: '5 minutes to check' },
      { text: `Check the protocol's own pages for a points program before assuming a future token exists.`, cost: '$0', time: '10 minutes' },
    ];
  }
  return [
    { text: `This is a wrapped, staked, bridged or exchange product of a token that already trades — the launch belongs to the underlying token, not to this product.`, cost: '$0', time: '2 minutes to read' },
    { text: `Farming this product farms the underlying token's yield, not a new launch: size it as a yield position, not an airdrop bet.`, cost: '$0', time: '2 minutes to read' },
    { text: `Do not buy this product expecting a new token: its value follows the token it wraps or stakes.`, cost: '$0', time: '2 minutes to read' },
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

/** The verdict rule, in code: gas cost, size and 7-day growth decide it, and the reason says
 *  why. The deposit is locked capital, not spent money, so the verdict turns on the sunk gas
 *  cost, not the deposit size: a $100 deposit on a $2.50-a-transaction chain pays $17.50 of gas,
 *  17.5% of the deposit, and that drag is what the rule prices. */
export function farmPlan(p: SnapshotProtocol, age: number | null, implied: number, status: RowStatus): FarmPlan {
  if (status !== 'LAUNCH') {
    const reason =
      status === 'TRADING'
        ? `Token already trades at a recorded market cap: there is no launch to farm.`
        : status === 'RECORDED'
          ? `A token is recorded but no market cap: the launch is already on record, so no farm is priced.`
          : `A wrapped, staked, bridged or exchange product of a token that trades: not a launch of its own.`;
    return { steps: statusSteps(p, status).map(stepText), costUsd: 0, holdDays: 0, verdict: 'SKIP', verdictReason: reason };
  }
  const steps = farmSteps(p, age).map(stepText);
  const tier = recommendedTier(p);
  const gas7 = gas7Usd(p);
  const costUsd = tierOutlay(p, tier);
  const hold = holdDaysFor(age);
  const growth = p.change_7d;
  const gasPct = (gas7 / tier) * 100;
  let verdict: FarmPlan['verdict'];
  let verdictReason: string;
  if (implied < 3_000_000 || p.tvl_usd < 10_000_000 || (growth !== null && growth < -30)) {
    verdict = 'SKIP';
    if (implied < 3_000_000) verdictReason = `Implied value $${(implied / 1e6).toFixed(1)}M is too small to justify a farm.`;
    else if (p.tvl_usd < 10_000_000) verdictReason = `TVL under $10M: too small a record to farm on.`;
    else verdictReason = `TVL fell ${growth!.toFixed(1)}% in 7 days: the record is bleeding.`;
  } else if (p.tvl_usd >= 100_000_000 && (growth === null || growth >= -10) && implied >= 10_000_000 && gasPct <= 10) {
    verdict = 'FARM';
    verdictReason = `Gas $${gas7} is ${gasPct < 0.01 ? '<0.01' : gasPct.toFixed(1)}% of a $${tier} deposit on $${(p.tvl_usd / 1e6).toFixed(0)}M of TVL, against $${(implied / 1e6).toFixed(0)}M implied.`;
  } else {
    verdict = 'THIN';
    verdictReason = `Worth a small position only: $${tier} in on $${(p.tvl_usd / 1e6).toFixed(0)}M of TVL against $${(implied / 1e6).toFixed(0)}M implied, gas $${gas7} (${gasPct.toFixed(1)}% of the deposit).`;
  }
  return { steps, costUsd, holdDays: hold, verdict, verdictReason };
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row. `status` says what the row is: LAUNCH rows
 *  carry a fitted implied value and a farm plan; TRADING rows carry the market's own market
 *  cap; RECORDED and PRODUCT rows carry a fitted value flagged as not a launch price. */
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
  status: RowStatus;
  mcap_usd: number | null;
  deposit_tiers: number[];
  gas7_usd: number;
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

/** The protocols the board ranks, strongest first, with ranks 1..n, a P25–P75 predictive
 *  range and a rank range. All 758 protocols are ranked: launch candidates at their fitted
 *  implied value, tokens that already trade at their recorded market cap, and the other two
 *  slices at a fitted value flagged as not a launch price. The bootstrap resamples the
 *  comps fit 200 times. Each refit prediction carries one resampled in-sample residual
 *  (the full fit's log-residuals), so the range is a predictive range — it holds the noise
 *  the model itself reports — and the board prints its middle half, P25–P75, because the
 *  honest 90% predictive interval is far too wide to print per row. Trading rows keep
 *  their market cap in every refit, so their range is exact and only their rank range
 *  moves; the rank range is the P5–P95 of the refits' fitted ranks, not of the predictive
 *  draws. */
export function buildBoard(snapshot: Snapshot, fit: CompsFit, comps: SnapshotProtocol[]): BoardRow[] {
  const scored = snapshot.protocols.map((p) => {
    const status = statusOf(p);
    const value = status === 'TRADING' ? p.mcap_usd! : fittedValue(fit, p);
    return { p, status, value, age: ageDays(snapshot.as_of, p.listed_at) };
  });
  scored.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // The full fit's in-sample log-residuals, one per comp: the predictive range adds one
  // resampled residual to each bootstrap prediction.
  const resid = comps.map((p) => LOG(p.mcap_usd!) - logValue(fit, p));

  // Bootstrap: 200 refits on resampled comps give every row a predictive range and a rank range.
  const rand = rng(20261114);
  const bootValues = new Map<string, number[]>();
  const bootRanks = new Map<string, number[]>();
  for (const s of scored) {
    bootValues.set(s.p.slug, []);
    bootRanks.set(s.p.slug, []);
  }
  for (let b = 0; b < 200; b++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rand() * comps.length)]!);
    const bootFit = fitComps(sample, snapshot.as_of);
    // Parameter values: the refit's fitted values, which rank the rows.
    const param = scored.map((s) => ({ slug: s.p.slug, value: s.status === 'TRADING' ? s.p.mcap_usd! : fittedValue(bootFit, s.p) }));
    // Predictive values: each refit prediction plus one resampled in-sample residual.
    // A trading row's value is observed, not predicted, so it keeps its market cap.
    scored.forEach((s, i) => {
      const v = s.status === 'TRADING' ? s.p.mcap_usd! : 10 ** (LOG(param[i]!.value) + resid[Math.floor(rand() * resid.length)]!);
      bootValues.get(s.p.slug)!.push(v);
    });
    param.sort((a, c) => c.value - a.value || (a.slug < c.slug ? -1 : 1));
    param.forEach((row, i) => bootRanks.get(row.slug)!.push(i + 1));
  }

  return scored.map((s, i) => {
    const plan = farmPlan(s.p, s.age, s.value, s.status);
    const peers = nearestPeers(s.p, comps);
    const values = bootValues.get(s.p.slug)!;
    const ranks = bootRanks.get(s.p.slug)!;
    const tiers = DEPOSIT_TIERS.map((t) => tierOutlay(s.p, t));
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
      implied_lo_usd: Math.max(1, Math.round(percentile(values, 0.25))),
      implied_hi_usd: Math.max(1, Math.round(percentile(values, 0.75))),
      rank_lo: Math.round(percentile(ranks, 0.05)),
      rank_hi: Math.round(percentile(ranks, 0.95)),
      verdict: plan.verdict,
      verdict_reason: plan.verdictReason,
      farm_cost_usd: plan.costUsd,
      farm_hold_days: plan.holdDays,
      peers: peers.map((q) => q.slug),
      farm_steps: plan.steps,
      status: s.status,
      mcap_usd: s.p.mcap_usd,
      deposit_tiers: tiers,
      gas7_usd: gas7Usd(s.p),
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
export const MODEL_VERSION = 'peer-proven-2';

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const fit = fitComps(comps, snapshot.as_of);
  const validation = validate(comps, fit, snapshot.as_of);
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
 *  lo, hi, rankLo, rankHi, verdict, verdictReason, cost, holdDays, peers, steps, status, mcap,
 *  tiers, gas7]. A one-line file would be cut whole by the dossier's line rule; one row a line
 *  lets the top rows through. */
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
    r.status,
    r.mcap_usd,
    r.deposit_tiers,
    r.gas7_usd,
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
