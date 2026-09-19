import {
  getOrderBook,
  listActiveMarketsEndingBetween,
  parseNumberArray,
  parseStringArray
} from "./polymarket.js";
import type {
  ExecutionEstimate,
  GammaMarket,
  NormalizedBook,
  ScanCandidate,
  ScanResult
} from "./types.js";

const BUDGETS = [10, 25, 50, 100];

function n(value: unknown): number {
  const x = typeof value === "number" ? value : Number(value);
  return Number.isFinite(x) ? x : 0;
}

function getEndDate(market: GammaMarket): string | null {
  const raw = market.endDateIso || market.endDate;
  if (typeof raw !== "string" || !raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function executionEstimate(book: NormalizedBook, budgetUsd: number): ExecutionEstimate {
  const asks = Array.isArray(book.raw.asks)
    ? book.raw.asks
        .map(x => ({ price: n(x.price), size: n(x.size) }))
        .filter(x => x.price > 0 && x.price <= 1 && x.size > 0)
        .sort((a, b) => a.price - b.price)
    : [];

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
    spendableUsd: Number(spent.toFixed(4)),
    avgFillPrice: avg === null ? null : Number(avg.toFixed(6)),
    shares: Number(shares.toFixed(4)),
    maxPayoutIfWinning: Number(maxPayout.toFixed(4)),
    profitIfWinning: Number(profit.toFixed(4)),
    roiIfWinningPct: spent > 0 ? Number(((profit / spent) * 100).toFixed(2)) : null,
    fillPct: Number(((spent / budgetUsd) * 100).toFixed(2))
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
    score: Number(Math.min(100, Math.max(0, score)).toFixed(1)),
    breakdown: {
      spread: Number(spreadScore.toFixed(1)),
      liquidity: Number(liquidityScore.toFixed(1)),
      orderBookDepth: Number(depthScore.toFixed(1)),
      urgency: Number(urgencyScore.toFixed(1)),
      resolutionClarity: Number(rulesScore.toFixed(1)),
      activity: Number(activityScore.toFixed(1))
    },
    flags
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const current = next++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function enrichMarket(market: GammaMarket, now: number, includeBooks: boolean): Promise<ScanCandidate | null> {
  const endDate = getEndDate(market);
  if (!endDate) return null;
  const endTs = Date.parse(endDate);
  const minutesRemaining = (endTs - now) / 60000;
  if (minutesRemaining < 0) return null;

  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes);
  const displayedOutcomePrices = parseNumberArray(market.outcomePrices);
  let books: NormalizedBook[] = [];

  if (includeBooks && tokenIds.length) {
    books = await mapWithConcurrency(tokenIds, 4, async tokenId => {
      try {
        return await getOrderBook(tokenId);
      } catch {
        return {
          tokenId,
          bestBid: null,
          bestAsk: null,
          spread: null,
          midpoint: null,
          bidDepthUsdTop5: 0,
          askDepthUsdTop5: 0,
          raw: { bids: [], asks: [] }
        };
      }
    });
  }

  const scoring = scoreCandidate(market, minutesRemaining, books);
  let binaryArbitrage: ScanCandidate["binaryArbitrage"] = null;
  if (books.length === 2 && books[0].bestAsk !== null && books[1].bestAsk !== null) {
    const total = books[0].bestAsk + books[1].bestAsk;
    if (total < 1) {
      binaryArbitrage = {
        buyBothAskTotal: Number(total.toFixed(6)),
        grossEdgePerDollar: Number((1 - total).toFixed(6)),
        grossEdgePct: Number(((1 - total) * 100).toFixed(3)),
        note: "Structural only: both legs must actually fill at these asks; fees, slippage, size limits, and resolution risk can erase the edge."
      };
      scoring.flags.push("binary_buy_both_structural_edge");
    }
  }

  const marketBooks = books.map((book, i) => ({
    outcome: outcomes[i] || `Outcome ${i + 1}`,
    tokenId: book.tokenId,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    spread: book.spread,
    midpoint: book.midpoint,
    bidDepthUsdTop5: Number(book.bidDepthUsdTop5.toFixed(2)),
    askDepthUsdTop5: Number(book.askDepthUsdTop5.toFixed(2)),
    executions: BUDGETS.map(budget => executionEstimate(book, budget))
  }));

  return {
    id: market.id ? String(market.id) : null,
    slug: market.slug ? String(market.slug) : null,
    question: String(market.question || "Untitled market"),
    conditionId: market.conditionId ? String(market.conditionId) : null,
    endDate,
    minutesRemaining: Number(minutesRemaining.toFixed(2)),
    acceptingOrders: market.acceptingOrders !== false,
    liquidityUsd: Number(n(market.liquidityNum ?? market.liquidity).toFixed(2)),
    volumeUsd: Number(n(market.volumeNum ?? market.volume).toFixed(2)),
    volume24hUsd: Number(n(market.volume24hr).toFixed(2)),
    outcomes,
    tokenIds,
    displayedOutcomePrices,
    resolutionSource: market.resolutionSource ? String(market.resolutionSource) : null,
    resolutionRules: market.description ? String(market.description) : null,
    url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
    books: includeBooks ? marketBooks : undefined,
    binaryArbitrage,
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
  sort?: "soonest" | "review_score" | "liquidity";
}): Promise<ScanResult> {
  const maxMinutes = Math.min(120, Math.max(1, options?.maxMinutes ?? 120));
  const minLiquidity = Math.max(0, options?.minLiquidity ?? 0);
  const includeOrderBooks = options?.includeOrderBooks ?? true;
  const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
  const offset = Math.max(0, options?.offset ?? 0);
  const sort = options?.sort ?? "soonest";
  const now = Date.now();
  const cutoff = now + maxMinutes * 60000;

  const all = await listActiveMarketsEndingBetween(new Date(now), new Date(cutoff));
  const inWindow = all.filter(m => {
    const endDate = getEndDate(m);
    if (!endDate) return false;
    const ts = Date.parse(endDate);
    return ts >= now && ts <= cutoff && m.active !== false && m.closed !== true && m.acceptingOrders !== false;
  }).filter(m => n(m.liquidityNum ?? m.liquidity) >= minLiquidity);

  const enriched = (await mapWithConcurrency(inWindow, 8, m => enrichMarket(m, now, includeOrderBooks)))
    .filter((x): x is ScanCandidate => x !== null);

  if (sort === "review_score") enriched.sort((a, b) => b.rapidReviewScore - a.rapidReviewScore || a.minutesRemaining - b.minutesRemaining);
  else if (sort === "liquidity") enriched.sort((a, b) => b.liquidityUsd - a.liquidityUsd || a.minutesRemaining - b.minutesRemaining);
  else enriched.sort((a, b) => a.minutesRemaining - b.minutesRemaining);

  const sliced = enriched.slice(offset, offset + limit);
  return {
    generatedAt: new Date(now).toISOString(),
    maxMinutes,
    totalActiveMarketsScanned: all.length,
    totalInWindowBeforeFilters: inWindow.length,
    returned: sliced.length,
    candidates: sliced
  };
}

export async function scanBinaryArbitrage(maxMinutes = 120, limit = 100) {
  const scan = await scanClosingSoon({
    maxMinutes,
    includeOrderBooks: true,
    limit: 500,
    sort: "soonest"
  });
  const opportunities = scan.candidates
    .filter(c => c.binaryArbitrage)
    .sort((a, b) => (b.binaryArbitrage?.grossEdgePct || 0) - (a.binaryArbitrage?.grossEdgePct || 0))
    .slice(0, Math.min(200, Math.max(1, limit)));
  return {
    ...scan,
    returned: opportunities.length,
    candidates: opportunities
  };
}
