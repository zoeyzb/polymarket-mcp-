import type { ScanCandidate } from "./types.js";

const KALSHI_BASE =
  process.env.KALSHI_API_BASE ||
  "https://external-api.kalshi.com/trade-api/v2";
const CACHE_MS = Math.max(5_000, Number(process.env.KALSHI_MARKET_CACHE_MS || 30_000));
const TIMEOUT_MS = Math.max(2_000, Number(process.env.KALSHI_TIMEOUT_MS || 10_000));

export interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  close_time?: string;
  expected_expiration_time?: string;
  expiration_time?: string;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  no_bid_dollars?: string | number;
  no_ask_dollars?: string | number;
  liquidity_dollars?: string | number;
  volume_24h_fp?: string | number;
  rules_primary?: string;
  rules_secondary?: string;
  mve_selected_legs?: unknown[];
  [key: string]: unknown;
}

export interface CrossVenueMatch {
  kalshiTicker: string;
  kalshiTitle: string;
  matchScore: number;
  resolutionMatchScore: number;
  titleSimilarity: number;
  numericMatch: number;
  timeMatch: number;
  rulesSimilarity: number;
  polymarketYesAsk: number | null;
  polymarketNoAsk: number | null;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  bestComplementCost: number | null;
  grossEdge: number | null;
  conservativeFeeBuffer: number;
  netEdgeAfterBuffer: number | null;
  classification:
    | "cross_venue_arb_candidate"
    | "cross_venue_relative_value"
    | "semantic_match_only";
  flags: string[];
}

let cache: { at: number; markets: KalshiMarket[] } | null = null;

