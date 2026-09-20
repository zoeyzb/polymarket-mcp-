import type { MarketCategory } from "./category-taxonomy.js";
import type { GammaMarket, NormalizedBook } from "./types.js";

export interface MakerEdgeEstimate {
  feeEnabled: boolean;
  feeRate: number;
  makerRebatePoolRate: number;
  midpoint: number | null;
  spread: number | null;
  halfSpreadCapturePerShare: number | null;
  feeEquivalentPer100Shares: number | null;
  indicativeRebatePoolContributionPer100Shares: number | null;
  topDepthUsd: number;
  adverseSelectionRisk: number;
  inventoryRisk: number;
  makerOpportunityScore: number;
  rewardMetadata: {
    rewardsMinSize: number | null;
    rewardsMaxSpread: number | null;
    dailyReward: number | null;
  };
  flags: string[];
  note: string;
}

function n(value: unknown): number | null {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function feeConfig(category: MarketCategory) {
  switch (category) {
    case "crypto":
      return { feeRate: 0.07, rebatePoolRate: 0.20 };
    case "sports":
    case "basketball":
    case "nba":
    case "soccer":
    case "games_esports":
      return { feeRate: 0.05, rebatePoolRate: 0.20 };
    case "finance":
    case "politics":
    case "elections":
    case "mentions":
    case "tech":
      return { feeRate: 0.04, rebatePoolRate: 0.25 };
    case "economy":
    case "fed_rates":
    case "culture":
    case "weather":
    case "science_climate":
    case "movies":
    case "business":
    case "other":
    case "weekly":
    case "recurring":
    case "new_listing":
    case "trending":
    case "ending_soon":
      return { feeRate: 0.05, rebatePoolRate: 0.25 };
    case "geopolitics":
    case "world":
      return { feeRate: 0, rebatePoolRate: 0 };
    default:
      return { feeRate: 0.05, rebatePoolRate: 0.25 };
  }
}

function rewardField(market: GammaMarket, keys: string[]) {
  for (const key of keys) {
    const value = n((market as any)[key]);
    if (value !== null) return value;
  }
  return null;
}

export function estimateMakerEdge(
  market: GammaMarket,
  primaryCategory: MarketCategory,
  book: NormalizedBook | null,
  volatilityScore = 0,
  tradeImbalance = 0
): MakerEdgeEstimate {
  const { feeRate, rebatePoolRate } = feeConfig(primaryCategory);
  const explicitFeeFlag =
    (market as any).feesEnabled ??
    (market as any).fees_enabled;
  const feeEnabled =
    explicitFeeFlag === false
      ? false
      : explicitFeeFlag === true
        ? true
        : feeRate > 0;

  const midpoint = book?.midpoint ?? null;
  const spread = book?.spread ?? null;
  const halfSpread = spread === null ? null : spread / 2;
  const effectiveFeeRate = feeEnabled ? feeRate : 0;
  const effectiveRebatePoolRate = feeEnabled ? rebatePoolRate : 0;

  // Official taker fee-equivalent curve: C * feeRate * p * (1-p).
  // This is NOT the maker's guaranteed rebate. Maker rebates are a pro-rata
  // distribution of the daily pool and therefore require market-wide maker flow.
  const feeEquivalentPer100Shares =
    midpoint === null
      ? null
      : 100 * effectiveFeeRate * midpoint * (1 - midpoint);

  const indicativePoolContribution =
    feeEquivalentPer100Shares === null
      ? null
      : feeEquivalentPer100Shares * effectiveRebatePoolRate;

  const topDepthUsd =
    (book?.bidDepthUsdTop5 ?? 0) +
    (book?.askDepthUsdTop5 ?? 0);

  const adverseSelectionRisk = clamp(
    volatilityScore * 0.55 +
    Math.min(100, Math.abs(tradeImbalance) * 100) * 0.30 +
    (spread === null ? 25 : Math.max(0, 25 - spread * 250)) * 0.15
  );

  const inventoryRisk = clamp(
    Math.abs(tradeImbalance) * 65 +
    Math.max(0, 25 - Math.log10(Math.max(1, topDepthUsd)) * 7)
  );

  const spreadScore =
    halfSpread === null
      ? 0
      : clamp(halfSpread * 1800);
  const depthScore = clamp(Math.log10(Math.max(1, topDepthUsd)) * 18);
  const rebateScore = clamp((indicativePoolContribution ?? 0) * 120);
  const makerOpportunityScore = round(clamp(
    spreadScore * 0.38 +
    depthScore * 0.25 +
    rebateScore * 0.17 +
    (100 - adverseSelectionRisk) * 0.12 +
    (100 - inventoryRisk) * 0.08
  ), 1);

  const rewardsMinSize = rewardField(market, [
    "rewardsMinSize",
    "rewards_min_size",
    "rewardsMinSizeUsd"
  ]);
  const rewardsMaxSpread = rewardField(market, [
    "rewardsMaxSpread",
    "rewards_max_spread"
  ]);
  const dailyReward = rewardField(market, [
    "rewardsDailyRate",
    "rewards_daily_rate",
    "dailyReward",
    "daily_reward"
  ]);

  const flags: string[] = [];
  if (feeEnabled && feeRate > 0) flags.push("maker_rebate_eligible_category");
  if (spread !== null && spread >= 0.03) flags.push("wide_spread");
  if (topDepthUsd < 5_000) flags.push("thin_top_depth");
  if (adverseSelectionRisk >= 65) flags.push("high_adverse_selection_risk");
  if (inventoryRisk >= 65) flags.push("high_inventory_risk");
  if (rewardsMaxSpread !== null || dailyReward !== null) flags.push("liquidity_rewards_metadata_present");

  return {
    feeEnabled,
    feeRate: effectiveFeeRate,
    makerRebatePoolRate: effectiveRebatePoolRate,
    midpoint,
    spread,
    halfSpreadCapturePerShare: halfSpread === null ? null : round(halfSpread, 6),
    feeEquivalentPer100Shares:
      feeEquivalentPer100Shares === null ? null : round(feeEquivalentPer100Shares, 6),
    indicativeRebatePoolContributionPer100Shares:
      indicativePoolContribution === null ? null : round(indicativePoolContribution, 6),
    topDepthUsd: round(topDepthUsd, 2),
    adverseSelectionRisk: round(adverseSelectionRisk, 1),
    inventoryRisk: round(inventoryRisk, 1),
    makerOpportunityScore,
    rewardMetadata: {
      rewardsMinSize,
      rewardsMaxSpread,
      dailyReward
    },
    flags,
    note:
      "Indicative maker economics only; rebate/reward profit is not guaranteed. Actual payout depends on your executed maker share, competing maker fee-equivalent, inventory path, and adverse selection."
  };
}
