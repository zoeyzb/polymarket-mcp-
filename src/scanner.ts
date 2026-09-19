import {
  getOrderBooks,
  listActiveMarketsEndingBetween,
  parseNumberArray,
  parseStringArray
} from "./polymarket.js";
import type {
  CompleteSetExecution,
  ExecutionEstimate,
  GammaMarket,
  NormalizedBook,
  OpportunityClass,
  ScanCandidate,
  ScanResult
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

  return {
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
    opportunityClass: opportunity.opportunityClass,
    opportunityScore: opportunity.opportunityScore,
    rapidReviewScore: scoring.score,
    scoreBreakdown: scoring.breakdown,
    flags: scoring.flags
  };
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

  const all = await listActiveMarketsEndingBetween(new Date(now), new Date(cutoff));
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

  if (sort === "opportunity") {
    enriched.sort((a, b) => b.opportunityScore - a.opportunityScore || a.minutesRemaining - b.minutesRemaining);
  } else if (sort === "review_score") {
    enriched.sort((a, b) => b.rapidReviewScore - a.rapidReviewScore || a.minutesRemaining - b.minutesRemaining);
  } else if (sort === "liquidity") {
    enriched.sort((a, b) => b.liquidityUsd - a.liquidityUsd || a.minutesRemaining - b.minutesRemaining);
  } else {
    enriched.sort((a, b) => a.minutesRemaining - b.minutesRemaining);
  }

  const sliced = enriched.slice(offset, offset + limit);
  return {
    generatedAt: new Date(now).toISOString(),
    maxMinutes,
    totalActiveMarketsScanned: all.length,
    totalInWindowBeforeFilters: inWindow.length,
    returned: sliced.length,
    scanDurationMs: Date.now() - started,
    candidates: sliced
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
    .filter(c => c.opportunityScore >= minOpportunityScore)
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
