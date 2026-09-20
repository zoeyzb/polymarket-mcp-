import {
  getEventById,
  getOrderBooks,
  getPriceHistory,
  getRecentTrades,
  listAllActiveMarkets,
  parseNumberArray,
  parseStringArray
} from "./polymarket.js";
import {
  analyzePriceHistoryPayload,
  analyzeTradeFlowPayload,
  calculateCompleteOutcomeBasket
} from "./intelligence.js";
import { recordSnapshot } from "./snapshots.js";
import { getConditionSmartMoneySignals, getHistoricalCandidateStats } from "./persistence.js";
import { getExternalCryptoEvidence } from "./external-evidence.js";
import { isPoliticalCandidate, isPoliticalMarket } from "./domain-policy.js";
import { classifyMarketCategories, primaryMarketCategory } from "./category-taxonomy.js";
import { estimateMakerEdge } from "./maker-edge.js";
import { analyzeResolutionRules } from "./resolution-intelligence.js";
import { listOpenKalshiMarkets, matchCandidateToKalshi } from "./cross-venue.js";
import { findStructuralGraphViolations } from "./structural-graph.js";
import type {
  CompleteSetExecution,
  ExecutionEstimate,
  EventBasketOpportunity,
  GammaMarket,
  NormalizedBook,
  OpportunityClass,
  ScanCandidate,
  ScanResult,
  MultiHorizonScanResult,
  MultiHorizonLane
} from "./types.js";

const BUDGETS = [10, 25, 50, 100];
const DEFAULT_BUFFER_BPS = Math.max(0, Number(process.env.OPPORTUNITY_BUFFER_BPS || 50));

