import type { GammaMarket } from "./types.js";

export type SportsMarketKind =
  | "moneyline"
  | "spread"
  | "game_total"
  | "team_total"
  | "player_prop"
  | "period_moneyline"
  | "period_spread"
  | "period_total"
  | "exact_score"
  | "score_band"
  | "threshold"
  | "both_teams_score"
  | "first_scorer"
  | "series"
  | "futures"
  | "other_sports";

export type SportsMarketScope =
  | "full_game"
  | "first_half"
  | "second_half"
  | "quarter"
  | "period"
  | "inning"
  | "set"
  | "map"
  | "match"
  | "series"
  | "season"
  | "unknown";

export interface SportsMarketStructure {
  kind: SportsMarketKind;
  scope: SportsMarketScope;
  sport: string | null;
  rawSportsMarketType: string | null;
  eventTitle: string | null;
  subject: string | null;
  stat: string | null;
  line: number | null;
  thresholdComparator: "over" | "under" | "above" | "below" | "at_least" | "at_most" | null;
  rangeMin: number | null;
  rangeMax: number | null;
  exactValue: number | null;
  liveState: {
    gameId: string | number | null;
    score: string | null;
    period: string | null;
    elapsed: string | null;
    live: boolean | null;
    ended: boolean | null;
    startTime: string | null;
  } | null;
  flags: string[];
}

