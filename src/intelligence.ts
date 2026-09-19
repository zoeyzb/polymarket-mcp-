import type { NormalizedBook } from "./types.js";

function n(value: unknown): number {
  const x = typeof value === "number" ? value : Number(value);
  return Number.isFinite(x) ? x : 0;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function sortedAsks(book: NormalizedBook) {
  return (book.raw.asks || [])
    .map(level => ({ price: n(level.price), size: n(level.size) }))
    .filter(level => level.price > 0 && level.price <= 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function costForShares(book: NormalizedBook, shares: number) {
  let remaining = shares;
  let cost = 0;
  for (const level of sortedAsks(book)) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining -= take;
  }
  return {
    complete: remaining <= 1e-7,
    cost
  };
}

export interface BasketExecution {
  budgetUsd: number;
  bufferBps: number;
  legs: number;
  fillComplete: boolean;
  sharesEach: number;
  totalCostUsd: number;
  guaranteedPayoutUsd: number;
  grossProfitUsd: number;
  bufferCostUsd: number;
  netProfitUsd: number;
  netRoiPct: number | null;
}

export function calculateCompleteOutcomeBasket(
  books: NormalizedBook[],
  budgetUsd: number,
  bufferBps = 50
): BasketExecution {
  if (books.length < 2 || budgetUsd <= 0 || books.some(book => sortedAsks(book).length === 0)) {
    return {
      budgetUsd, bufferBps, legs: books.length, fillComplete: false,
      sharesEach: 0, totalCostUsd: 0, guaranteedPayoutUsd: 0,
      grossProfitUsd: 0, bufferCostUsd: 0, netProfitUsd: 0, netRoiPct: null
    };
  }

  const maxShares = Math.min(...books.map(book =>
    sortedAsks(book).reduce((sum, level) => sum + level.size, 0)
  ));

  let low = 0;
  let high = maxShares;
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2;
    let cost = 0;
    let complete = true;
    for (const book of books) {
      const fill = costForShares(book, mid);
      if (!fill.complete) {
        complete = false;
        break;
      }
      cost += fill.cost;
    }
    if (complete && cost <= budgetUsd) low = mid;
    else high = mid;
  }

  if (low <= 1e-7) {
    return {
      budgetUsd, bufferBps, legs: books.length, fillComplete: false,
      sharesEach: 0, totalCostUsd: 0, guaranteedPayoutUsd: 0,
      grossProfitUsd: 0, bufferCostUsd: 0, netProfitUsd: 0, netRoiPct: null
    };
  }

  const fills = books.map(book => costForShares(book, low));
  const totalCost = fills.reduce((sum, fill) => sum + fill.cost, 0);
  const payout = low; // valid only for mutually-exclusive, collectively-exhaustive complete outcome sets
  const gross = payout - totalCost;
  const buffer = totalCost * Math.max(0, bufferBps) / 10000;
  const net = gross - buffer;

  return {
    budgetUsd,
    bufferBps,
    legs: books.length,
    fillComplete: fills.every(fill => fill.complete),
    sharesEach: round(low),
    totalCostUsd: round(totalCost),
    guaranteedPayoutUsd: round(payout),
    grossProfitUsd: round(gross),
    bufferCostUsd: round(buffer),
    netProfitUsd: round(net),
    netRoiPct: totalCost > 0 ? round((net / totalCost) * 100, 3) : null
  };
}

export interface PriceRegimeAnalysis {
  points: number;
  startPrice: number | null;
  latestPrice: number | null;
  absoluteMove: number | null;
  movePctOfProbability: number | null;
  range: number | null;
  realizedVolatility: number | null;
  maxSingleStepMove: number | null;
  trendSlopePerPoint: number | null;
  regime: "insufficient" | "stable" | "trending" | "volatile" | "shock";
  anomalyScore: number;
}

export function analyzePriceHistoryPayload(payload: unknown): PriceRegimeAnalysis {
  const source =
    Array.isArray(payload) ? payload :
    payload && typeof payload === "object" && Array.isArray((payload as { history?: unknown[] }).history)
      ? (payload as { history: unknown[] }).history
      : [];

  const prices = source
    .map((row: any) => n(row?.p ?? row?.price))
    .filter(price => price > 0 && price < 1);

  if (prices.length < 3) {
    return {
      points: prices.length,
      startPrice: prices[0] ?? null,
      latestPrice: prices.at(-1) ?? null,
      absoluteMove: null,
      movePctOfProbability: null,
      range: null,
      realizedVolatility: null,
      maxSingleStepMove: null,
      trendSlopePerPoint: null,
      regime: "insufficient",
      anomalyScore: 0
    };
  }

  const start = prices[0];
  const latest = prices.at(-1)!;
  const diffs = prices.slice(1).map((price, i) => price - prices[i]);
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((sum, diff) => sum + Math.pow(diff - meanDiff, 2), 0) / diffs.length;
  const volatility = Math.sqrt(variance);
  const maxStep = Math.max(...diffs.map(Math.abs));
  const range = Math.max(...prices) - Math.min(...prices);
  const absoluteMove = latest - start;
  const movePct = start > 0 ? (absoluteMove / start) * 100 : null;

  const xMean = (prices.length - 1) / 2;
  const yMean = prices.reduce((a, b) => a + b, 0) / prices.length;
  let cov = 0;
  let xVar = 0;
  for (let i = 0; i < prices.length; i++) {
    cov += (i - xMean) * (prices[i] - yMean);
    xVar += Math.pow(i - xMean, 2);
  }
  const slope = xVar > 0 ? cov / xVar : 0;

  const shock = maxStep >= 0.08 || Math.abs(absoluteMove) >= 0.15;
  const volatile = volatility >= 0.025 || range >= 0.15;
  const trending = Math.abs(slope) >= 0.003 || Math.abs(absoluteMove) >= 0.06;
  const regime: PriceRegimeAnalysis["regime"] = shock ? "shock" : volatile ? "volatile" : trending ? "trending" : "stable";

  const anomalyScore = Math.min(
    100,
    Math.abs(absoluteMove) * 250 +
    maxStep * 300 +
    volatility * 400 +
    Math.abs(slope) * 1000
  );

  return {
    points: prices.length,
    startPrice: round(start, 6),
    latestPrice: round(latest, 6),
    absoluteMove: round(absoluteMove, 6),
    movePctOfProbability: movePct === null ? null : round(movePct, 2),
    range: round(range, 6),
    realizedVolatility: round(volatility, 6),
    maxSingleStepMove: round(maxStep, 6),
    trendSlopePerPoint: round(slope, 7),
    regime,
    anomalyScore: round(anomalyScore, 1)
  };
}


export interface TradeFlowAnalysis {
  trades: number;
  buyUsd: number;
  sellUsd: number;
  totalUsd: number;
  signedImbalance: number;
  largestTradeUsd: number;
  recent5mUsd: number;
  recent15mUsd: number;
  avgTradeUsd: number;
  flowScore: number;
}

export function analyzeTradeFlowPayload(payload: unknown, nowMs = Date.now()): TradeFlowAnalysis {
  const rows = Array.isArray(payload) ? payload : [];
  let buyUsd = 0;
  let sellUsd = 0;
  let largestTradeUsd = 0;
  let recent5mUsd = 0;
  let recent15mUsd = 0;
  let trades = 0;

  for (const row of rows as any[]) {
    const price = n(row?.price);
    const size = n(row?.size);
    if (price <= 0 || price > 1 || size <= 0) continue;
    const usd = price * size;
    const side = String(row?.side || "").toUpperCase();
    if (side === "BUY") buyUsd += usd;
    else if (side === "SELL") sellUsd += usd;
    else continue;

    trades += 1;
    largestTradeUsd = Math.max(largestTradeUsd, usd);

    const rawTs = n(row?.timestamp);
    const timestampMs = rawTs > 10_000_000_000 ? rawTs : rawTs * 1000;
    const ageMs = nowMs - timestampMs;
    if (ageMs >= 0 && ageMs <= 5 * 60_000) recent5mUsd += usd;
    if (ageMs >= 0 && ageMs <= 15 * 60_000) recent15mUsd += usd;
  }

  const totalUsd = buyUsd + sellUsd;
  const imbalance = totalUsd > 0 ? (buyUsd - sellUsd) / totalUsd : 0;
  const avgTradeUsd = trades > 0 ? totalUsd / trades : 0;
  const flowScore = Math.min(
    100,
    Math.abs(imbalance) * 35 +
    Math.log10(Math.max(1, recent5mUsd)) * 12 +
    Math.log10(Math.max(1, largestTradeUsd)) * 8
  );

  return {
    trades,
    buyUsd: round(buyUsd, 2),
    sellUsd: round(sellUsd, 2),
    totalUsd: round(totalUsd, 2),
    signedImbalance: round(imbalance, 4),
    largestTradeUsd: round(largestTradeUsd, 2),
    recent5mUsd: round(recent5mUsd, 2),
    recent15mUsd: round(recent15mUsd, 2),
    avgTradeUsd: round(avgTradeUsd, 2),
    flowScore: round(flowScore, 1)
  };
}
