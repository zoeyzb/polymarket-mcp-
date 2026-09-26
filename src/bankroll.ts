export interface BankrollTrade {
  id: string;
  entryAt: string;
  settleAt: string;
  requestedStakeUsd: number;
  returnMultiple: number;
}

export interface BankrollSimulationOptions {
  startingBankrollUsd: number;
  maxTradeFraction?: number;
  maxConcurrentExposureFraction?: number;
  dailyLossLimitFraction?: number;
}

export interface BankrollSizingInput {
  bankrollUsd: number;
  availableCashUsd: number;
  concurrentExposureUsd: number;
  expectedEdgeBps: number;
  expectedNetRoiPct: number;
  maxTradeFraction?: number;
  maxConcurrentExposureFraction?: number;
}

export interface BankrollSizingDecision {
  stakeUsd: number;
  fractionOfBankroll: number;
  limitedBy: "edge" | "cash" | "trade_cap" | "exposure_cap" | "no_edge";
}

export interface BankrollSimulationResult {
  startingBankrollUsd: number;
  endBankrollUsd: number;
  growthPct: number;
  tradesEntered: number;
  tradesSkippedInsufficientCash: number;
  tradesSkippedExposureCap: number;
  tradesSkippedDailyLossLimit: number;
  bankrollRotations: number;
  peakCapitalDeployedUsd: number;
  peakConcurrentExposureUsd: number;
  worstIntradayDrawdownPct: number;
  profitableDayPct: number | null;
  medianDailyReturnPct: number | null;
  worstDailyReturnPct: number | null;
  bestDailyReturnPct: number | null;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value: number, digits = 6) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export function sizeBankrollTrade(input: BankrollSizingInput): BankrollSizingDecision {
  const bankroll = Math.max(0, Number(input.bankrollUsd || 0));
  const cash = Math.max(0, Number(input.availableCashUsd || 0));
  const exposure = Math.max(0, Number(input.concurrentExposureUsd || 0));
  const maxTradeFraction = clamp01(input.maxTradeFraction ?? 0.25);
  const maxConcurrentExposureFraction = clamp01(input.maxConcurrentExposureFraction ?? 0.5);
  const edgeBps = Math.max(0, Number(input.expectedEdgeBps || 0));
  const roiPct = Math.max(0, Number(input.expectedNetRoiPct || 0));

  if (!(bankroll > 0) || !(cash > 0) || !(edgeBps > 0) || !(roiPct > 0)) {
    return { stakeUsd:0, fractionOfBankroll:0, limitedBy:"no_edge" };
  }

  const conviction = Math.min(1, Math.max(0.2, (edgeBps / 1200 + roiPct / 15) / 2));
  const desiredFraction = maxTradeFraction * conviction;
  const desiredStake = bankroll * desiredFraction;
  const tradeCap = bankroll * maxTradeFraction;
  const exposureRoom = Math.max(0, bankroll * maxConcurrentExposureFraction - exposure);
  const stake = Math.max(0, Math.min(desiredStake, tradeCap, exposureRoom, cash));

  let limitedBy: BankrollSizingDecision["limitedBy"] = "edge";
  if (stake === cash && cash < desiredStake) limitedBy = "cash";
  else if (stake === exposureRoom && exposureRoom < desiredStake) limitedBy = "exposure_cap";
  else if (stake === tradeCap && tradeCap < desiredStake) limitedBy = "trade_cap";

  return {
    stakeUsd:round(stake),
    fractionOfBankroll:bankroll > 0 ? round(stake / bankroll) : 0,
    limitedBy
  };
}