function s(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function n(value: unknown): number | null {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function firstEvent(market: GammaMarket): Record<string, unknown> {
  return Array.isArray(market.events) && market.events.length
    ? market.events[0] as Record<string, unknown>
    : {};
}

function detectSport(text: string) {
  const rules: Array<[RegExp, string]> = [
    [/\bnfl|football\b/i, "NFL"],
    [/\bnba\b/i, "NBA"],
    [/\bwnba\b/i, "WNBA"],
    [/\bncaa(?: basketball)?\b/i, "NCAA"],
    [/\bmlb|baseball\b/i, "MLB"],
    [/\bnhl|hockey\b/i, "NHL"],
    [/\bsoccer|premier league|champions league|la liga|serie a|bundesliga|mls|world cup\b/i, "SOCCER"],
    [/\btennis|atp|wta\b/i, "TENNIS"],
    [/\bufc|mma\b/i, "MMA"],
    [/\bcricket\b/i, "CRICKET"],
    [/\brugby\b/i, "RUGBY"],
    [/\bgolf|pga\b/i, "GOLF"],
    [/\bcs2|counter[- ]?strike|valorant|league of legends|dota|esports\b/i, "ESPORTS"]
  ];
  return rules.find(([re]) => re.test(text))?.[1] ?? null;
}

function detectScope(text: string, rawType: string): SportsMarketScope {
  const haystack = `${text} ${rawType}`;
  if (/\b(first|1st) half\b/i.test(haystack)) return "first_half";
  if (/\b(second|2nd) half\b/i.test(haystack)) return "second_half";
  if (/\b(?:1st|2nd|3rd|4th|first|second|third|fourth) quarter\b|\bq[1-4]\b/i.test(haystack)) return "quarter";
  if (/\b(?:1st|2nd|3rd|first|second|third) period\b/i.test(haystack)) return "period";
  if (/\b(?:1st|2nd|3rd|4th|5th|6th|7th|8th|9th) inning\b/i.test(haystack)) return "inning";
  if (/\bset\b/i.test(haystack)) return "set";
  if (/\bmap\s*\d+|map winner\b/i.test(haystack)) return "map";
  if (/\bseries\b/i.test(haystack)) return "series";
  if (/\bseason|championship|conference winner|division winner|mvp|award\b/i.test(haystack)) return "season";
  if (/\bmatch\b/i.test(haystack)) return "match";
  return "full_game";
}

function detectComparator(text: string): SportsMarketStructure["thresholdComparator"] {
  if (/\bover\b/i.test(text)) return "over";
  if (/\bunder\b/i.test(text)) return "under";
  if (/\babove\b/i.test(text)) return "above";
  if (/\bbelow\b/i.test(text)) return "below";
  if (/\bat least\b|\b\d+\+\b/i.test(text)) return "at_least";
  if (/\bat most\b/i.test(text)) return "at_most";
  return null;
}

function extractRange(text: string) {
  const range = text.match(/\b(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\b/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = text.match(/\b(\d+(?:\.\d+)?)\s*\+/);
  if (plus) return { min: Number(plus[1]), max: null };
  return { min: null, max: null };
}

function extractLine(market: GammaMarket, text: string): number | null {
  const direct = n((market as any).line);
  if (direct !== null) return direct;

  const group = s((market as any).groupItemTitle);
  const fromGroup = group.match(/(?:spread|total|over\/under|o\/u)?\s*([+-]?\d+(?:\.\d+)?)/i);
  if (fromGroup) return Number(fromGroup[1]);

  const patterns = [
    /\(([+-]?\d+(?:\.\d+)?)\)/,
    /\b(?:over|under|total|spread|line)\s*[: ]\s*([+-]?\d+(?:\.\d+)?)/i,
    /\b([+-]?\d+(?:\.\d+)?)\s*(?:points?|goals?|runs?|rebounds?|assists?|yards?|kills?)\b/i
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return Number(match[1]);
  }
  return null;
}

function detectStat(text: string) {
  const stats = [
    "points","goals","runs","hits","rebounds","assists","yards","touchdowns",
    "passing yards","rushing yards","receiving yards","strikeouts","home runs",
    "shots","saves","kills","aces","double faults","maps","rounds"
  ];
  return stats.find(stat => text.toLowerCase().includes(stat)) ?? null;
}

function detectSubject(market: GammaMarket, text: string) {
  const group = s((market as any).groupItemTitle);
  if (group && !/^spread|^total|^over\/under/i.test(group)) return group;

  const player = text.match(/^(.+?)\s+(?:over|under|at least|above|below)\s+\d/i);
  if (player) return player[1].trim();

  const spread = text.match(/^Spread:\s*(.+?)\s*\(/i);
  if (spread) return spread[1].trim();

  return null;
}

export function classifySportsMarketStructure(
  market: GammaMarket
): SportsMarketStructure | null {
  const event = firstEvent(market);
  const question = s(market.question);
  const rawType = s((market as any).sportsMarketType).toLowerCase();
  const eventTitle = s(event.title) || null;
  const text = [
    question,
    s(market.slug),
    s(market.description),
    s((market as any).groupItemTitle),
    rawType,
    eventTitle,
    s(event.seriesSlug)
  ].filter(Boolean).join(" ");

  const sportsSignal =
    Boolean((market as any).gameId) ||
    Boolean((event as any).gameId) ||
    Boolean(rawType) ||
    /\b(nfl|nba|wnba|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|ufc|mma|cricket|rugby|golf|esports|moneyline|spread|total points|total goals|total runs)\b/i.test(text);

  if (!sportsSignal) return null;

  const scope = detectScope(text, rawType);
  const numericText = [question, s((market as any).groupItemTitle)].filter(Boolean).join(" ");
  const comparator = detectComparator(numericText);
  const range = extractRange(numericText);
  const line = extractLine(market, numericText);
  const stat = detectStat(text);

  let kind: SportsMarketKind = "other_sports";

  if (/exact score|correct score|final score/i.test(text)) {
    kind = "exact_score";
  } else if (/both teams.*score|btts/i.test(text)) {
    kind = "both_teams_score";
  } else if (/first (?:goal|touchdown|basket|score|scorer)|to score first/i.test(text)) {
    kind = "first_scorer";
  } else if (/player prop|player.*(?:points|goals|rebounds|assists|yards|kills|shots|saves)|(?:points|goals|rebounds|assists|yards|kills|shots|saves).*player/i.test(text)) {
    kind = "player_prop";
  } else if (/team total/i.test(text)) {
    kind = "team_total";
  } else if (
    rawType === "spreads" ||
    rawType === "spread"
  ) {
    kind = scope === "full_game" || scope === "match" ? "spread" : "period_spread";
  } else if (
    rawType === "totals" ||
    rawType === "total"
  ) {
    kind = scope === "full_game" || scope === "match" ? "game_total" : "period_total";
  } else if (
    rawType === "moneyline" ||
    rawType === "money_line"
  ) {
    kind = scope === "full_game" || scope === "match" ? "moneyline" : "period_moneyline";
  } else if (
    range.min !== null &&
    (range.max !== null || /\d+\+/.test(numericText)) &&
    /points?|goals?|runs?|score|total|kills?|rounds?/i.test(numericText)
  ) {
    kind = "score_band";
  } else if (
    /\bspread\b|handicap/i.test(text)
  ) {
    kind = scope === "full_game" || scope === "match" ? "spread" : "period_spread";
  } else if (
    /\bover\/under\b|\btotal (?:points|goals|runs|rounds|games|sets)\b|\bover \d|\bunder \d/i.test(text)
  ) {
    kind = scope === "full_game" || scope === "match" ? "game_total" : "period_total";
  } else if (
    /\bmoneyline\b|\bmatch winner\b|\bgame winner\b/i.test(text)
  ) {
    kind = scope === "full_game" || scope === "match" ? "moneyline" : "period_moneyline";
  } else if (/series winner|win the series|best of/i.test(text)) {
    kind = "series";
  } else if (/championship|conference winner|division winner|season wins|mvp|award|win the league|win the tournament/i.test(text)) {
    kind = "futures";
  } else if (
    comparator !== null &&
    line !== null &&
    /points?|goals?|runs?|hits?|yards?|kills?|rounds?|sets?|games?/i.test(text)
  ) {
    kind = "threshold";
  } else if (
    /vs\.?\b|versus/i.test(eventTitle || question) &&
    Array.isArray((market as any).events)
  ) {
    kind = scope === "full_game" || scope === "match" ? "moneyline" : "period_moneyline";
  }

  const exactMatch = text.match(/(?:exactly|score of)\s*(\d+(?:\.\d+)?)/i);
  const exactValue = exactMatch ? Number(exactMatch[1]) : null;

  const flags: string[] = [];
  if (rawType) flags.push(`official_sports_type:${rawType}`);
  if (line !== null) flags.push("line_parsed");
  if (range.min !== null) flags.push("range_parsed");
  if ((event as any).live === true) flags.push("live_game");
  if ((event as any).ended === true) flags.push("game_ended");
  if (scope !== "full_game" && scope !== "match") flags.push("segment_market");

  const hasLiveState =
    (event as any).gameId !== undefined ||
    event.score !== undefined ||
    event.period !== undefined ||
    event.elapsed !== undefined ||
    event.live !== undefined ||
    event.ended !== undefined;

  return {
    kind,
    scope,
    sport: detectSport(text),
    rawSportsMarketType: rawType || null,
    eventTitle,
    subject: detectSubject(market, question),
    stat,
    line,
    thresholdComparator: comparator,
    rangeMin: range.min,
    rangeMax: range.max,
    exactValue,
    liveState: hasLiveState
      ? {
          gameId: ((event as any).gameId ?? (market as any).gameId ?? null) as string | number | null,
          score: s(event.score) || null,
          period: s(event.period) || null,
          elapsed: s(event.elapsed) || null,
          live: typeof event.live === "boolean" ? event.live : null,
          ended: typeof event.ended === "boolean" ? event.ended : null,
          startTime: s(event.startTime ?? (market as any).gameStartTime) || null
        }
      : null,
    flags
  };
}
