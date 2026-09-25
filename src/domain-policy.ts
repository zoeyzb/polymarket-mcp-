import type { GammaMarket, ScanCandidate } from "./types.js";

function text(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function isPoliticalMarket(market: GammaMarket): boolean {
  const event = Array.isArray(market.events) && market.events.length
    ? market.events[0] as Record<string, unknown>
    : {};

  const haystack = [
    market.question,
    market.slug,
    market.description,
    market.category,
    event.title,
    event.slug,
    event.category,
    event.description
  ].map(text).join(" ");

  return /\b(politics|political|election|electoral|vote|voting|ballot|referendum|president|presidential|prime minister|parliament|parliamentary|congress|congressional|senate|senator|house of representatives|governor|gubernatorial|mayor|mayoral|state duma|bundestag|abgeordnetenhaus|legislative election|legislation|legislative|bill passes|executive order|government shutdown|federal reserve|fed decision|white house|supreme court|political party|party win|seats? in the|win the most seats|win between [0-9]+ and [0-9]+ seats|candidate)\b/i.test(haystack);
}

export function isPoliticalCandidate(candidate: ScanCandidate): boolean {
  return candidate.flags.includes("political_structural_only");
}

export const POLITICAL_DIRECTIONAL_FLAGS = new Set([
  "price_shock",
  "high_price_volatility",
  "price_trend",
  "strong_recent_trade_imbalance",
  "large_recent_trade",
  "near_external_resolution_threshold",
  "external_source_divergence",
  "single_external_source"
]);
