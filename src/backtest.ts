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
  feeMode?: "none" | "current_taker_schedule";
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
  walkForwardFolds?: number;
  minFoldTrades?: number;
  minFoldRoiPct?: number;
  minFoldHitRatePct?: number;
  minHoldoutRoiPct?: number;
  feeMode?: "none" | "current_taker_schedule";
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
  totalFeesPerDollarStake?: number;
  avgFeePerTrade?: number | null;
  startAt: string | null;
  endAt: string | null;
}

export interface DailyPnlSummary {
  activeDays: number;
  profitableDays: number;
  losingDays: number;
  flatDays: number;
  profitableDayPct: number | null;
  avgTradesPerActiveDay: number | null;
  avgPnlPerDollarStakePerDay: number | null;
  medianPnlPerDollarStakePerDay: number | null;
  worstDayPnlPerDollarStake: number | null;
  bestDayPnlPerDollarStake: number | null;
  requiredDailyTurnoverUsd: {
    target100: number | null;
    target500: number | null;
    target1000: number | null;
  };
}

export interface ProbabilityThresholdBacktest {
  generatedAt: string;
  horizon: string;
  threshold: number;
  bufferBps: number;
  trainFraction: number;
  feeMode: "none" | "current_taker_schedule";
  eligibleSamples: number;
  training: BacktestSlice;
  holdout: BacktestSlice;
  holdoutDaily: DailyPnlSummary;
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

function currentTakerFeeRate(domain: string) {
  switch (String(domain || "other").toLowerCase()) {
    case "crypto": return 0.07;
    case "sports": return 0.05;
    case "weather": return 0.05;
    case "other": return 0.05;
    case "political": return 0.04;
    default: return 0.05;
  }
}

function takerFeePerDollarStake(
  sample: HistoricalReplaySample,
  executionPrice: number,
  feeMode: "none" | "current_taker_schedule"
) {
  if (feeMode === "none") return 0;
  if (!(executionPrice > 0 && executionPrice < 1)) return 0;
  const shares = 1 / executionPrice;
  const fee = shares * currentTakerFeeRate(sample.domain) * executionPrice * (1 - executionPrice);
  return Math.round(fee * 100000) / 100000;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b);
  const mid = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
}

function summarizeDailyRows(rows: Array<{ day:string; pnl:number; trades:number }>): DailyPnlSummary {
  const activeDays = rows.length;
  const profitableDays = rows.filter(r=>r.pnl > 0).length;
  const losingDays = rows.filter(r=>r.pnl < 0).length;
  const flatDays = rows.filter(r=>r.pnl === 0).length;
  const pnls = rows.map(r=>r.pnl);
  const totalPnl = pnls.reduce((a,b)=>a+b,0);
  const avgPnl = activeDays ? totalPnl / activeDays : null;
  const avgTrades = activeDays ? rows.reduce((a,b)=>a+b.trades,0) / activeDays : null;
  const turnoverFor = (target:number) =>
    avgPnl && avgPnl > 0 && avgTrades && avgTrades > 0
      ? target / (avgPnl / avgTrades)
      : null;

  return {
    activeDays,
    profitableDays,
    losingDays,
    flatDays,
    profitableDayPct: activeDays ? round((profitableDays / activeDays) * 100, 3) : null,
    avgTradesPerActiveDay: avgTrades === null ? null : round(avgTrades, 3),
    avgPnlPerDollarStakePerDay: avgPnl === null ? null : round(avgPnl, 6),
    medianPnlPerDollarStakePerDay: activeDays ? round(median(pnls) || 0, 6) : null,
    worstDayPnlPerDollarStake: activeDays ? round(Math.min(...pnls), 6) : null,
    bestDayPnlPerDollarStake: activeDays ? round(Math.max(...pnls), 6) : null,
    requiredDailyTurnoverUsd: {
      target100: turnoverFor(100) === null ? null : round(turnoverFor(100)!, 2),
      target500: turnoverFor(500) === null ? null : round(turnoverFor(500)!, 2),
      target1000: turnoverFor(1000) === null ? null : round(turnoverFor(1000)!, 2)
    }
  };
}