function n(value: unknown): number {
  const x = typeof value === "number" ? value : Number(value);
  return Number.isFinite(x) ? x : 0;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function getEndDate(market: GammaMarket): string | null {
  const raw = market.endDateIso || market.endDate;
  if (typeof raw !== "string" || !raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function sortedAsks(book: NormalizedBook) {
  return Array.isArray(book.raw.asks)
    ? book.raw.asks
        .map(x => ({ price: n(x.price), size: n(x.size) }))
        .filter(x => x.price > 0 && x.price <= 1 && x.size > 0)
        .sort((a, b) => a.price - b.price)
    : [];
}

function executionEstimate(book: NormalizedBook, budgetUsd: number): ExecutionEstimate {
  const asks = sortedAsks(book);
  let remaining = budgetUsd;
  let spent = 0;
  let shares = 0;

  for (const level of asks) {
    if (remaining <= 0) break;
    const levelUsd = level.price * level.size;
    const takeUsd = Math.min(remaining, levelUsd);
    const takeShares = takeUsd / level.price;
    spent += takeUsd;
    shares += takeShares;
    remaining -= takeUsd;
  }

  const avg = shares > 0 ? spent / shares : null;
  const maxPayout = shares;
  const profit = maxPayout - spent;
  return {
    budgetUsd,
    spendableUsd: round(spent),
    avgFillPrice: avg === null ? null : round(avg, 6),
    shares: round(shares),
    maxPayoutIfWinning: round(maxPayout),
    profitIfWinning: round(profit),
    roiIfWinningPct: spent > 0 ? round((profit / spent) * 100, 2) : null,
    fillPct: round((spent / budgetUsd) * 100, 2)
  };
}

function costForShares(book: NormalizedBook, targetShares: number): { complete: boolean; cost: number } {
  if (targetShares <= 0) return { complete: false, cost: 0 };
  let remaining = targetShares;
  let cost = 0;
  for (const level of sortedAsks(book)) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining -= take;
  }
  return { complete: remaining <= 1e-7, cost };
}

export function calculateCompleteSetExecution(
  books: NormalizedBook[],
  budgetUsd: number,
  bufferBps = DEFAULT_BUFFER_BPS
): CompleteSetExecution {
  if (books.length !== 2 || budgetUsd <= 0 || books.some(book => sortedAsks(book).length === 0)) {
    return {
      budgetUsd,
      bufferBps,
      fillComplete: false,
      sharesEach: 0,
      totalCostUsd: 0,
      guaranteedPayoutUsd: 0,
      grossProfit: 0,
      grossRoiPct: null,
      bufferCostUsd: 0,
      netProfitAfterBuffer: 0,
      netRoiPct: null
    };
  }

  const maxSharesByDepth = Math.min(
    ...books.map(book => sortedAsks(book).reduce((sum, level) => sum + level.size, 0))
  );

  let low = 0;
  let high = maxSharesByDepth;
  for (let i = 0; i < 45; i++) {
    const mid = (low + high) / 2;
    let totalCost = 0;
    let complete = true;
    for (const book of books) {
      const fill = costForShares(book, mid);
      if (!fill.complete) {
        complete = false;
        break;
      }
      totalCost += fill.cost;
    }
    if (complete && totalCost <= budgetUsd) low = mid;
    else high = mid;
  }

  if (low <= 1e-7) {
    return {
      budgetUsd,
      bufferBps,
      fillComplete: false,
      sharesEach: 0,
      totalCostUsd: 0,
      guaranteedPayoutUsd: 0,
      grossProfit: 0,
      grossRoiPct: null,
      bufferCostUsd: 0,
      netProfitAfterBuffer: 0,
      netRoiPct: null
    };
  }

  const fills = books.map(book => costForShares(book, low));
  const fillComplete = fills.every(fill => fill.complete);
  const totalCost = fills.reduce((sum, fill) => sum + fill.cost, 0);
  const payout = low;
  const grossProfit = payout - totalCost;
  const bufferCost = totalCost * (Math.max(0, bufferBps) / 10000);
  const netProfit = grossProfit - bufferCost;

  return {
    budgetUsd,
    bufferBps,
    fillComplete,
    sharesEach: round(low),
    totalCostUsd: round(totalCost),
    guaranteedPayoutUsd: round(payout),
    grossProfit: round(grossProfit),
    grossRoiPct: totalCost > 0 ? round((grossProfit / totalCost) * 100, 3) : null,
    bufferCostUsd: round(bufferCost),
    netProfitAfterBuffer: round(netProfit),
    netRoiPct: totalCost > 0 ? round((netProfit / totalCost) * 100, 3) : null
  };
}

function scoreCandidate(
  market: GammaMarket,
  minutesRemaining: number,
  books: NormalizedBook[]
): { score: number; breakdown: Record<string, number>; flags: string[] } {
  const flags: string[] = [];
  const spreads = books.map(b => b.spread).filter((x): x is number => x !== null);
  const avgSpread = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 1;
  const avgAskDepth = books.length ? books.reduce((s, b) => s + b.askDepthUsdTop5, 0) / books.length : 0;
  const liquidity = n(market.liquidityNum ?? market.liquidity);
  const volume24 = n(market.volume24hr);

  const spreadScore = avgSpread <= 0.01 ? 25 : avgSpread <= 0.02 ? 22 : avgSpread <= 0.04 ? 16 : avgSpread <= 0.08 ? 9 : 2;
  const liquidityScore = Math.min(20, Math.max(0, Math.log10(Math.max(1, liquidity)) * 4));
  const depthScore = Math.min(20, (avgAskDepth / 250) * 20);
  const urgencyScore = minutesRemaining <= 5 ? 7 : minutesRemaining <= 20 ? 15 : minutesRemaining <= 60 ? 13 : 10;
  const rulesScore = market.description || market.resolutionSource ? 10 : 2;
  const activityScore = Math.min(10, Math.max(0, Math.log10(Math.max(1, volume24)) * 2));

  if (avgSpread > 0.05) flags.push("wide_spread");
  if (liquidity < 1000) flags.push("low_liquidity");
  if (avgAskDepth < 50) flags.push("thin_top5_ask_depth");
  if (!market.description && !market.resolutionSource) flags.push("resolution_rules_need_review");
  if (minutesRemaining <= 5) flags.push("very_close_to_end_time");
  if (market.acceptingOrders === false) flags.push("not_accepting_orders");

  const score = spreadScore + liquidityScore + depthScore + urgencyScore + rulesScore + activityScore;
  return {
    score: round(Math.min(100, Math.max(0, score)), 1),
    breakdown: {
      spread: round(spreadScore, 1),
      liquidity: round(liquidityScore, 1),
      orderBookDepth: round(depthScore, 1),
      urgency: round(urgencyScore, 1),
      resolutionClarity: round(rulesScore, 1),
      activity: round(activityScore, 1)
    },
    flags
  };
}

function eventMeta(market: GammaMarket): { id: string; title: string | null; negRisk: boolean; augmented: boolean } | null {
  const event = Array.isArray(market.events) && market.events.length
    ? market.events[0] as Record<string, unknown>
    : null;
  if (!event) return null;
  const id = event.id ?? event.slug;
  if (id === undefined || id === null || String(id).length === 0) return null;
  return {
    id: String(id),
    title: event.title ? String(event.title) : null,
    negRisk: market.negRisk === true || market.enableNegRisk === true || event.negRisk === true || event.enableNegRisk === true,
    augmented: market.negRiskAugmented === true || event.negRiskAugmented === true
  };
}

function yesTokenId(market: GammaMarket): string | null {
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);
  const yesIndex = outcomes.findIndex(outcome => outcome.trim().toLowerCase() === "yes");
  return yesIndex >= 0 && tokenIds[yesIndex] ? tokenIds[yesIndex] : null;
}

async function buildEventBasketOpportunities(
  allActive: GammaMarket[],
  now: number,
  cutoff: number,
  allBooks: Map<string, NormalizedBook>,
  bufferBps: number
): Promise<EventBasketOpportunity[]> {
  const groups = new Map<string, { title: string | null; negRisk: boolean; augmented: boolean; markets: GammaMarket[] }>();

  for (const market of allActive) {
    const meta = eventMeta(market);
    if (!meta) continue;
    const current = groups.get(meta.id) ?? { title: meta.title, negRisk: meta.negRisk, augmented: meta.augmented, markets: [] };
    current.negRisk = current.negRisk || meta.negRisk;
    current.augmented = current.augmented || meta.augmented;
    if (!current.title && meta.title) current.title = meta.title;
    current.markets.push(market);
    groups.set(meta.id, current);
  }

  const results: EventBasketOpportunity[] = [];
  for (const [eventId, group] of groups) {
    if (!group.negRisk || group.augmented || group.markets.length < 3) continue;

    const completeWindow = group.markets.every(market => {
      const end = getEndDate(market);
      if (!end) return false;
      const ts = Date.parse(end);
      return ts >= now && ts <= cutoff && market.active !== false && market.closed !== true && market.acceptingOrders !== false;
    });
    if (!completeWindow) continue;

    const authoritativeEvent = await getEventById(eventId);
    if (!authoritativeEvent) continue;
    if (authoritativeEvent.negRisk !== true && authoritativeEvent.enableNegRisk !== true) continue;
    if (authoritativeEvent.negRiskAugmented === true) continue;

    const authoritativeMarkets = Array.isArray(authoritativeEvent.markets)
      ? authoritativeEvent.markets.filter(
          (market): market is Record<string, unknown> => Boolean(market) && typeof market === "object"
        )
      : [];
    if (authoritativeMarkets.length < 3) continue;

    const identity = (market: Record<string, unknown>) =>
      String(market.id ?? market.conditionId ?? market.slug ?? "");
    const localIds = group.markets
      .map(market => String(market.id ?? market.conditionId ?? market.slug ?? ""))
      .filter(Boolean)
      .sort();
    const authoritativeIds = authoritativeMarkets.map(identity).filter(Boolean).sort();

    if (
      localIds.length !== authoritativeIds.length ||
      localIds.some((id, index) => id !== authoritativeIds[index])
    ) {
      continue;
    }

    const authoritativeComplete = authoritativeMarkets.every(raw => {
      const market = raw as GammaMarket;
      const end = getEndDate(market);
      if (!end) return false;
      const ts = Date.parse(end);
      const outcomes = parseStringArray(market.outcomes).map(x => x.trim().toLowerCase());
      return (
        ts >= now &&
        ts <= cutoff &&
        market.active !== false &&
        market.closed !== true &&
        market.acceptingOrders !== false &&
        (market.negRisk === true || authoritativeEvent.negRisk === true || authoritativeEvent.enableNegRisk === true) &&
        outcomes.length === 2 &&
        outcomes.includes("yes") &&
        outcomes.includes("no") &&
        yesTokenId(market) !== null
      );
    });
    if (!authoritativeComplete) continue;

    const authoritativeGamma = authoritativeMarkets as GammaMarket[];
    const yesTokens = authoritativeGamma.map(yesTokenId);
    if (yesTokens.some((token): token is null => token === null)) continue;
    const tokenIds = yesTokens as string[];
    const books = tokenIds.map(token => allBooks.get(token)).filter((book): book is NormalizedBook => Boolean(book));
    if (books.length !== tokenIds.length) continue;

    const topAskTotal = books.reduce((sum, book) => sum + (book.bestAsk ?? 1), 0);
    const executable = BUDGETS.map(budget => calculateCompleteOutcomeBasket(books, budget, bufferBps));
    const positive = executable
      .filter(x => x.fillComplete && x.netProfitUsd > 0 && (x.netRoiPct ?? 0) > 0)
      .sort((a, b) => b.netProfitUsd - a.netProfitUsd || (b.netRoiPct ?? 0) - (a.netRoiPct ?? 0));

    if (topAskTotal >= 1 && positive.length === 0) continue;

    const best = positive[0] ?? null;
    results.push({
      eventId,
      eventTitle: String(authoritativeEvent.title ?? group.title ?? "") || null,
      marketCount: authoritativeGamma.length,
      marketIds: authoritativeIds,
      outcomeQuestions: authoritativeGamma.map(market => String(market.question ?? "Untitled market")),
      yesTokenIds: tokenIds,
      executable,
      bestNetProfitUsd: best?.netProfitUsd ?? 0,
      bestNetRoiPct: best?.netRoiPct ?? null,
      bestBudgetUsd: best?.budgetUsd ?? null,
      flags: [
        "neg_risk_complete_outcome_set",
        "gamma_event_child_set_verified",
        ...(topAskTotal < 1 ? ["top_book_complete_set_edge"] : []),
        ...(best ? ["depth_buffer_verified_event_basket"] : ["top_book_only_not_depth_verified"])
      ]
    });
  }

  return results.sort((a, b) =>
    b.bestNetProfitUsd - a.bestNetProfitUsd ||
    (b.bestNetRoiPct ?? 0) - (a.bestNetRoiPct ?? 0)
  );
}

function classifyOpportunity(
  tradabilityScore: number,
  topAskTotal: number | null,
  executions: CompleteSetExecution[]
): { opportunityClass: OpportunityClass; opportunityScore: number; best: CompleteSetExecution | null } {
  const positive = executions
    .filter(x => x.fillComplete && x.netProfitAfterBuffer > 0 && (x.netRoiPct ?? 0) > 0)
    .sort((a, b) => b.netProfitAfterBuffer - a.netProfitAfterBuffer || (b.netRoiPct ?? 0) - (a.netRoiPct ?? 0));

  const best = positive[0] ?? null;
  if (best) {
    const profitComponent = Math.min(25, best.netProfitAfterBuffer * 3);
    const roiComponent = Math.min(25, (best.netRoiPct ?? 0) * 3);
    const qualityComponent = Math.min(30, tradabilityScore * 0.3);
    return {
      opportunityClass: "executable_structural",
      opportunityScore: round(Math.min(100, 40 + profitComponent + roiComponent + qualityComponent), 1),
      best
    };
  }

  if (topAskTotal !== null && topAskTotal < 1) {
    return {
      opportunityClass: "top_book_structural_only",
      opportunityScore: round(Math.min(69, 25 + (1 - topAskTotal) * 200 + tradabilityScore * 0.25), 1),
      best: null
    };
  }

  return {
    opportunityClass: "research_candidate",
    opportunityScore: round(Math.min(49, tradabilityScore * 0.49), 1),
    best: null
  };
}

async function enrichMarket(
  market: GammaMarket,
  now: number,
  includeBooks: boolean,
  allBooks: Map<string, NormalizedBook>,
  bufferBps: number
): Promise<ScanCandidate | null> {
  const endDate = getEndDate(market);
  if (!endDate) return null;
  const endTs = Date.parse(endDate);
  const minutesRemaining = (endTs - now) / 60000;
  if (minutesRemaining < 0) return null;

  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes);
  const displayedOutcomePrices = parseNumberArray(market.outcomePrices);
  const books = includeBooks
    ? tokenIds.map(tokenId => allBooks.get(tokenId)).filter((x): x is NormalizedBook => Boolean(x))
    : [];

  const scoring = scoreCandidate(market, minutesRemaining, books);
  let binaryArbitrage: ScanCandidate["binaryArbitrage"] = null;
  let topAskTotal: number | null = null;
  let completeSetExecutions: CompleteSetExecution[] = [];

  if (books.length === 2 && books.every(book => book.bestAsk !== null)) {
    topAskTotal = (books[0].bestAsk as number) + (books[1].bestAsk as number);
    completeSetExecutions = BUDGETS.map(budget => calculateCompleteSetExecution(books, budget, bufferBps));
  }

  const opportunity = classifyOpportunity(scoring.score, topAskTotal, completeSetExecutions);

  if (topAskTotal !== null && topAskTotal < 1) {
    const edge = 1 - topAskTotal;
    if (opportunity.opportunityClass === "executable_structural") {
      scoring.flags.push("binary_structural_edge_executable_at_depth");
    } else {
      scoring.flags.push("binary_top_book_edge_not_executable_after_depth_buffer");
    }

    binaryArbitrage = {
      buyBothAskTotal: round(topAskTotal, 6),
      grossEdgePerDollar: round(edge, 6),
      grossEdgePct: round(edge * 100, 3),
      executable: completeSetExecutions,
      bestExecutableBudgetUsd: opportunity.best?.budgetUsd ?? null,
      bestNetProfitUsd: opportunity.best?.netProfitAfterBuffer ?? 0,
      bestNetRoiPct: opportunity.best?.netRoiPct ?? null,
      note: "Depth-aware complete-set math. Positive net values include the configured execution buffer, but still require simultaneous fills and correct resolution interpretation."
    };
  }

  const marketBooks = books.map((book, i) => ({
    outcome: outcomes[i] || `Outcome ${i + 1}`,
    tokenId: book.tokenId,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    spread: book.spread,
    midpoint: book.midpoint,
    bidDepthUsdTop5: round(book.bidDepthUsdTop5, 2),
    askDepthUsdTop5: round(book.askDepthUsdTop5, 2),
    executions: BUDGETS.map(budget => executionEstimate(book, budget))
  }));

  const categories = classifyMarketCategories(market, now);
  const primaryCategory = primaryMarketCategory(categories);

  const candidate: ScanCandidate = {
    id: market.id ? String(market.id) : null,
    slug: market.slug ? String(market.slug) : null,
    question: String(market.question || "Untitled market"),
    conditionId: market.conditionId ? String(market.conditionId) : null,
    endDate,
    minutesRemaining: round(minutesRemaining, 2),
    acceptingOrders: market.acceptingOrders !== false,
    liquidityUsd: round(n(market.liquidityNum ?? market.liquidity), 2),
    volumeUsd: round(n(market.volumeNum ?? market.volume), 2),
    volume24hUsd: round(n(market.volume24hr), 2),
    outcomes,
    tokenIds,
    displayedOutcomePrices,
    resolutionSource: market.resolutionSource ? String(market.resolutionSource) : null,
    resolutionRules: market.description ? String(market.description) : null,
    url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
    books: includeBooks ? marketBooks : undefined,
    binaryArbitrage,
    categories,
    primaryCategory,
    opportunityClass: opportunity.opportunityClass,
    opportunityScore: opportunity.opportunityScore,
    rapidReviewScore: scoring.score,
    scoreBreakdown: scoring.breakdown,
    flags: [
      ...scoring.flags,
      ...(isPoliticalMarket(market) ? ["political_structural_only"] : [])
    ]
  };

  candidate.makerEdge = estimateMakerEdge(
    market,
    primaryCategory,
    books[0] ?? null,
    0,
    0
  );
  candidate.resolutionIntelligence = analyzeResolutionRules(candidate);
  for (const flag of candidate.resolutionIntelligence.flags) {
    if (!candidate.flags.includes(flag)) candidate.flags.push(flag);
  }

  return candidate;
}

