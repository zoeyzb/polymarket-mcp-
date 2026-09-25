import type { GammaMarket } from "./types.js";

export type MarketCategory =
  | "politics"
  | "elections"
  | "sports"
  | "basketball"
  | "nba"
  | "soccer"
  | "games_esports"
  | "crypto"
  | "finance"
  | "earnings"
  | "economy"
  | "fed_rates"
  | "geopolitics"
  | "world"
  | "tech"
  | "science_climate"
  | "weather"
  | "culture"
  | "movies"
  | "business"
  | "mentions"
  | "five_minute"
  | "weekly"
  | "recurring"
  | "new_listing"
  | "trending"
  | "ending_soon"
  | "other";

function text(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function classifyMarketCategories(
  market: GammaMarket,
  nowMs = Date.now()
): MarketCategory[] {
  const event = Array.isArray(market.events) && market.events.length
    ? market.events[0] as Record<string, unknown>
    : {};

  const tags = Array.isArray((market as any).tags)
    ? (market as any).tags.map((tag: unknown) =>
        typeof tag === "string"
          ? tag
          : typeof tag === "object" && tag
            ? text((tag as any).label ?? (tag as any).name ?? (tag as any).slug)
            : ""
      )
    : [];

  const haystack = [
    market.question,
    market.slug,
    market.description,
    market.category,
    market.sportsMarketType,
    event.title,
    event.slug,
    event.category,
    event.description,
    event.seriesSlug,
    ...tags
  ].map(text).join(" ");

  const out = new Set<MarketCategory>();

  if (/\b(election|electoral|ballot|vote share|popular vote|electoral college|primary|runoff)\b/.test(haystack)) out.add("elections");
  if (/\b(president|presidential|prime minister|parliament|congress|senate|governor|mayor|cabinet|legislation|political party|approval rating)\b/.test(haystack)) out.add("politics");

  if (/\b(nba|national basketball association)\b/.test(haystack)) out.add("nba");
  if (/\b(basketball|wnba|ncaa basketball)\b/.test(haystack)) out.add("basketball");
  if (/\b(soccer|football club|premier league|champions league|world cup|la liga|serie a|bundesliga|mls)\b/.test(haystack)) out.add("soccer");
  if (/\b(esports|counter[- ]?strike|cs2|valorant|league of legends|dota|video game|gaming)\b/.test(haystack)) out.add("games_esports");
  if (/\b(nfl|mlb|nhl|ufc|mma|tennis|cricket|rugby|golf|olympics|sports|moneyline|spread|total points|total rounds)\b/.test(haystack) || market.gameId !== undefined || Boolean(market.sportsMarketType)) out.add("sports");

  if (/\b(bitcoin|btc|ethereum|ether|eth|solana|\bsol\b|xrp|dogecoin|doge|crypto|token|etf approval|halving)\b/.test(haystack)) out.add("crypto");
  if (/\b(earnings|eps|revenue beat|guidance|quarterly results)\b/.test(haystack)) out.add("earnings");
  if (/\b(fomc|fed funds|federal reserve|rate cut|rate hike|fed rate|interest rate decision)\b/.test(haystack)) out.add("fed_rates");
  if (/\b(gdp|cpi|inflation|unemployment|jobs report|nonfarm payroll|recession|economic growth|economy)\b/.test(haystack)) out.add("economy");
  if (/\b(treasury|yield|ipo|merger|acquisition|m&a|bank|stock|s&p 500|nasdaq|dow|finance)\b/.test(haystack)) out.add("finance");

  if (/\b(war|ceasefire|sanctions|missile|military|invasion|hostage|territorial|summit|geopolitic|iran|ukraine|russia|israel|gaza)\b/.test(haystack)) out.add("geopolitics");
  if (/\b(international|world|country|global)\b/.test(haystack)) out.add("world");

  if (/\b(ai|artificial intelligence|spacex|chip|semiconductor|software|product launch|antitrust|openai|apple|google|microsoft|tesla|technology|tech)\b/.test(haystack)) out.add("tech");
  if (/\b(science|scientific|fda|vaccine|drug approval|clinical trial|nasa|space mission|benchmark|climate|el niño|la niña|hurricane|storm count)\b/.test(haystack)) out.add("science_climate");
  if (/\b(weather|temperature|degrees|rainfall|precipitation|snowfall|snow|wind speed|heat index|hottest|coldest|hurricane landfall)\b/.test(haystack)) out.add("weather");

  if (/\b(oscar|academy awards|emmy|grammy|eurovision|billboard|music chart|celebrity|culture|award show)\b/.test(haystack)) out.add("culture");
  if (/\b(box office|movie|film|sequel|opening weekend|release date)\b/.test(haystack)) out.add("movies");
  if (/\b(bankruptcy|layoff|ceo|executive turnover|deliveries|business)\b/.test(haystack)) out.add("business");
  if (/\b(mention|mentions|say the word|times will .* say|tweet|post .* times)\b/.test(haystack)) out.add("mentions");

  const eventStart = Date.parse(String((market as any).eventStartTime ?? event.startTime ?? ""));
  const exactEnd = Date.parse(String(market.endDate ?? ""));
  const windowMinutes =
    Number.isFinite(eventStart) && Number.isFinite(exactEnd) && exactEnd > eventStart
      ? (exactEnd - eventStart) / 60000
      : null;
  if (
    (windowMinutes !== null && windowMinutes >= 4 && windowMinutes <= 6) ||
    /\b5m\b|5-minute|5 minute/i.test(haystack)
  ) out.add("five_minute");

  if (/\bweekly|this week|next week|week ending\b/.test(haystack)) out.add("weekly");
  if (/\brecurring|monthly|every month|each month|every week|daily recurring\b/.test(haystack)) out.add("recurring");

  const createdAt = Date.parse(String((market as any).createdAt ?? ""));
  if (Number.isFinite(createdAt) && nowMs - createdAt <= 48 * 3600_000) out.add("new_listing");
  const volume24h = Number((market as any).volume24hr ?? (market as any).volume24h ?? 0);
  const volume = Number((market as any).volumeNum ?? (market as any).volume ?? 0);
  if (Number.isFinite(volume24h) && Number.isFinite(volume) && volume24h >= 50_000 && volume24h >= Math.max(1, volume * 0.15)) out.add("trending");

  const end = Date.parse(String(market.endDateIso ?? market.endDate ?? ""));
  if (Number.isFinite(end) && end >= nowMs && end - nowMs <= 72 * 3600_000) out.add("ending_soon");

  if (!out.size) out.add("other");
  return [...out];
}

export function primaryMarketCategory(categories: MarketCategory[]): MarketCategory {
  const priority: MarketCategory[] = [
    "nba","basketball","soccer","games_esports","sports","elections","politics",
    "crypto","earnings","fed_rates","economy","finance","geopolitics","weather",
    "science_climate","tech","movies","culture","business","mentions","five_minute","weekly",
    "recurring","new_listing","trending","ending_soon","world","other"
  ];
  return priority.find(category => categories.includes(category)) ?? "other";
}