function dailyThresholdSummary(
  samples: HistoricalReplaySample[],
  horizon: string,
  threshold: number,
  bufferBps: number,
  feeMode: "none" | "current_taker_schedule"
): DailyPnlSummary {
  const byDay = new Map<string,{day:string;pnl:number;trades:number}>();
  for (const sample of samples) {
    const p0 = Number(sample.prices?.[horizon]);
    if (!Number.isFinite(p0) || p0 <= 0 || p0 >= 1) continue;
    const chooseOutcome0 = p0 >= threshold;
    const chooseOutcome1 = p0 <= 1-threshold;
    if (!chooseOutcome0 && !chooseOutcome1) continue;
    const quotedPrice = chooseOutcome0 ? p0 : 1-p0;
    const executionPrice = Math.min(0.999999, quotedPrice + bufferBps/10_000);
    const didWin = chooseOutcome0 ? sample.actualOutcome0 === 1 : sample.actualOutcome0 === 0;
    const fee = takerFeePerDollarStake(sample, executionPrice, feeMode);
    const net = (didWin ? (1/executionPrice)-1 : -1) - fee;
    const day = new Date(sample.resolvedAt).toISOString().slice(0,10);
    const row = byDay.get(day) || {day,pnl:0,trades:0};
    row.pnl += net;
    row.trades += 1;
    byDay.set(day,row);
  }
  return summarizeDailyRows([...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day)));
}

function evaluate(
  samples: HistoricalReplaySample[],
  horizon: string,
  threshold: number,
  bufferBps: number,
  feeMode: "none" | "current_taker_schedule"
): BacktestSlice {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let totalFees = 0;

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
    const fee = takerFeePerDollarStake(sample, executionPrice, feeMode);
    const net = (didWin ? (1 / executionPrice) - 1 : -1) - fee;

    totalFees += fee;
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
    totalFeesPerDollarStake: round(totalFees, 6),
    avgFeePerTrade: trades ? round(totalFees / trades, 6) : null,
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
  const feeMode = options.feeMode ?? "current_taker_schedule";
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
    feeMode,
    eligibleSamples: eligible.length,
    training: evaluate(trainingSamples, options.horizon, threshold, bufferBps, feeMode),
    holdout: evaluate(holdoutSamples, options.horizon, threshold, bufferBps, feeMode),
    holdoutDaily: dailyThresholdSummary(holdoutSamples, options.horizon, threshold, bufferBps, feeMode),
    assumptions: [
      "Each replay trade risks one dollar at the historical implied probability.",
      "Execution buffer is applied as adverse price movement before payout math.",
      "Current Polymarket taker fee schedule is applied conservatively to every replay trade when feeMode=current_taker_schedule; historical per-market fee activation is not reconstructed.",
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

function dailyCalibratedSummary(
  samples: HistoricalReplaySample[],
  calibration: Map<string, CalibrationBin>,
  options: {
    horizon: string;
    threshold: number;
    minEdgeBps: number;
    bufferBps: number;
    binSize: number;
    feeMode: "none" | "current_taker_schedule";
  }
): DailyPnlSummary {
  const byDay = new Map<string,{day:string;pnl:number;trades:number}>();

  for (const sample of samples) {
    const trade = prepareTrade(sample, options.horizon, options.threshold);
    if (!trade) continue;
    const calibrated = calibration.get(binKey(trade.quotedPrice, options.binSize));
    if (!calibrated) continue;

    const executionPrice = Math.min(0.999999, trade.quotedPrice + options.bufferBps / 10_000);
    const expectedEdge = calibrated.calibratedWinProbability - executionPrice;
    if (expectedEdge < options.minEdgeBps / 10_000) continue;

    const fee = takerFeePerDollarStake(sample, executionPrice, options.feeMode);
    const net = (trade.didWin ? (1 / executionPrice) - 1 : -1) - fee;
    const day = new Date(sample.resolvedAt).toISOString().slice(0,10);
    const row = byDay.get(day) || {day,pnl:0,trades:0};
    row.pnl += net;
    row.trades += 1;
    byDay.set(day,row);
  }

  return summarizeDailyRows([...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day)));
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
    feeMode: "none" | "current_taker_schedule";
  }
): BacktestSlice {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let totalFees = 0;

  for (const sample of samples) {
    const trade = prepareTrade(sample, options.horizon, options.threshold);
    if (!trade) continue;
    const calibrated = calibration.get(binKey(trade.quotedPrice, options.binSize));
    if (!calibrated) continue;

    const executionPrice = Math.min(0.999999, trade.quotedPrice + options.bufferBps / 10_000);
    const expectedEdge = calibrated.calibratedWinProbability - executionPrice;
    if (expectedEdge < options.minEdgeBps / 10_000) continue;

    trades += 1;
    const fee = takerFeePerDollarStake(sample, executionPrice, options.feeMode);
    const net = (trade.didWin ? (1 / executionPrice) - 1 : -1) - fee;
    totalFees += fee;
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
    totalFeesPerDollarStake: round(totalFees, 6),
    avgFeePerTrade: trades ? round(totalFees / trades, 6) : null,
    startAt: samples.length ? iso(samples[0].resolvedAt) : null,
    endAt: samples.length ? iso(samples[samples.length - 1].resolvedAt) : null
  };
}

