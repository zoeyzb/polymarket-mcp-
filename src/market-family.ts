export type MarketFamily =
  | "sports_moneyline"
  | "sports_spread"
  | "sports_total"
  | "sports_team_total"
  | "sports_player_prop"
  | "sports_threshold"
  | "sports_score_band"
  | "sports_period"
  | "sports_other"
  | "crypto_threshold"
  | "weather_threshold"
  | "other_threshold"
  | "binary_other"
  | "multi_outcome";

export interface MarketFamilyInput {
  domain: string;
  question?: string | null;
  slug?: string | null;
  outcomeCount: number;
  sportsKind?: string | null;
  sportsScope?: string | null;
}

const THRESHOLD_RE =
  /\b(over|under|above|below|at least|at most|more than|less than|fewer than|exceed|exceeds|higher than|lower than)\b|\b\d+(?:\.\d+)?\s*\+/i;

export function classifyMarketFamily(input: MarketFamilyInput): MarketFamily {
  const domain=String(input.domain||"other").toLowerCase();
  const outcomeCount=Math.max(0,Number(input.outcomeCount||0));
  if (outcomeCount > 2) return "multi_outcome";

  const question=[input.question,input.slug].filter(Boolean).join(" ");
  const kind=String(input.sportsKind||"").toLowerCase();
  const scope=String(input.sportsScope||"").toLowerCase();

  if (domain==="sports") {
    if (kind==="moneyline" || kind==="series" || kind==="futures") return "sports_moneyline";
    if (kind==="spread") return "sports_spread";
    if (kind==="game_total" || kind==="period_total") return scope && !["full_game","match"].includes(scope) ? "sports_period" : "sports_total";
    if (kind==="team_total") return "sports_team_total";
    if (kind==="player_prop") return "sports_player_prop";
    if (kind==="threshold") return "sports_threshold";
    if (kind==="score_band" || kind==="exact_score") return "sports_score_band";
    if (kind.startsWith("period_")) return "sports_period";

    if (/\bspread\b|handicap|[+-]\d+(?:\.\d+)?\b/.test(question)) return "sports_spread";
    if (/\bteam total\b/i.test(question)) return "sports_team_total";
    if (/\b(player prop|rebounds?|assists?|passing yards?|rushing yards?|receiving yards?|strikeouts?|home runs?|shots?|saves?|kills?|aces?)\b/i.test(question) && THRESHOLD_RE.test(question)) return "sports_player_prop";
    if (/\b(over|under)\b/i.test(question) && /\b(total|points?|goals?|runs?|rounds?|games?|sets?)\b/i.test(question)) return "sports_total";
    if (/\bexact score|correct score|score band|\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+(?:\.\d+)?\b/i.test(question)) return "sports_score_band";
    if (THRESHOLD_RE.test(question)) return "sports_threshold";
    if (/\bwin(?:ner)?\b|\bmoneyline\b|\bvs\.?\b|\bversus\b/i.test(question)) return "sports_moneyline";
    return "sports_other";
  }

  if (THRESHOLD_RE.test(question)) {
    if (domain==="crypto") return "crypto_threshold";
    if (domain==="weather") return "weather_threshold";
    return "other_threshold";
  }

  return "binary_other";
}

export function marketFamilyFromCandidate(candidate: {
  primaryCategory?: string | null;
  question?: string | null;
  slug?: string | null;
  outcomes?: unknown[];
  sportsStructure?: { kind?: string | null; scope?: string | null } | null;
}, domain?: string): MarketFamily {
  return classifyMarketFamily({
    domain:domain || candidate.primaryCategory || "other",
    question:candidate.question,
    slug:candidate.slug,
    outcomeCount:Array.isArray(candidate.outcomes) ? candidate.outcomes.length : 0,
    sportsKind:candidate.sportsStructure?.kind,
    sportsScope:candidate.sportsStructure?.scope
  });
}