function n(value: unknown): number | null {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "zoey-polymarket-mcp/0.4"
      }
    });
    if (!response.ok) throw new Error(`Kalshi ${response.status}: ${url}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function listOpenKalshiMarkets(maxPages = 20, pageSize = 1000) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.markets;

  const out: KalshiMarket[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      status: "open",
      limit: String(pageSize)
    });
    if (cursor) params.set("cursor", cursor);

    const payload = await fetchJson<{
      markets?: KalshiMarket[];
      cursor?: string;
    }>(`${KALSHI_BASE}/markets?${params}`);

    const markets = Array.isArray(payload.markets) ? payload.markets : [];
    out.push(...markets.filter(market =>
      !String(market.ticker || "").includes("KXMVE") &&
      !(Array.isArray(market.mve_selected_legs) && market.mve_selected_legs.length > 0)
    ));

    cursor = String(payload.cursor || "");
    if (!cursor || markets.length === 0) break;
  }

  cache = { at: Date.now(), markets: out };
  return out;
}

const STOPWORDS = new Set([
  "will","the","a","an","be","is","are","was","were","to","of","in","on","at","by",
  "for","and","or","with","from","as","this","that","before","after","than","during",
  "yes","no","market","event","contract","close","closing"
]);

function tokens(text: string) {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/\$([0-9])/g, " $1")
      .replace(/[^a-z0-9.%]+/g, " ")
      .split(/\s+/)
      .filter(token => token.length >= 2 && !STOPWORDS.has(token))
  )];
}

function numericTokens(text: string) {
  return [...text.matchAll(/(?:\$)?(-?\d+(?:\.\d+)?)(%|k|m|b)?/gi)]
    .map(match => {
      let value = Number(match[1]);
      const suffix = String(match[2] || "").toLowerCase();
      if (suffix === "k") value *= 1_000;
      if (suffix === "m") value *= 1_000_000;
      if (suffix === "b") value *= 1_000_000_000;
      return Number.isFinite(value) ? value : null;
    })
    .filter((value): value is number => value !== null);
}

function jaccard(a: string[], b: string[]) {
  const sa = new Set(a);
  const sb = new Set(b);
  const union = new Set([...sa, ...sb]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const token of sa) if (sb.has(token)) intersection += 1;
  return intersection / union.size;
}

function numericSimilarity(a: string, b: string) {
  const na = numericTokens(a);
  const nb = numericTokens(b);
  if (!na.length && !nb.length) return 1;
  if (!na.length || !nb.length) return 0;
  const matched = na.filter(value =>
    nb.some(other => Math.abs(value - other) <= Math.max(1e-6, Math.abs(value) * 0.0001))
  ).length;
  return matched / Math.max(na.length, nb.length);
}

function timeSimilarity(polyEnd: string, kalshi: KalshiMarket) {
  const a = Date.parse(polyEnd);
  const b = Date.parse(String(
    kalshi.expected_expiration_time ??
    kalshi.close_time ??
    kalshi.expiration_time ??
    ""
  ));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.5;
  const hours = Math.abs(a - b) / 3_600_000;
  if (hours <= 1) return 1;
  if (hours <= 6) return 0.85;
  if (hours <= 24) return 0.55;
  if (hours <= 72) return 0.25;
  return 0;
}

function rulesSimilarity(candidate: ScanCandidate, kalshi: KalshiMarket) {
  const polyRules = candidate.resolutionRules || candidate.resolutionSource || "";
  const kalshiRules = [kalshi.rules_primary, kalshi.rules_secondary]
    .filter(Boolean)
    .join(" ");
  if (!polyRules || !kalshiRules) return 0.5;
  return jaccard(tokens(polyRules), tokens(kalshiRules));
}

function yesNoAsks(candidate: ScanCandidate) {
  const outcomes = candidate.outcomes.map(outcome => outcome.toLowerCase());
  const yesIndex = outcomes.indexOf("yes");
  const noIndex = outcomes.indexOf("no");
  if (yesIndex < 0 || noIndex < 0 || !candidate.books) {
    return { yesAsk: null, noAsk: null };
  }
  return {
    yesAsk: candidate.books[yesIndex]?.bestAsk ?? null,
    noAsk: candidate.books[noIndex]?.bestAsk ?? null
  };
}

export function matchCandidateToKalshi(
  candidate: ScanCandidate,
  markets: KalshiMarket[],
  limit = 3
): CrossVenueMatch[] {
  const candidateText = [
    candidate.question,
    candidate.resolutionRules || "",
    candidate.resolutionSource || ""
  ].join(" ");
  const candidateTokens = tokens(candidate.question);
  const { yesAsk, noAsk } = yesNoAsks(candidate);
  const conservativeFeeBuffer = Math.max(
    0,
    Number(process.env.CROSS_VENUE_FEE_BUFFER || 0.02)
  );

  return markets
    .map(market => {
      const kalshiTitle = [
        market.title,
        market.subtitle,
        market.yes_sub_title
      ].filter(Boolean).join(" ");
      const titleSimilarity = jaccard(candidateTokens, tokens(kalshiTitle));
      const numericMatch = numericSimilarity(candidate.question, kalshiTitle);
      const timeMatch = timeSimilarity(candidate.endDate, market);
      const rulesSim = rulesSimilarity(candidate, market);

      const matchScore =
        titleSimilarity * 0.55 +
        numericMatch * 0.25 +
        timeMatch * 0.20;
      const resolutionMatchScore =
        titleSimilarity * 0.35 +
        numericMatch * 0.25 +
        timeMatch * 0.20 +
        rulesSim * 0.20;

      const kalshiYes = n(market.yes_ask_dollars);
      const kalshiNo = n(market.no_ask_dollars);
      const complementCosts = [
        yesAsk !== null && kalshiNo !== null ? yesAsk + kalshiNo : null,
        noAsk !== null && kalshiYes !== null ? noAsk + kalshiYes : null
      ].filter((value): value is number => value !== null && value > 0);

      const bestComplementCost = complementCosts.length
        ? Math.min(...complementCosts)
        : null;
      const grossEdge = bestComplementCost === null ? null : 1 - bestComplementCost;
      const netEdge = grossEdge === null ? null : grossEdge - conservativeFeeBuffer;

      let classification: CrossVenueMatch["classification"] = "semantic_match_only";
      if (
        matchScore >= 0.68 &&
        resolutionMatchScore >= 0.72
      ) {
        classification = "cross_venue_relative_value";
      }
      if (
        matchScore >= 0.86 &&
        resolutionMatchScore >= 0.88 &&
        netEdge !== null &&
        netEdge > 0
      ) {
        classification = "cross_venue_arb_candidate";
      }

      const flags: string[] = [];
      if (numericMatch === 1) flags.push("numeric_terms_match");
      if (timeMatch >= 0.85) flags.push("expiration_times_close");
      if (rulesSim < 0.75) flags.push("resolution_rules_need_manual_verification");
      if (grossEdge !== null && grossEdge > 0) flags.push("gross_complementary_edge");
      if (classification === "cross_venue_arb_candidate") {
        flags.push("clears_conservative_fee_buffer");
      }

      return {
        kalshiTicker: String(market.ticker || ""),
        kalshiTitle: String(kalshiTitle || market.ticker || ""),
        matchScore: Number(matchScore.toFixed(4)),
        resolutionMatchScore: Number(resolutionMatchScore.toFixed(4)),
        titleSimilarity: Number(titleSimilarity.toFixed(4)),
        numericMatch: Number(numericMatch.toFixed(4)),
        timeMatch: Number(timeMatch.toFixed(4)),
        rulesSimilarity: Number(rulesSim.toFixed(4)),
        polymarketYesAsk: yesAsk,
        polymarketNoAsk: noAsk,
        kalshiYesAsk: kalshiYes,
        kalshiNoAsk: kalshiNo,
        bestComplementCost:
          bestComplementCost === null ? null : Number(bestComplementCost.toFixed(6)),
        grossEdge: grossEdge === null ? null : Number(grossEdge.toFixed(6)),
        conservativeFeeBuffer,
        netEdgeAfterBuffer: netEdge === null ? null : Number(netEdge.toFixed(6)),
        classification,
        flags
      };
    })
    .filter(match => match.matchScore >= 0.45)
    .sort((a, b) =>
      (b.classification === "cross_venue_arb_candidate" ? 1 : 0) -
        (a.classification === "cross_venue_arb_candidate" ? 1 : 0) ||
      b.resolutionMatchScore - a.resolutionMatchScore ||
      b.matchScore - a.matchScore
    )
    .slice(0, Math.max(1, Math.min(10, limit)));
}