export function runWalkForwardEdgeBacktest(
  rawSamples: HistoricalReplaySample[],
  options: CalibratedEdgeOptions
) {
  const bufferBps = Math.max(0, Math.min(5000, Number(options.bufferBps ?? 50)));
  const feeMode = options.feeMode ?? "current_taker_schedule";
  const binSize = Math.max(0.01, Math.min(0.2, Number(options.binSize ?? 0.05)));
  const minBinSamples = Math.max(5, Math.min(500, Number(options.minBinSamples ?? 20)));
  const minValidationHitRatePct = Math.max(0, Math.min(100, Number(options.minValidationHitRatePct ?? 95)));
  const minHoldoutTrades = Math.max(10, Math.min(5000, Number(options.minHoldoutTrades ?? 100)));
  const walkForwardFolds = Math.max(2, Math.min(8, Number(options.walkForwardFolds ?? 4)));
  const minFoldTrades = Math.max(5, Math.min(2000, Number(options.minFoldTrades ?? 30)));
  const minFoldRoiPct = Math.max(0, Math.min(100, Number(options.minFoldRoiPct ?? 0.25)));
  const minFoldHitRatePct = Math.max(0, Math.min(100, Number(options.minFoldHitRatePct ?? 95)));
  const minHoldoutRoiPct = Math.max(0, Math.min(100, Number(options.minHoldoutRoiPct ?? 0.25)));
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

  if (eligible.length < 100) {
    return {
      generatedAt:new Date().toISOString(),
      horizon:options.horizon,
      eligibleSamples:eligible.length,
      selectedPolicy:null,
      folds:[],
      holdout:null,
      deployable:false,
      reason:"insufficient_samples"
    };
  }

  const holdoutStart = Math.max(1, Math.floor(eligible.length * 0.9));
  const preHoldout = eligible.slice(0, holdoutStart);
  const holdoutSamples = eligible.slice(holdoutStart);
  const initialTrainEnd = Math.max(1, Math.floor(preHoldout.length * 0.5));
  const validationSpan = preHoldout.length - initialTrainEnd;
  const foldSize = Math.max(1, Math.floor(validationSpan / walkForwardFolds));

  const candidateResults:Array<{
    threshold:number;
    minEdgeBps:number;
    folds:Array<BacktestSlice>;
    minRoi:number;
    avgRoi:number;
    totalTrades:number;
    score:number;
  }> = [];

  for (const threshold of thresholds) {
    for (const minEdgeBps of minEdgesBps) {
      const folds:Array<BacktestSlice> = [];
      let valid = true;

      for (let fold = 0; fold < walkForwardFolds; fold++) {
        const foldStart = initialTrainEnd + fold * foldSize;
        const foldEnd = fold === walkForwardFolds - 1
          ? preHoldout.length
          : Math.min(preHoldout.length, foldStart + foldSize);
        if (foldEnd <= foldStart) continue;

        const calibrationSamples = preHoldout.slice(0, foldStart);
        const foldSamples = preHoldout.slice(foldStart, foldEnd);
        const calibration = buildCalibration(
          calibrationSamples,
          options.horizon,
          threshold,
          binSize,
          minBinSamples
        );
        const result = evaluateCalibrated(foldSamples, calibration, {
          horizon:options.horizon,
          threshold,
          minEdgeBps,
          bufferBps,
          binSize,
          feeMode
        });
        folds.push(result);

        if (
          result.trades < minFoldTrades ||
          result.roiPct === null ||
          result.roiPct < minFoldRoiPct ||
          result.hitRatePct === null ||
          result.hitRatePct < minFoldHitRatePct
        ) {
          valid = false;
          break;
        }
      }

      if (!valid || folds.length !== walkForwardFolds) continue;
      const rois = folds.map(f => Number(f.roiPct || 0));
      const minRoi = Math.min(...rois);
      const avgRoi = rois.reduce((a,b)=>a+b,0) / rois.length;
      const totalTrades = folds.reduce((sum,f)=>sum+f.trades,0);
      const score = minRoi * Math.sqrt(totalTrades) + avgRoi;
      candidateResults.push({threshold,minEdgeBps,folds,minRoi,avgRoi,totalTrades,score});
    }
  }

  candidateResults.sort((a,b)=>b.score-a.score);
  const selected = candidateResults[0] || null;

  if (!selected) {
    return {
      generatedAt:new Date().toISOString(),
      horizon:options.horizon,
      eligibleSamples:eligible.length,
      selectedPolicy:null,
      folds:[],
      holdout:null,
      deployable:false,
      reason:"no_policy_profitable_in_every_walk_forward_fold",
      requirements:{
        walkForwardFolds,
        minFoldTrades,
        minFoldRoiPct,
        minFoldHitRatePct,
        minHoldoutTrades,
        minHoldoutRoiPct
      }
    };
  }

  const finalCalibration = buildCalibration(
    preHoldout,
    options.horizon,
    selected.threshold,
    binSize,
    minBinSamples
  );
  const holdout = evaluateCalibrated(holdoutSamples, finalCalibration, {
    horizon:options.horizon,
    threshold:selected.threshold,
    minEdgeBps:selected.minEdgeBps,
    bufferBps,
    binSize,
    feeMode
  });
  const holdoutDaily = dailyCalibratedSummary(holdoutSamples, finalCalibration, {
    horizon:options.horizon,
    threshold:selected.threshold,
    minEdgeBps:selected.minEdgeBps,
    bufferBps,
    binSize,
    feeMode
  });

  const deployable =
    holdout.trades >= minHoldoutTrades &&
    holdout.roiPct !== null &&
    holdout.roiPct >= minHoldoutRoiPct &&
    holdout.hitRatePct !== null &&
    holdout.hitRatePct >= minValidationHitRatePct;

  return {
    generatedAt:new Date().toISOString(),
    horizon:options.horizon,
    eligibleSamples:eligible.length,
    selectedPolicy:{
      threshold:selected.threshold,
      minEdgeBps:selected.minEdgeBps,
      bufferBps,
      binSize,
      feeMode,
      minBinSamples,
      minHoldoutRoiPct,
      minHoldoutHitRatePct:minValidationHitRatePct,
      feeMode
    },
    folds:selected.folds,
    foldSummary:{
      minRoiPct:round(selected.minRoi,3),
      avgRoiPct:round(selected.avgRoi,3),
      totalTrades:selected.totalTrades
    },
    holdout,
    holdoutDaily,
    deployable,
    reason:deployable ? "all_walk_forward_folds_and_holdout_pass" : "final_holdout_gate_failed",
    requirements:{
      walkForwardFolds,
      minFoldTrades,
      minFoldRoiPct,
      minFoldHitRatePct,
      minHoldoutTrades,
      minHoldoutRoiPct
    },
    assumptions:[
      "Each validation fold is evaluated strictly after the data used to calibrate it.",
      "A policy is rejected if any walk-forward fold is below the configured ROI, hit-rate, or trade-count floor.",
      "The final holdout is untouched during policy selection.",
      "Current Polymarket taker fee schedule is applied conservatively to every replay trade when feeMode=current_taker_schedule.",
      "Historical stability reduces overfitting risk but cannot guarantee future profitability."
    ]
  };
}

