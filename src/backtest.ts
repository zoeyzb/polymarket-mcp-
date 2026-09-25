export interface HistoricalReplaySample {
  conditionId: string;
  resolvedAt: string;
  domain: string;
  actualOutcome0: 0 | 1;
  prices: Record<string, number>;
}

export interface BacktestOptions {
  horizon: string;
  threshold: number;
  trainFraction?: number;
  bufferBps?: number;
  domains?: string[];
}

export interface BacktestSlice {
  sampleCount: number;
  trades: number;
  wins: number;
  losses: number;
  hitRatePct: number | null;
  totalPnlPerDollarStake: number;
  roiPct: number | null;
  maxDrawdownPerDollarStake: number;
  startAt: string | null;
  endAt: string | null;
}

export interface ProbabilityThresholdBacktest {
  generatedAt: string;
  horizon: string;
  threshold: number;
  bufferBps: number;
  trainFraction: number;
  eligibleSamples: number;
  training: BacktestSlice;
  holdout: BacktestSlice;
  assumptions: string[];
}

function round(value: number, digits = 6) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function iso(value: string | null) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function evaluate(samples: HistoricalReplaySample[], horizon: string, threshold: number, bufferBps: number): BacktestSlice {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const sample of samples) {
    const p0 = Number(sample.prices?.[horizon]);
    if (!Number.isFinite(p0) || p0 <= 0 || p0 >= 1) continue;

    const chooseOutcome0 = p0 >= threshold;
    const chooseOutcome1 = p0 <= 1 - threshold;
    if (!chooseOutcome0 && !chooseOutcome1) continue;

    const price = chooseOutcome0 ? p0 : 1 - p0;
    if (!(price > 0 && price < 1)) continue;

    trades += 1;
    const didWin = chooseOutcome0 ? sample.actualOutcome0 === 1 : sample.actualOutcome0 === 0;
    const gross = didWin ? (1 / price) - 1 : -1;
    const executionBuffer = bufferBps / 10_000;
    const net = gross - executionBuffer;

    pnl += net;
    equity += net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (didWin) wins += 1;
    else losses += 1;
  }

  return {
    sampleCount: samples.length,
    trades,
    wins,
    losses,
    hitRatePct: trades ? round((wins / trades) * 100, 3) : null,
    totalPnlPerDollarStake: round(pnl, 6),
    roiPct: trades ? round((pnl / trades) * 100, 3) : null,
    maxDrawdownPerDollarStake: round(maxDrawdown, 6),
    startAt: samples.length ? iso(samples[0].resolvedAt) : null,
    endAt: samples.length ? iso(samples[samples.length - 1].resolvedAt) : null
  };
}

export function runProbabilityThresholdBacktest(
  rawSamples: HistoricalReplaySample[],
  options: BacktestOptions
): ProbabilityThresholdBacktest {
  const threshold = Math.max(0.5, Math.min(0.999, Number(options.threshold)));
  const trainFraction = Math.max(0.1, Math.min(0.9, Number(options.trainFraction ?? 0.7)));
  const bufferBps = Math.max(0, Math.min(5000, Number(options.bufferBps ?? 50)));
  const allowedDomains = options.domains?.length ? new Set(options.domains) : null;

  const eligible = rawSamples
    .filter(sample =>
      Boolean(sample.conditionId) &&
      Number.isFinite(Date.parse(sample.resolvedAt)) &&
      (!allowedDomains || allowedDomains.has(sample.domain)) &&
      Number.isFinite(Number(sample.prices?.[options.horizon]))
    )
    .sort((a, b) => Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt));

  const cut = eligible.length
    ? Math.max(1, Math.min(eligible.length - 1, Math.floor(eligible.length * trainFraction)))
    : 0;

  const trainingSamples = cut > 0 ? eligible.slice(0, cut) : [];
  const holdoutSamples = cut > 0 ? eligible.slice(cut) : [];

  return {
    generatedAt: new Date().toISOString(),
    horizon: options.horizon,
    threshold,
    bufferBps,
    trainFraction,
    eligibleSamples: eligible.length,
    training: evaluate(trainingSamples, options.horizon, threshold, bufferBps),
    holdout: evaluate(holdoutSamples, options.horizon, threshold, bufferBps),
    assumptions: [
      "Each replay trade risks one dollar at the historical implied probability.",
      "Execution buffer is a configurable haircut and is not a reconstruction of historical queue position, fees, or slippage.",
      "Train and holdout are split chronologically to reduce look-ahead bias.",
      "Historical performance does not guarantee future results."
    ]
  };
}

export function sweepProbabilityThresholds(
  samples: HistoricalReplaySample[],
  options: Omit<BacktestOptions, "threshold"> & { thresholds?: number[] }
) {
  const thresholds = (options.thresholds?.length ? options.thresholds : [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9])
    .map(value => Math.max(0.5, Math.min(0.999, Number(value))))
    .filter(Number.isFinite);

  return {
    generatedAt: new Date().toISOString(),
    horizon: options.horizon,
    results: thresholds.map(threshold =>
      runProbabilityThresholdBacktest(samples, { ...options, threshold })
    ),
    note:
      "Threshold sweep is a diagnostic, not a guarantee of any target win rate. Compare holdout ROI, drawdown, calibration, and sample size rather than optimizing hit rate alone."
  };
}