async function enrichBehaviorSignals(candidates: ScanCandidate[]) {
  const limit = Math.max(0, Math.min(200, Number(process.env.SIGNAL_ENRICH_LIMIT || 100)));
  const targets = [...candidates]
    .filter(candidate => !isPoliticalCandidate(candidate))
    .sort((a, b) => b.rapidReviewScore - a.rapidReviewScore || b.liquidityUsd - a.liquidityUsd)
    .slice(0, limit);

  const queue = [...targets];
  const concurrency = Math.max(1, Math.min(20, Number(process.env.SIGNAL_ENRICH_CONCURRENCY || 8)));

  async function worker() {
    while (queue.length) {
      const candidate = queue.shift();
      if (!candidate) return;

      const tokenId = candidate.tokenIds[0];
      const conditionId = candidate.conditionId;

      const [historyPayload, tradePayload] = await Promise.all([
        tokenId
          ? getPriceHistory(tokenId, 6, 5).catch(() => null)
          : Promise.resolve(null),
        conditionId
          ? getRecentTrades(conditionId, 100).catch(() => null)
          : Promise.resolve(null)
      ]);

      const priceRegime = historyPayload ? analyzePriceHistoryPayload(historyPayload) : null;
      const tradeFlow = tradePayload ? analyzeTradeFlowPayload(tradePayload) : null;

      candidate.marketSignals = { priceRegime, tradeFlow };

      const regimeBoost = priceRegime ? priceRegime.anomalyScore * 0.25 : 0;
      const flowBoost = tradeFlow ? tradeFlow.flowScore * 0.15 : 0;
      candidate.attentionScore = round(
        Math.min(100, candidate.opportunityScore + regimeBoost + flowBoost),
        1
      );

      if (priceRegime?.regime === "shock") candidate.flags.push("price_shock");
      else if (priceRegime?.regime === "volatile") candidate.flags.push("high_price_volatility");
      else if (priceRegime?.regime === "trending") candidate.flags.push("price_trend");

      if (tradeFlow && Math.abs(tradeFlow.signedImbalance) >= 0.7 && tradeFlow.totalUsd >= 100) {
        candidate.flags.push("strong_recent_trade_imbalance");
      }
      if (tradeFlow && tradeFlow.largestTradeUsd >= 1000) {
        candidate.flags.push("large_recent_trade");
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));

  for (const candidate of candidates) {
    if (candidate.attentionScore === undefined) candidate.attentionScore = candidate.opportunityScore;
  }
}

async function enrichExternalEvidence(candidates: ScanCandidate[]) {
  const targets = candidates
    .filter(candidate => !isPoliticalCandidate(candidate))
    .slice(0, Math.max(0, Math.min(100, Number(process.env.EXTERNAL_EVIDENCE_LIMIT || 50))));
  const queue = [...targets];
  const concurrency = Math.max(1, Math.min(10, Number(process.env.EXTERNAL_EVIDENCE_CONCURRENCY || 4)));

  async function worker() {
    while (queue.length) {
      const candidate = queue.shift();
      if (!candidate) return;
      const evidence = await getExternalCryptoEvidence(candidate.question).catch(() => null);
      candidate.externalEvidence = evidence;

      if (!evidence) continue;
      for (const flag of evidence.flags) {
        if (!candidate.flags.includes(flag)) candidate.flags.push(flag);
      }

      if (evidence.nearThreshold) {
        candidate.attentionScore = round(
          Math.min(100, (candidate.attentionScore ?? candidate.opportunityScore) + 8),
          1
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
}

async function enrichAdvancedIntelligence(candidates: ScanCandidate[]) {
  const conditionIds = candidates
    .map(candidate => candidate.conditionId)
    .filter((id): id is string => Boolean(id));

  const [smartMoneyByCondition, kalshiMarkets] = await Promise.all([
    conditionIds.length
      ? getConditionSmartMoneySignals(conditionIds, 90).catch(() => ({} as Record<string, unknown[]>))
      : Promise.resolve({} as Record<string, unknown[]>),
    listOpenKalshiMarkets().catch(() => [])
  ]);

  for (const candidate of candidates) {
    // Re-estimate maker adverse-selection risk after behavior enrichment.
    const firstBook = candidate.books?.[0];
    if (firstBook) {
      const priorMaker = candidate.makerEdge;
      const refreshedMaker = estimateMakerEdge(
        {
          question: candidate.question,
          slug: candidate.slug ?? undefined,
          description: candidate.resolutionRules ?? undefined,
          resolutionSource: candidate.resolutionSource ?? undefined,
          feesEnabled: priorMaker?.feeEnabled
        },
        candidate.primaryCategory,
        {
          tokenId: firstBook.tokenId,
          bestBid: firstBook.bestBid,
          bestAsk: firstBook.bestAsk,
          spread: firstBook.spread,
          midpoint: firstBook.midpoint,
          bidDepthUsdTop5: firstBook.bidDepthUsdTop5,
          askDepthUsdTop5: firstBook.askDepthUsdTop5,
          raw: { asset_id: firstBook.tokenId, bids: [], asks: [] }
        },
        candidate.marketSignals?.priceRegime?.anomalyScore ?? 0,
        candidate.marketSignals?.tradeFlow?.signedImbalance ?? 0
      );
      if (priorMaker) refreshedMaker.rewardMetadata = priorMaker.rewardMetadata;
      candidate.makerEdge = refreshedMaker;
    }

    candidate.resolutionIntelligence = analyzeResolutionRules(candidate);

    // Cross-venue data is descriptive on political markets and cannot boost discovery.
    candidate.crossVenue = matchCandidateToKalshi(candidate, kalshiMarkets, 3);

    if (!candidate.conditionId || isPoliticalCandidate(candidate)) {
      candidate.smartMoney = null;
      continue;
    }

    const signals = (smartMoneyByCondition[candidate.conditionId] || []) as Array<Record<string, unknown>>;
    const uniqueWallets = new Set<string>();
    const highScoreWallets = new Set<string>();
    let totalNotionalUsd = 0;
    let weightedNumerator = 0;
    let weightedDenominator = 0;
    let yesWeightedFlow = 0;
    let noWeightedFlow = 0;

    for (const signal of signals) {
      const wallet = String(signal.walletAddress || "");
      if (wallet) uniqueWallets.add(wallet);
      const walletScore = n(signal.walletScore);
      if (walletScore >= 70 && wallet) highScoreWallets.add(wallet);

      const categoryStats = Array.isArray(signal.categoryStats)
        ? signal.categoryStats as Array<Record<string, unknown>>
        : [];
      const categoryRow = categoryStats.find(row =>
        String(row.category || "") === candidate.primaryCategory
      );
      const categoryMatch = categoryRow
        ? Math.max(0.25, Math.min(1, n(categoryRow.shareOfSample)))
        : 0.25;

      const notional = Math.max(0, n(signal.notionalUsd));
      totalNotionalUsd += notional;
      const weight = Math.max(1, notional) * categoryMatch;
      weightedNumerator += walletScore * weight;
      weightedDenominator += weight;

      const outcome = String(signal.outcome || "").trim().toLowerCase();
      const side = String(signal.side || "").trim().toUpperCase();
      const directionalWeight =
        Math.log1p(Math.max(0, notional)) *
        Math.max(0.1, walletScore / 100) *
        categoryMatch;

      // Map BUY/SELL of YES/NO onto a YES-probability direction.
      if (
        (side === "BUY" && outcome === "yes") ||
        (side === "SELL" && outcome === "no")
      ) {
        yesWeightedFlow += directionalWeight;
      } else if (
        (side === "BUY" && outcome === "no") ||
        (side === "SELL" && outcome === "yes")
      ) {
        noWeightedFlow += directionalWeight;
      }
    }

    const weightedSmartMoneyScore = weightedDenominator > 0
      ? weightedNumerator / weightedDenominator
      : 0;
    const directionalTotal = yesWeightedFlow + noWeightedFlow;
    const yesDirectionalBias = directionalTotal > 0
      ? (yesWeightedFlow - noWeightedFlow) / directionalTotal
      : null;
    const dominantSide =
      yesDirectionalBias === null
        ? null
        : yesDirectionalBias >= 0.25
          ? "YES" as const
          : yesDirectionalBias <= -0.25
            ? "NO" as const
            : "MIXED" as const;

    const flags: string[] = [];
    if (highScoreWallets.size >= 1) flags.push("high_score_wallet_active");
    if (highScoreWallets.size >= 2) flags.push("multi_wallet_alignment_identity_unverified");
    if (totalNotionalUsd >= 10_000) flags.push("large_smart_money_notional");
    if (dominantSide === "YES" && highScoreWallets.size >= 1) flags.push("smart_money_yes_alignment");
    if (dominantSide === "NO" && highScoreWallets.size >= 1) flags.push("smart_money_no_alignment");

    candidate.smartMoney = {
      signals: signals.slice(0, 25),
      uniqueWallets: uniqueWallets.size,
      highScoreWallets: highScoreWallets.size,
      totalNotionalUsd: round(totalNotionalUsd, 2),
      weightedSmartMoneyScore: round(weightedSmartMoneyScore, 1),
      yesDirectionalBias: yesDirectionalBias === null ? null : round(yesDirectionalBias, 4),
      dominantSide,
      yesWeightedFlow: round(yesWeightedFlow, 4),
      noWeightedFlow: round(noWeightedFlow, 4),
      flags
    };
    for (const flag of flags) if (!candidate.flags.includes(flag)) candidate.flags.push(flag);

    if (weightedSmartMoneyScore >= 70 && highScoreWallets.size >= 1) {
      candidate.attentionScore = round(
        Math.min(
          100,
          (candidate.attentionScore ?? candidate.opportunityScore) +
          Math.min(8, weightedSmartMoneyScore * 0.06 + Math.log10(Math.max(1, totalNotionalUsd)) * 0.6)
        ),
        1
      );
    }
  }
}

async function enrichHistoricalEvidence(candidates: ScanCandidate[]) {
  const conditionIds = candidates
    .map(candidate => candidate.conditionId)
    .filter((id): id is string => Boolean(id));

  if (!conditionIds.length) return;

  const history = await getHistoricalCandidateStats(conditionIds).catch(() => new Map());
  for (const candidate of candidates) {
    if (!candidate.conditionId) continue;
    const stats = history.get(candidate.conditionId);
    if (!stats) continue;

    const persistenceBoost = Math.min(
      8,
      Math.log2(stats.observations + 1) * 2 +
      Math.min(4, stats.executableObservations * 2)
    );

    candidate.historicalEvidence = {
      ...stats,
      persistenceBoost: round(persistenceBoost, 2)
    };

    if (!isPoliticalCandidate(candidate)) {
      candidate.attentionScore = round(
        Math.min(100, (candidate.attentionScore ?? candidate.opportunityScore) + persistenceBoost),
        1
      );
    }

    if (stats.observations >= 2) candidate.flags.push("repeated_market_observation");
    if (candidate.opportunityClass === "executable_structural" && stats.executableObservations >= 1) {
      candidate.flags.push("repeated_structural_edge");
    }
  }
}

function finalizeDiscoveryScores(candidates: ScanCandidate[]) {
  for (const candidate of candidates) {
    const makerScore = candidate.makerEdge?.makerOpportunityScore ?? 0;
    const resolutionSafety = 100 - (candidate.resolutionIntelligence?.resolutionRiskScore ?? 50);
    const bestCrossVenue = candidate.crossVenue?.[0];
    const crossVenueScore = bestCrossVenue
      ? bestCrossVenue.classification === "cross_venue_arb_candidate"
        ? 100
        : bestCrossVenue.classification === "cross_venue_relative_value"
          ? bestCrossVenue.resolutionMatchScore * 80
          : bestCrossVenue.matchScore * 45
      : 0;
    const smartScore = candidate.smartMoney?.weightedSmartMoneyScore ?? 0;

    if (isPoliticalCandidate(candidate)) {
      candidate.attentionScore = candidate.opportunityScore;
      candidate.discoveryScore = candidate.opportunityScore;
      candidate.opportunityPacketScore = round(
        candidate.opportunityScore * 0.75 +
        makerScore * 0.10 +
        resolutionSafety * 0.10 +
        (bestCrossVenue?.classification === "cross_venue_arb_candidate" ? 100 : 0) * 0.05,
        1
      );
      continue;
    }

    const attention = candidate.attentionScore ?? candidate.opportunityScore;
    candidate.discoveryScore =
      candidate.opportunityClass === "executable_structural"
        ? candidate.opportunityScore
        : candidate.opportunityClass === "top_book_structural_only"
          ? round(Math.max(candidate.opportunityScore, attention * 0.85), 1)
          : round(Math.max(candidate.opportunityScore, attention), 1);

    candidate.opportunityPacketScore = round(
      Math.min(
        100,
        candidate.opportunityScore * 0.30 +
        (candidate.discoveryScore ?? candidate.opportunityScore) * 0.18 +
        makerScore * 0.14 +
        smartScore * 0.14 +
        crossVenueScore * 0.14 +
        resolutionSafety * 0.10
      ),
      1
    );
  }
}

function opportunityClassRank(value: OpportunityClass) {
  return value === "executable_structural" ? 3 :
    value === "top_book_structural_only" ? 2 : 1;
}

function compareDiscovery(a: ScanCandidate, b: ScanCandidate) {
  const classDelta = opportunityClassRank(b.opportunityClass) - opportunityClassRank(a.opportunityClass);
  if (classDelta !== 0) return classDelta;

  if (a.opportunityClass === "executable_structural" || b.opportunityClass === "executable_structural") {
    return b.opportunityScore - a.opportunityScore ||
      (b.discoveryScore ?? 0) - (a.discoveryScore ?? 0) ||
      a.minutesRemaining - b.minutesRemaining;
  }

  return (b.discoveryScore ?? b.opportunityScore) - (a.discoveryScore ?? a.opportunityScore) ||
    b.opportunityScore - a.opportunityScore ||
    a.minutesRemaining - b.minutesRemaining;
}

export async function scanClosingSoon(options?: {
  maxMinutes?: number;
  minLiquidity?: number;
  includeOrderBooks?: boolean;
  limit?: number;
  offset?: number;
  sort?: "soonest" | "review_score" | "liquidity" | "opportunity";
  bufferBps?: number;
}): Promise<ScanResult> {
  const maxMinutes = Math.min(120, Math.max(1, options?.maxMinutes ?? 120));
  const minLiquidity = Math.max(0, options?.minLiquidity ?? 0);
  const includeOrderBooks = options?.includeOrderBooks ?? true;
  const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
  const offset = Math.max(0, options?.offset ?? 0);
  const sort = options?.sort ?? "soonest";
  const bufferBps = Math.max(0, options?.bufferBps ?? DEFAULT_BUFFER_BPS);
  const started = Date.now();
  const now = started;
  const cutoff = now + maxMinutes * 60000;

  const all = await listAllActiveMarkets();
  const inWindow = all
    .filter(m => {
      const endDate = getEndDate(m);
      if (!endDate) return false;
      const ts = Date.parse(endDate);
      return ts >= now && ts <= cutoff && m.active !== false && m.closed !== true && m.acceptingOrders !== false;
    })
    .filter(m => n(m.liquidityNum ?? m.liquidity) >= minLiquidity);

  const tokenIds = includeOrderBooks
    ? inWindow.flatMap(m => parseStringArray(m.clobTokenIds))
    : [];
  const allBooks = includeOrderBooks ? await getOrderBooks(tokenIds) : new Map<string, NormalizedBook>();

  const enriched = (await Promise.all(
    inWindow.map(m => enrichMarket(m, now, includeOrderBooks, allBooks, bufferBps))
  )).filter((x): x is ScanCandidate => x !== null);

  if (includeOrderBooks && enriched.length) {
    await enrichBehaviorSignals(enriched);
    await enrichExternalEvidence(enriched);
    await enrichHistoricalEvidence(enriched);
    await enrichAdvancedIntelligence(enriched);
  }

  finalizeDiscoveryScores(enriched);

  if (sort === "opportunity") {
    enriched.sort(compareDiscovery);
  } else if (sort === "review_score") {
    enriched.sort((a, b) => b.rapidReviewScore - a.rapidReviewScore || a.minutesRemaining - b.minutesRemaining);
  } else if (sort === "liquidity") {
    enriched.sort((a, b) => b.liquidityUsd - a.liquidityUsd || a.minutesRemaining - b.minutesRemaining);
  } else {
    enriched.sort((a, b) => a.minutesRemaining - b.minutesRemaining);
  }

  const eventBaskets = includeOrderBooks
    ? await buildEventBasketOpportunities(all, now, cutoff, allBooks, bufferBps)
    : [];

  const sliced = enriched.slice(offset, offset + limit);
  const scanDurationMs = Date.now() - started;

  recordSnapshot({
    at: new Date().toISOString(),
    totalActiveMarkets: all.length,
    totalInWindow: inWindow.length,
    scanDurationMs,
    candidateCount: enriched.length,
    executableCount:
      enriched.filter(candidate => candidate.opportunityClass === "executable_structural").length +
      eventBaskets.filter(basket => basket.bestNetProfitUsd > 0).length,
    topOpportunityScore: enriched[0]?.opportunityScore ?? null
  });

  return {
    generatedAt: new Date(now).toISOString(),
    maxMinutes,
    totalActiveMarketsScanned: all.length,
    totalInWindowBeforeFilters: inWindow.length,
    returned: sliced.length,
    scanDurationMs,
    candidates: sliced,
    eventBaskets
  };
}

export async function scanOpportunities(options?: {
  maxMinutes?: number;
  minLiquidity?: number;
  minOpportunityScore?: number;
  limit?: number;
  bufferBps?: number;
}) {
  const minOpportunityScore = Math.min(100, Math.max(0, options?.minOpportunityScore ?? 35));
  const scan = await scanClosingSoon({
    maxMinutes: options?.maxMinutes ?? 120,
    minLiquidity: options?.minLiquidity ?? 0,
    includeOrderBooks: true,
    limit: 500,
    sort: "opportunity",
    bufferBps: options?.bufferBps
  });

  const candidates = scan.candidates
    .filter(c => (c.discoveryScore ?? c.opportunityScore) >= minOpportunityScore)
    .slice(0, Math.min(200, Math.max(1, options?.limit ?? 50)));

  return {
    ...scan,
    minOpportunityScore,
    returned: candidates.length,
    candidates
  };
}

export async function scanBinaryArbitrage(maxMinutes = 120, limit = 100, bufferBps = DEFAULT_BUFFER_BPS) {
  const scan = await scanClosingSoon({
    maxMinutes,
    includeOrderBooks: true,
    limit: 500,
    sort: "opportunity",
    bufferBps
  });

  const opportunities = scan.candidates
    .filter(c => c.opportunityClass === "executable_structural" && c.binaryArbitrage)
    .sort((a, b) =>
      (b.binaryArbitrage?.bestNetProfitUsd || 0) - (a.binaryArbitrage?.bestNetProfitUsd || 0) ||
      (b.binaryArbitrage?.bestNetRoiPct || 0) - (a.binaryArbitrage?.bestNetRoiPct || 0)
    )
    .slice(0, Math.min(200, Math.max(1, limit)));

  return {
    ...scan,
    returned: opportunities.length,
    candidates: opportunities
  };
}


function sortCandidates(candidates: ScanCandidate[], sort: "soonest" | "review_score" | "liquidity" | "opportunity" = "opportunity") {
  if (sort === "opportunity") {
    candidates.sort(compareDiscovery);
  } else if (sort === "review_score") {
    candidates.sort((a, b) => b.rapidReviewScore - a.rapidReviewScore || a.minutesRemaining - b.minutesRemaining);
  } else if (sort === "liquidity") {
    candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd || a.minutesRemaining - b.minutesRemaining);
  } else {
    candidates.sort((a, b) => a.minutesRemaining - b.minutesRemaining);
  }
  return candidates;
}

function categoryCounts(candidates: ScanCandidate[]) {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    for (const category of candidate.categories) {
      counts[category] = (counts[category] || 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

function buildLane(
  key: MultiHorizonLane["key"],
  maxMinutes: number,
  enriched: ScanCandidate[],
  limit: number
): MultiHorizonLane {
  const candidates = enriched
    .filter(candidate => candidate.minutesRemaining >= 0 && candidate.minutesRemaining <= maxMinutes)
    .sort(compareDiscovery);

  return {
    key,
    maxMinutes,
    totalInWindow: candidates.length,
    returned: Math.min(limit, candidates.length),
    categoryCounts: categoryCounts(candidates),
    candidates: candidates.slice(0, limit)
  };
}

export async function scanMultiHorizon(options?: {
  minLiquidity?: number;
  limitPerLane?: number;
  structuralLimit?: number;
  bufferBps?: number;
}): Promise<MultiHorizonScanResult> {
  const started = Date.now();
  const now = started;
  const minLiquidity = Math.max(0, options?.minLiquidity ?? 0);
  const limitPerLane = Math.min(500, Math.max(1, options?.limitPerLane ?? 100));
  const structuralLimit = Math.min(500, Math.max(1, options?.structuralLimit ?? 200));
  const bufferBps = Math.max(0, options?.bufferBps ?? DEFAULT_BUFFER_BPS);

  const all = (await listAllActiveMarkets())
    .filter(market =>
      market.active !== false &&
      market.closed !== true &&
      market.acceptingOrders !== false &&
      n(market.liquidityNum ?? market.liquidity) >= minLiquidity
    );

  const tokenIds = [...new Set(
    all.flatMap(market => parseStringArray(market.clobTokenIds))
  )];
  const allBooks = await getOrderBooks(tokenIds);

  const enrichedAll = (await Promise.all(
    all.map(market => enrichMarket(market, now, true, allBooks, bufferBps))
  )).filter((candidate): candidate is ScanCandidate => candidate !== null);

  // Expensive behavioral/external enrichment is reserved for the <=24h research universe.
  // Structural execution math above still covers every active market.
  const within24h = enrichedAll.filter(candidate => candidate.minutesRemaining <= 1440);
  if (within24h.length) {
    await enrichBehaviorSignals(within24h);
    await enrichExternalEvidence(within24h);
    await enrichHistoricalEvidence(within24h);
    await enrichAdvancedIntelligence(within24h);
  }

  // Historical repetition can still strengthen metadata on structural candidates beyond 24h
  // without invoking external directional feeds.
  const structuralBeyond24h = enrichedAll.filter(candidate =>
    candidate.minutesRemaining > 1440 &&
    candidate.opportunityClass !== "research_candidate"
  );
  if (structuralBeyond24h.length) {
    await enrichHistoricalEvidence(structuralBeyond24h);
  }

  finalizeDiscoveryScores(enrichedAll);

  const urgent2h = buildLane("urgent_2h", 120, enrichedAll, limitPerLane);
  const developing6h = buildLane("developing_6h", 360, enrichedAll, limitPerLane);
  const broader24h = buildLane("broader_24h", 1440, enrichedAll, limitPerLane);

  const structuralBinary = enrichedAll
    .filter(candidate =>
      candidate.opportunityClass === "executable_structural" ||
      candidate.opportunityClass === "top_book_structural_only"
    )
    .sort(compareDiscovery)
    .slice(0, structuralLimit);

  const latestEndTs = all.reduce((maxTs, market) => {
    const end = getEndDate(market);
    if (!end) return maxTs;
    const ts = Date.parse(end);
    return Number.isFinite(ts) ? Math.max(maxTs, ts) : maxTs;
  }, now);

  const eventBaskets = await buildEventBasketOpportunities(
    all,
    now,
    latestEndTs,
    allBooks,
    bufferBps
  );

  const logicalViolations = findStructuralGraphViolations(enrichedAll);
  if (logicalViolations.length) {
    const byCondition = new Map<string, typeof logicalViolations>();
    for (const violation of logicalViolations) {
      for (const conditionId of [
        violation.easierConditionId,
        violation.harderConditionId
      ]) {
        if (!conditionId) continue;
        const existing = byCondition.get(conditionId) || [];
        existing.push(violation);
        byCondition.set(conditionId, existing);
      }
    }

    for (const candidate of enrichedAll) {
      if (!candidate.conditionId) continue;
      const relations = byCondition.get(candidate.conditionId);
      if (!relations?.length) continue;
      candidate.logicalRelations = relations.slice(0, 10);
      if (!candidate.flags.includes("logical_relative_value_candidate")) {
        candidate.flags.push("logical_relative_value_candidate");
      }
      if (!isPoliticalCandidate(candidate)) {
        candidate.opportunityPacketScore = round(
          Math.min(
            100,
            (candidate.opportunityPacketScore ?? candidate.discoveryScore ?? candidate.opportunityScore) +
            Math.min(12, relations[0].violationProbabilityPoints * 0.4)
          ),
          1
        );
      }
    }
  }
  const scanDurationMs = Date.now() - started;

  return {
    generatedAt: new Date(now).toISOString(),
    totalActiveMarketsScanned: all.length,
    scanDurationMs,
    bufferBps,
    lanes: {
      urgent2h,
      developing6h,
      broader24h
    },
    structuralUniverse: {
      binary: structuralBinary,
      eventBaskets: eventBaskets.slice(0, structuralLimit),
      categoryCounts: categoryCounts(structuralBinary),
      executableCount:
        structuralBinary.filter(candidate => candidate.opportunityClass === "executable_structural").length +
        eventBaskets.filter(basket => basket.bestNetProfitUsd > 0).length,
      topBookOnlyCount:
        structuralBinary.filter(candidate => candidate.opportunityClass === "top_book_structural_only").length +
        eventBaskets.filter(basket =>
          basket.bestNetProfitUsd <= 0 &&
          basket.flags.includes("top_book_complete_set_edge")
        ).length
    },
    logicalViolations
  };
}
