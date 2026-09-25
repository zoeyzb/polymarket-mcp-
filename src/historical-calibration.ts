import type { GammaMarket } from "./types.js";
import { getPriceHistoryRange, parseNumberArray, parseStringArray } from "./polymarket.js";
import { isPoliticalMarket } from "./domain-policy.js";

export type HistoricalDomain = "sports" | "crypto" | "weather" | "other";

export interface HistoricalCalibrationSample {
  conditionId: string;
  marketId: string | null;
  slug: string | null;
  question: string;
  domain: HistoricalDomain;
  resolvedAt: string;
  outcome0: string;
  outcome1: string;
  actualOutcome0: 0 | 1;
  winningOutcome: string;
  token0Id: string;
  prices: Record<string, number>;
  brier: Record<string, number>;
  sourcePayload: {
    finalOutcomePrices: number[];
    horizonsMinutes: number[];
    availableHorizons: string[];
  };
}

const HORIZONS_MINUTES = [120, 60, 30, 15, 5] as const;

function textField(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function classifyHistoricalDomain(market: GammaMarket): HistoricalDomain | null {
  if (isPoliticalMarket(market)) return null;

  const question = textField(market.question).toLowerCase();
  const slug = textField(market.slug).toLowerCase();
  const category = textField(market.category).toLowerCase();
  const sportsMarketType = textField(market.sportsMarketType).toLowerCase();
  const event = Array.isArray(market.events) && market.events.length
    ? market.events[0] as Record<string, unknown>
    : {};
  const seriesSlug = textField(event.seriesSlug).toLowerCase();
  const eventTitle = textField(event.title).toLowerCase();
  const haystack = [question, slug, category, sportsMarketType, seriesSlug, eventTitle].join(" ");

  if (
    sportsMarketType ||
    market.gameId !== undefined ||
    /\b(nfl|nba|mlb|nhl|wnba|ncaa|soccer|football|baseball|basketball|hockey|tennis|ufc|mma|counter[- ]?strike|cs2|valorant|league of legends|dota|cricket|rugby|golf|esports)\b/i.test(haystack)
  ) {
    return "sports";
  }

  if (
    /\b(bitcoin|btc|ethereum|ether|eth|solana|\bsol\b|xrp|ripple|dogecoin|doge|crypto|cryptocurrency)\b/i.test(haystack)
  ) {
    return "crypto";
  }

  if (
    /\b(weather|temperature|degrees?|rainfall|precipitation|snowfall|snow|hurricane|tropical storm|wind speed|heat index|coldest|hottest)\b/i.test(haystack)
  ) {
    return "weather";
  }

  return "other";
}

function parseResolvedAt(market: GammaMarket): string | null {
  const candidates = [
    market.closedTime,
    market.umaEndDate,
    market.endDate,
    market.endDateIso
  ];
  for (const value of candidates) {
    if (!value) continue;
    const timestamp = Date.parse(String(value));
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

function parseHistory(payload: unknown): Array<{ t: number; p: number }> {
  const history = Array.isArray((payload as any)?.history)
    ? (payload as any).history
    : Array.isArray(payload)
      ? payload
      : [];

  return history
    .map((point: any) => ({
      t: Number(point?.t ?? point?.timestamp),
      p: Number(point?.p ?? point?.price)
    }))
    .filter((point: { t: number; p: number }) =>
      Number.isFinite(point.t) &&
      Number.isFinite(point.p) &&
      point.p >= 0 &&
      point.p <= 1
    )
    .sort((a: { t: number }, b: { t: number }) => a.t - b.t);
}

function nearestPrice(
  points: Array<{ t: number; p: number }>,
  targetTs: number,
  toleranceSeconds = 12 * 60
): number | null {
  let best: { distance: number; p: number } | null = null;
  for (const point of points) {
    const distance = Math.abs(point.t - targetTs);
    if (distance > toleranceSeconds) continue;
    if (!best || distance < best.distance) best = { distance, p: point.p };
  }
  return best?.p ?? null;
}

export async function buildHistoricalCalibrationSample(
  market: GammaMarket
): Promise<HistoricalCalibrationSample | null> {
  const domain = classifyHistoricalDomain(market);
  if (!domain) return null;

  const conditionId = textField(market.conditionId);
  const question = textField(market.question);
  const outcomes = parseStringArray(market.outcomes);
  const finalPrices = parseNumberArray(market.outcomePrices);
  const tokenIds = parseStringArray(market.clobTokenIds);
  const resolvedAt = parseResolvedAt(market);

  if (!conditionId || !question || outcomes.length !== 2 || finalPrices.length !== 2 || tokenIds.length !== 2 || !resolvedAt) {
    return null;
  }

  const winnerIndex =
    finalPrices[0] >= 0.999 && finalPrices[1] <= 0.001 ? 0 :
    finalPrices[1] >= 0.999 && finalPrices[0] <= 0.001 ? 1 :
    -1;

  if (winnerIndex < 0) return null;

  const resolvedTs = Math.floor(Date.parse(resolvedAt) / 1000);
  if (!Number.isFinite(resolvedTs)) return null;

  const historyPayload = await getPriceHistoryRange(
    tokenIds[0],
    resolvedTs - 150 * 60,
    resolvedTs,
    5
  ).catch(() => null);

  if (!historyPayload) return null;
  const points = parseHistory(historyPayload);
  if (!points.length) return null;

  const actualOutcome0 = winnerIndex === 0 ? 1 : 0;
  const prices: Record<string, number> = {};
  const brier: Record<string, number> = {};

  for (const horizon of HORIZONS_MINUTES) {
    const probability = nearestPrice(points, resolvedTs - horizon * 60);
    if (probability === null) continue;
    const key = `tMinus${horizon}m`;
    prices[key] = Number(probability.toFixed(6));
    brier[key] = Number(Math.pow(probability - actualOutcome0, 2).toFixed(8));
  }

  if (Object.keys(prices).length < 2) return null;

  return {
    conditionId,
    marketId: market.id ? String(market.id) : null,
    slug: market.slug ? String(market.slug) : null,
    question,
    domain,
    resolvedAt,
    outcome0: outcomes[0],
    outcome1: outcomes[1],
    actualOutcome0,
    winningOutcome: outcomes[winnerIndex],
    token0Id: tokenIds[0],
    prices,
    brier,
    sourcePayload: {
      finalOutcomePrices: finalPrices,
      horizonsMinutes: [...HORIZONS_MINUTES],
      availableHorizons: Object.keys(prices)
    }
  };
}
