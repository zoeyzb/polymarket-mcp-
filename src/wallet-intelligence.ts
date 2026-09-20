import {
  getLeaderboardV2,
  getUserPositionsV2,
  getUserStatsV2,
  getUserTradesV2
} from "./polymarket.js";
import { classifyMarketCategories, primaryMarketCategory, type MarketCategory } from "./category-taxonomy.js";

export interface WalletCategoryStats {
  category: MarketCategory;
  positions: number;
  profitablePositions: number;
  winRate: number | null;
  realizedPnl: number;
  absolutePnl: number;
  shareOfSample: number;
}

export interface WalletIntelligenceProfile {
  walletAddress: string;
  userName: string | null;
  leaderboardRank: number | null;
  leaderboardPnl: number;
  leaderboardVolume: number;
  roiOnLeaderboardVolume: number | null;
  distinctMarkets: number;
  biggestWin: number;
  allTimeEconomicPnl: number | null;
  realizedMarketPnl: number | null;
  makerRebate: number;
  takerRebate: number;
  rewardIncome: number;
  volumeUsdc: number;
  tradeCount: number;
  sampledClosedPositions: number;
  sampledProfitablePositions: number;
  sampledWinRate: number | null;
  sampledProfitFactor: number | null;
  dominantCategory: MarketCategory | null;
  categoryStats: WalletCategoryStats[];
  recentTrades: Array<Record<string, unknown>>;
  smartScore: number;
  scoreBreakdown: {
    profitability: number;
    sampleConfidence: number;
    consistency: number;
    specialization: number;
    activity: number;
  };
  flags: string[];
}

function n(value: unknown) {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 2) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function extractAllTime(stats: Record<string, unknown> | null) {
  const allTime = stats?.all_time_pnl;
  return allTime && typeof allTime === "object"
    ? allTime as Record<string, unknown>
    : {};
}

function buildCategoryStats(closed: Array<Record<string, unknown>>): WalletCategoryStats[] {
  const bucket = new Map<MarketCategory, {
    positions: number;
    profitable: number;
    realized: number;
    absolute: number;
  }>();

  for (const position of closed) {
    const categories = classifyMarketCategories({
      question: String(position.title || ""),
      slug: String(position.slug || "")
    });
    const primary = primaryMarketCategory(categories);
    const realized = n(position.realized_pnl ?? position.total_pnl);
    const current = bucket.get(primary) || {
      positions: 0,
      profitable: 0,
      realized: 0,
      absolute: 0
    };
    current.positions += 1;
    if (realized > 0) current.profitable += 1;
    current.realized += realized;
    current.absolute += Math.abs(realized);
    bucket.set(primary, current);
  }

  const total = Math.max(1, closed.length);
  return [...bucket.entries()]
    .map(([category, stats]) => ({
      category,
      positions: stats.positions,
      profitablePositions: stats.profitable,
      winRate: stats.positions ? round(stats.profitable / stats.positions, 4) : null,
      realizedPnl: round(stats.realized, 2),
      absolutePnl: round(stats.absolute, 2),
      shareOfSample: round(stats.positions / total, 4)
    }))
    .sort((a, b) =>
      b.realizedPnl - a.realizedPnl ||
      b.positions - a.positions ||
      a.category.localeCompare(b.category)
    );
}

