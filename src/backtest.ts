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

export interface CalibratedEdgeOptions {
  horizon: string;
  trainFraction?: number;
  validationFraction?: number;
  bufferBps?: number;
  domains?: string[];
  thresholds?: number[];
  minEdgesBps?: number[];
  binSize?: number;
  minBinSamples?: number;
  minValidationTrades?: number;
  minValidationHitRatePct?: number;
  minHoldoutTrades?: number;
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

    const quotedPrice = chooseOutcome0 ? p0 : 1 - p0;
    if (!(quotedPrice > 0 && quotedPrice < 1)) continue;

    trades += 1;
    const didWin = chooseOutcome0 ? sample.actualOutcome0 === 1 : sample.actualOutcome0 === 0;
    const executionBuffer = bufferBps / 10_000;
    const executionPrice = Math.min(0.999999, quotedPrice + executionBuffer);
    const net = didWin ? (1 / executionPrice) - 1 : -1;

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
      "Execution buffer is applied as adverse price movement before payout math; it is still not a reconstruction of historical queue position, fees, or slippage.",
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


type PreparedTrade = {
  sample: HistoricalReplaySample;
  quotedPrice: number;
  didWin: boolean;
};

type CalibrationBin = {
  count: number;
  wins: number;
  avgPrice: number;
  calibratedWinProbability: number;
};

function prepareTrade(sample: HistoricalReplaySample, horizon: string, threshold: number): PreparedTrade | null {
  const p0 = Number(sample.prices?.[horizon]);
  if (!Number.isFinite(p0) || p0 <= 0 || p0 >= 1) return null;
  const chooseOutcome0 = p0 >= threshold;
  const chooseOutcome1 = p0 <= 1 - threshold;
  if (!chooseOutcome0 && !chooseOutcome1) return null;
  const quotedPrice = chooseOutcome0 ? p0 : 1 - p0;
  const didWin = chooseOutcome0 ? sample.actualOutcome0 === 1 : sample.actualOutcome0 === 0;
  return { sample, quotedPrice, didWin };
}

function binKey(price: number, binSize: number) {
  return Math.max(0, Math.min(0.999, Math.floor(price / binSize) * binSize)).toFixed(4);
}

function buildCalibration(
  samples: HistoricalReplaySample[],
  horizon: string,
  threshold: number,
  binSize: number,
  minBinSamples: number
) {
  const raw = new Map<string, { count: number; wins: number; priceSum: number }>();
  for (const sample of samples) {
    const trade = prepareTrade(sample, horizon, threshold);
    if (!trade) continue;
    const key = binKey(trade.quotedPrice, binSize);
    const current = raw.get(key) || { count: 0, wins: 0, priceSum: 0 };
    current.count += 1;
    current.wins += trade.didWin ? 1 : 0;
    current.priceSum += trade.quotedPrice;
    raw.set(key, current);
  }

  const out = new Map<string, CalibrationBin>();
  const priorWeight = 20;
  for (const [key, row] of raw.entries()) {
    if (row.count < minBinSamples) continue;
    const avgPrice = row.priceSum / row.count;
    const calibratedWinProbability =
      (row.wins + priorWeight * avgPrice) / (row.count + priorWeight);
    out.set(key, {
      count: row.count,
      wins: row.wins,
      avgPrice,
      calibratedWinProbability
    });
  }
  return out;
}

function evaluateCalibrated(
  samples: HistoricalReplaySample[],
  calibration: Map<string, CalibrationBin>,
  options: {
    horizon: string;
    threshold: number;
    minEdgeBps: number;
    bufferBps: number;
    binSize: number;
  }
): BacktestSlice {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const sample of samples) {
    const trade = prepareTrade(sample, options.horizon, options.threshold);
    if (!trade) continue;
    const calibrated = calibration.get(binKey(trade.quotedPrice, options.binSize));
    if (!calibrated) continue;

    const executionPrice = Math.min(0.999999, trade.quotedPrice + options.bufferBps / 10_000);
    const expectedEdge = calibrated.calibratedWinProbability - executionPrice;
    if (expectedEdge < options.minEdgeBps / 10_000) continue;

    trades += 1;
    const net = trade.didWin ? (1 / executionPrice) - 1 : -1;
    pnl += net;
    equity += net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.didWin) wins += 1;
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

export function runCalibratedEdgeBacktest(
  rawSamples: HistoricalReplaySample[],
  options: CalibratedEdgeOptions
) {
  const trainFraction = Math.max(0.3, Math.min(0.8, Number(options.trainFraction ?? 0.6)));
  const validationFraction = Math.max(0.1, Math.min(0.4, Number(options.validationFraction ?? 0.2)));
  const bufferBps = Math.max(0, Math.min(5000, Number(options.bufferBps ?? 50)));
  const binSize = Math.max(0.01, Math.min(0.2, Number(options.binSize ?? 0.05)));
  const minBinSamples = Math.max(5, Math.min(500, Number(options.minBinSamples ?? 20)));
  const minValidationTrades = Math.max(5, Math.min(1000, Number(options.minValidationTrades ?? 40)));
  const minValidationHitRatePct = Math.max(0, Math.min(100, Number(options.minValidationHitRatePct ?? 95)));
  const minHoldoutTrades = Math.max(10, Math.min(5000, Number(options.minHoldoutTrades ?? 50)));
  const thresholds = (options.thresholds?.length ? options.thresholds : [0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95])
    .map(v => Math.max(0.5, Math.min(0.999, Number(v))))
    .filter(Number.isFinite);
  const minEdgesBps = (options.minEdgesBps?.length ? options.minEdgesBps : [0,25,50,100,150,200,300])
    .map(v => Math.max(0, Math.min(5000, Number(v))))
    .filter(Number.isFinite);
  const allowedDomains = options.domains?.length ? new Set(options.domains) : null;

  const eligible = rawSamples
    .filter(sample =>
      Boolean(sample.conditionId) &&
      Number.isFinite(Date.parse(sample.resolvedAt)) &&
      (!allowedDomains || allowedDomains.has(sample.domain)) &&
      Number.isFinite(Number(sample.prices?.[options.horizon]))
    )
    .sort((a, b) => Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt));