export function simulateBankroll(
  trades: BankrollTrade[],
  options: BankrollSimulationOptions
): BankrollSimulationResult {
  const starting = Math.max(0, Number(options.startingBankrollUsd || 0));
  const maxTradeFraction = clamp01(options.maxTradeFraction ?? 0.25);
  const maxConcurrentExposureFraction = clamp01(options.maxConcurrentExposureFraction ?? 0.5);
  const dailyLossLimitFraction = clamp01(options.dailyLossLimitFraction ?? 0.2);

  let cash = starting;
  let realizedBankroll = starting;
  let exposure = 0;
  let totalStake = 0;
  let peakExposure = 0;
  let peakCapitalDeployed = 0;
  let highWater = starting;
  let worstDrawdown = 0;
  let entered = 0;
  let skippedCash = 0;
  let skippedExposure = 0;
  let skippedDailyLoss = 0;

  const open: Array<BankrollTrade & { stakeUsd:number }> = [];
  const dayStart = new Map<string, number>();
  const dayPnl = new Map<string, number>();

  const utcDay = (iso:string) => new Date(iso).toISOString().slice(0,10);
  const ensureDay = (iso:string) => {
    const key=utcDay(iso);
    if (!dayStart.has(key)) dayStart.set(key, realizedBankroll);
    return key;
  };

  const settleThrough = (ts:number) => {
    open.sort((a,b)=>Date.parse(a.settleAt)-Date.parse(b.settleAt) || a.id.localeCompare(b.id));
    while (open.length && Date.parse(open[0].settleAt) <= ts) {
      const position = open.shift()!;
      exposure -= position.stakeUsd;
      const returned = position.stakeUsd * Math.max(0, Number(position.returnMultiple || 0));
      cash += returned;
      const pnl = returned - position.stakeUsd;
      const day=ensureDay(position.settleAt);
      realizedBankroll += pnl;
      dayPnl.set(day,(dayPnl.get(day)||0)+pnl);
      highWater=Math.max(highWater,realizedBankroll);
      if (highWater>0) worstDrawdown=Math.min(worstDrawdown,(realizedBankroll-highWater)/highWater);
    }
  };

  const ordered=[...trades].sort((a,b)=>Date.parse(a.entryAt)-Date.parse(b.entryAt) || a.id.localeCompare(b.id));
  for (const trade of ordered) {
    const entryTs=Date.parse(trade.entryAt);
    const settleTs=Date.parse(trade.settleAt);
    if (!Number.isFinite(entryTs) || !Number.isFinite(settleTs) || settleTs < entryTs) continue;
    settleThrough(entryTs);
    const day=ensureDay(trade.entryAt);
    const opening=dayStart.get(day) || starting || 1;
    const pnl=dayPnl.get(day)||0;
    if (pnl <= -(opening * dailyLossLimitFraction) && dailyLossLimitFraction < 1) {
      skippedDailyLoss += 1;
      continue;
    }

    const requested=Math.max(0,Number(trade.requestedStakeUsd||0));
    const tradeCap=realizedBankroll * maxTradeFraction;
    const exposureCap=realizedBankroll * maxConcurrentExposureFraction;
    const exposureRoom=Math.max(0,exposureCap-exposure);
    const allowed=Math.min(requested,tradeCap,exposureRoom);

    if (allowed <= 0 || exposureRoom <= 0) {
      skippedExposure += 1;
      continue;
    }
    if (cash + 1e-9 < allowed || cash + 1e-9 < requested && maxTradeFraction >= 1 && maxConcurrentExposureFraction >= 1) {
      skippedCash += 1;
      continue;
    }

    const stake=Math.min(allowed,cash);
    if (stake <= 0) {
      skippedCash += 1;
      continue;
    }
    cash -= stake;
    exposure += stake;
    totalStake += stake;
    peakExposure=Math.max(peakExposure,exposure);
    peakCapitalDeployed=Math.max(peakCapitalDeployed,starting-cash);
    open.push({...trade,stakeUsd:stake});
    entered += 1;
  }

  settleThrough(Number.POSITIVE_INFINITY);

  const dailyReturns=Array.from(dayStart.entries()).map(([day,openBankroll]) => {
    const pnl=dayPnl.get(day)||0;
    return openBankroll>0 ? (pnl/openBankroll)*100 : 0;
  }).sort((a,b)=>a-b);
  const profitable=dailyReturns.filter(v=>v>0).length;
  const median=dailyReturns.length
    ? (dailyReturns.length%2
      ? dailyReturns[(dailyReturns.length-1)/2]
      : (dailyReturns[dailyReturns.length/2-1]+dailyReturns[dailyReturns.length/2])/2)
    : null;

  return {
    startingBankrollUsd:round(starting),
    endBankrollUsd:round(realizedBankroll),
    growthPct:starting>0 ? round(((realizedBankroll-starting)/starting)*100,4) : 0,
    tradesEntered:entered,
    tradesSkippedInsufficientCash:skippedCash,
    tradesSkippedExposureCap:skippedExposure,
    tradesSkippedDailyLossLimit:skippedDailyLoss,
    bankrollRotations:starting>0 ? round(totalStake/starting,4) : 0,
    peakCapitalDeployedUsd:round(peakCapitalDeployed),
    peakConcurrentExposureUsd:round(peakExposure),
    worstIntradayDrawdownPct:round(worstDrawdown*100,4),
    profitableDayPct:dailyReturns.length ? round((profitable/dailyReturns.length)*100,3) : null,
    medianDailyReturnPct:median==null ? null : round(median,4),
    worstDailyReturnPct:dailyReturns.length ? round(dailyReturns[0],4) : null,
    bestDailyReturnPct:dailyReturns.length ? round(dailyReturns[dailyReturns.length-1],4) : null
  };
}