export function runCalibratedEdgeBacktest(
  rawSamples: HistoricalReplaySample[],
  options: CalibratedEdgeOptions
) {
  const trainFraction = Math.max(0.3, Math.min(0.8, Number(options.trainFraction ?? 0.6)));
  const validationFraction = Math.max(0.1, Math.min(0.4, Number(options.validationFraction ?? 0.2)));
  const bufferBps = Math.max(0, Math.min(5000, Number(options.bufferBps ?? 50)));
  const feeMode = options.feeMode ?? "current_taker_schedule";
  const binSize = Math.max(0.01, Math.min(0.2, Number(options.binSize ?? 0.05)));
  const minBinSamples = Math.max(5, Math.min(500, Number(options.minBinSamples ?? 20)));
  const minValidationTrades = Math.max(5, Math.min(1000, Number(options.minValidationTrades ?? 40)));
  const minValidationHitRatePct = Math.max(0, Math.min(100, Number(options.minValidationHitRatePct ?? 95)));
  const minHoldoutTrades = Math.max(10, Math.min(5000, Number(options.minHoldoutTrades ?? 50)));
  const minHoldoutRoiPct = Math.max(0, Math.min(100, Number(options.minHoldoutRoiPct ?? 0.25)));
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
        binSize,
        feeMode
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
    binSize,
    feeMode
  });
  const holdoutDaily = dailyCalibratedSummary(holdoutSamples, selected.calibration, {
    horizon: options.horizon,
    threshold: selected.threshold,
    minEdgeBps: selected.minEdgeBps,
    bufferBps,
    binSize,
    feeMode
  });
  const deployable =
    selected.validation.roiPct !== null &&
    selected.validation.roiPct > 0 &&
    holdout.roiPct !== null &&
    holdout.roiPct >= minHoldoutRoiPct &&
    holdout.hitRatePct !== null &&
    holdout.hitRatePct >= minValidationHitRatePct &&
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
      feeMode,
      minBinSamples
    },
    validation: selected.validation,
    holdout,
    holdoutDaily,
    deployable,
    reason: deployable ? "positive_validation_and_holdout_roi" : "holdout_gate_failed",
    assumptions: [
      "Policy selection uses training calibration and validation ROI only; the holdout is not used to tune parameters.",
      "A policy must have positive validation ROI, a minimum validation trade count, and the configured validation hit-rate floor before it is evaluated for deployment.",
      "Deployment gate additionally requires the configured untouched holdout ROI floor, holdout hit-rate floor, and minimum holdout trade count.",
      "Execution buffer is applied as adverse price movement before payout math.",
      "Current Polymarket taker fee schedule is applied conservatively to every replay trade when feeMode=current_taker_schedule.",
      "Historical performance does not guarantee future results."
    ]
  };
}