  const trainEnd = Math.max(1, Math.floor(eligible.length * trainFraction));
  const validationEnd = Math.max(
    trainEnd + 1,
    Math.min(eligible.length - 1, Math.floor(eligible.length * (trainFraction + validationFraction)))
  );
  const trainingSamples = eligible.slice(0, trainEnd);
  const validationSamples = eligible.slice(trainEnd, validationEnd);
  const holdoutSamples = eligible.slice(validationEnd);

  const candidates: Array<{
    threshold: number;
    minEdgeBps: number;
    validation: BacktestSlice;
    calibration: Map<string, CalibrationBin>;
    score: number;
  }> = [];

  for (const threshold of thresholds) {
    const calibration = buildCalibration(
      trainingSamples,
      options.horizon,
      threshold,
      binSize,
      minBinSamples
    );
    for (const minEdgeBps of minEdgesBps) {
      const validation = evaluateCalibrated(validationSamples, calibration, {
        horizon: options.horizon,
        threshold,
        minEdgeBps,
        bufferBps,
        binSize
      });
      if (
        validation.trades < minValidationTrades ||
        validation.roiPct === null ||
        validation.roiPct <= 0 ||
        validation.hitRatePct === null ||
        validation.hitRatePct < minValidationHitRatePct
      ) continue;
      const score = validation.roiPct * Math.sqrt(validation.trades);
      candidates.push({ threshold, minEdgeBps, validation, calibration, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0] || null;

  if (!selected) {
    return {
      generatedAt: new Date().toISOString(),
      horizon: options.horizon,
      eligibleSamples: eligible.length,
      trainSamples: trainingSamples.length,
      validationSamples: validationSamples.length,
      holdoutSamples: holdoutSamples.length,
      selectedPolicy: null,
      deployable: false,
      reason: "no_positive_validation_policy",
      assumptions: [
        "Policy selection uses training calibration and validation ROI only; the holdout is not used to tune parameters.",
        "A policy must have positive validation ROI, a minimum validation trade count, and the configured validation hit-rate floor before it is evaluated for deployment.",
        "Execution buffer is applied as adverse price movement before payout math.",
        "Historical performance does not guarantee future results."
      ]
    };
  }

  const holdout = evaluateCalibrated(holdoutSamples, selected.calibration, {
    horizon: options.horizon,
    threshold: selected.threshold,
    minEdgeBps: selected.minEdgeBps,
    bufferBps,
    binSize
  });
  const deployable =
    selected.validation.roiPct !== null &&
    selected.validation.roiPct > 0 &&
    holdout.roiPct !== null &&
    holdout.roiPct > 0 &&
    holdout.trades >= minHoldoutTrades;

  return {
    generatedAt: new Date().toISOString(),
    horizon: options.horizon,
    eligibleSamples: eligible.length,
    trainSamples: trainingSamples.length,
    validationSamples: validationSamples.length,
    holdoutSamples: holdoutSamples.length,
    selectedPolicy: {
      threshold: selected.threshold,
      minEdgeBps: selected.minEdgeBps,
      bufferBps,
      binSize,
      minBinSamples
    },
    validation: selected.validation,
    holdout,
    deployable,
    reason: deployable ? "positive_validation_and_holdout_roi" : "holdout_gate_failed",
    assumptions: [
      "Policy selection uses training calibration and validation ROI only; the holdout is not used to tune parameters.",
      "A policy must have positive validation ROI, a minimum validation trade count, and the configured validation hit-rate floor before it is evaluated for deployment.",
      "Deployment gate additionally requires positive untouched holdout ROI and the configured minimum holdout trade count.",
      "Execution buffer is applied as adverse price movement before payout math.",
      "Historical performance does not guarantee future results."
    ]
  };
}