export function scoreWalletProfile(input: {
  leaderboard: Record<string, unknown>;
  stats: Record<string, unknown> | null;
  closedPositions: Array<Record<string, unknown>>;
  recentTrades: Array<Record<string, unknown>>;
}): WalletIntelligenceProfile {
  const { leaderboard, stats, closedPositions, recentTrades } = input;
  const allTime = extractAllTime(stats);
  const walletAddress = String(
    leaderboard.user_id ??
    stats?.proxy_wallet ??
    ""
  ).toLowerCase();

  const leaderboardPnl = n(leaderboard.pnl);
  const leaderboardVolume = n(leaderboard.volume);
  const roi = leaderboardVolume > 0 ? leaderboardPnl / leaderboardVolume : null;

  const profitable = closedPositions.filter(position =>
    n(position.realized_pnl ?? position.total_pnl) > 0
  ).length;
  const losses = closedPositions
    .map(position => n(position.realized_pnl ?? position.total_pnl))
    .filter(value => value < 0);
  const gains = closedPositions
    .map(position => n(position.realized_pnl ?? position.total_pnl))
    .filter(value => value > 0);
  const grossProfit = gains.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const winRate = closedPositions.length ? profitable / closedPositions.length : null;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : null;

  const categoryStats = buildCategoryStats(closedPositions);
  const dominant = categoryStats[0] ?? null;

  // Transparent, deliberately conservative components.
  const profitability = clamp(
    50 +
    (roi === null ? 0 : Math.tanh(roi * 8) * 35) +
    Math.tanh(leaderboardPnl / 250_000) * 15
  );

  const distinctMarkets = new Set(
    closedPositions
      .map(position => String(position.condition_id || ""))
      .filter(Boolean)
  ).size;
  const tradeCount = Math.max(
    0,
    Math.floor(n(allTime.trade_count) || n(stats?.trades))
  );
  const sampleConfidence = clamp(
    Math.log10(Math.max(1, distinctMarkets + 1)) * 24 +
    Math.log10(Math.max(1, tradeCount + 1)) * 10 +
    Math.log10(Math.max(1, closedPositions.length + 1)) * 10
  );

  const consistency = clamp(
    (winRate === null ? 35 : winRate * 70) +
    (profitFactor === null ? 0 : Math.min(30, Math.log1p(profitFactor) * 12))
  );

  const specialization = clamp(
    dominant
      ? dominant.shareOfSample * 70 +
        Math.tanh(Math.max(0, dominant.realizedPnl) / 100_000) * 30
      : 0
  );

  const recentNotional = recentTrades.reduce(
    (sum, trade) => sum + n(trade.size) * n(trade.price),
    0
  );
  const activity = clamp(
    Math.log10(Math.max(1, recentTrades.length + 1)) * 25 +
    Math.log10(Math.max(1, recentNotional + 1)) * 10
  );

  const smartScore = round(clamp(
    profitability * 0.32 +
    sampleConfidence * 0.24 +
    consistency * 0.20 +
    specialization * 0.14 +
    activity * 0.10
  ), 1);

  const flags: string[] = [];
  if (distinctMarkets >= 100) flags.push("large_market_sample");
  if (closedPositions.length >= 100) flags.push("large_closed_sample");
  if (dominant && dominant.shareOfSample >= 0.5) flags.push("category_specialist");
  if (roi !== null && roi > 0.05) flags.push("high_leaderboard_roi");
  if (n(allTime.maker_rebate) > n(allTime.taker_rebate)) flags.push("maker_rebate_heavy");
  if (leaderboardPnl > 0 && n(allTime.economic_pnl) < 0) {
    flags.push("leaderboard_vs_economic_pnl_divergence");
  }

  return {
    walletAddress,
    userName: leaderboard.user_name ? String(leaderboard.user_name) : null,
    leaderboardRank: Number.isFinite(Number(leaderboard.rank)) ? Number(leaderboard.rank) : null,
    leaderboardPnl: round(leaderboardPnl, 2),
    leaderboardVolume: round(leaderboardVolume, 2),
    roiOnLeaderboardVolume: roi === null ? null : round(roi, 6),
    distinctMarkets,
    biggestWin: round(n(stats?.biggest_win), 2),
    allTimeEconomicPnl: allTime.economic_pnl == null ? null : round(n(allTime.economic_pnl), 2),
    realizedMarketPnl: allTime.realized_market_pnl == null ? null : round(n(allTime.realized_market_pnl), 2),
    makerRebate: round(n(allTime.maker_rebate), 2),
    takerRebate: round(n(allTime.taker_rebate), 2),
    rewardIncome: round(n(allTime.reward_income), 2),
    volumeUsdc: round(n(allTime.volume_usdc), 2),
    tradeCount,
    sampledClosedPositions: closedPositions.length,
    sampledProfitablePositions: profitable,
    sampledWinRate: winRate === null ? null : round(winRate, 4),
    sampledProfitFactor: profitFactor === null ? null : round(profitFactor, 4),
    dominantCategory: dominant?.category ?? null,
    categoryStats,
    recentTrades,
    smartScore,
    scoreBreakdown: {
      profitability: round(profitability, 1),
      sampleConfidence: round(sampleConfidence, 1),
      consistency: round(consistency, 1),
      specialization: round(specialization, 1),
      activity: round(activity, 1)
    },
    flags
  };
}

export async function fetchTopWalletProfiles(limit = 20) {
  const leaderboard = await getLeaderboardV2(
    Math.min(100, Math.max(1, limit)),
    "all",
    "overall",
    "PNL"
  );

  const out: WalletIntelligenceProfile[] = [];
  const concurrency = 4;
  for (let i = 0; i < leaderboard.length; i += concurrency) {
    const batch = leaderboard.slice(i, i + concurrency);
    const profiles = await Promise.all(batch.map(async row => {
      const wallet = String(row.user_id || "");
      if (!/^0x[a-f0-9]{40}$/i.test(wallet)) return null;
      try {
        const [stats, closedPositions, recentTrades] = await Promise.all([
          getUserStatsV2(wallet),
          getUserPositionsV2(wallet, "CLOSED", 250),
          getUserTradesV2(wallet, 100)
        ]);
        return scoreWalletProfile({
          leaderboard: row,
          stats,
          closedPositions,
          recentTrades
        });
      } catch {
        return null;
      }
    }));
    for (const profile of profiles) if (profile) out.push(profile);
  }

  return out.sort((a, b) => b.smartScore - a.smartScore);
}
