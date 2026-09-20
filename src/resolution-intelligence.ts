import type { ScanCandidate } from "./types.js";

export interface ResolutionIntelligence {
  sourceMentions: string[];
  deadlineMentions: string[];
  thresholdMentions: string[];
  comparator: ">" | ">=" | "<" | "<=" | "between" | "exact" | "unknown";
  fallbackLanguage: boolean;
  discretionLanguage: boolean;
  revisedDataLanguage: boolean;
  unofficialSourceLanguage: boolean;
  titleRuleTokenOverlap: number | null;
  ambiguityScore: number;
  resolutionRiskScore: number;
  flags: string[];
}

const SOURCE_PATTERNS = [
  /(?:according to|as reported by|source(?:d)? from|using|per)\s+([A-Z][A-Za-z0-9 .&'/-]{2,80})/g,
  /\b(Coinbase|Kraken|CoinGecko|CoinMarketCap|Bloomberg|Reuters|AP|Associated Press|NOAA|NWS|BLS|BEA|Federal Reserve|CME|FIFA|NBA|NFL|MLB|NHL|Google Trends|Wikipedia)\b/gi
];

const STOPWORDS = new Set([
  "will","the","a","an","be","is","are","was","were","to","of","in","on","at","by",
  "for","and","or","with","from","this","that","market","resolves","resolve","resolution",
  "according","source","sources","official"
]);

function tokens(text: string) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(token => token.length >= 3 && !STOPWORDS.has(token))
  )];
}

function jaccard(a: string[], b: string[]) {
  const sa = new Set(a);
  const sb = new Set(b);
  const union = new Set([...sa, ...sb]);
  if (!union.size) return 0;
  let hit = 0;
  for (const token of sa) if (sb.has(token)) hit += 1;
  return hit / union.size;
}

function uniq(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export function analyzeResolutionRules(candidate: ScanCandidate): ResolutionIntelligence {
  const title = candidate.question || "";
  const rules = [candidate.resolutionRules, candidate.resolutionSource]
    .filter(Boolean)
    .join(" ")
    .trim();

  const sourceMentions: string[] = [];
  for (const pattern of SOURCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of rules.matchAll(pattern)) {
      sourceMentions.push(String(match[1] ?? match[0]));
    }
  }

  const deadlineMentions = uniq([
    ...[...rules.matchAll(/\b(?:by|before|after|through|until|on)\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}\s*(?:AM|PM|UTC|ET|EST|EDT)?)/gi)]
      .map(match => match[0]),
    ...[...rules.matchAll(/\b(?:deadline|close(?:s|d)?|end(?:s|ed)?|expire(?:s|d)?)\b[^.;]{0,70}/gi)]
      .map(match => match[0])
  ]).slice(0, 12);

  const thresholdMentions = uniq([
    ...[...rules.matchAll(/(?:>=|<=|>|<|at least|more than|less than|above|below|between)\s*\$?\d[\d,.]*(?:\.\d+)?%?/gi)]
      .map(match => match[0]),
    ...[...title.matchAll(/(?:>=|<=|>|<|at least|more than|less than|above|below|between)\s*\$?\d[\d,.]*(?:\.\d+)?%?/gi)]
      .map(match => match[0])
  ]).slice(0, 12);

  const allText = `${title} ${rules}`;
  let comparator: ResolutionIntelligence["comparator"] = "unknown";
  if (/\bbetween\b/i.test(allText)) comparator = "between";
  else if (/>=|at least|or more|greater than or equal/i.test(allText)) comparator = ">=";
  else if (/<=|at most|or less|less than or equal/i.test(allText)) comparator = "<=";
  else if (/>|above|more than|greater than/i.test(allText)) comparator = ">";
  else if (/<|below|less than/i.test(allText)) comparator = "<";
  else if (/exactly|equal to|equals\b/i.test(allText)) comparator = "exact";

  const fallbackLanguage = /fallback|if unavailable|if .* unavailable|alternative source|another credible source|secondary source/i.test(rules);
  const discretionLanguage = /discretion|consensus of credible reporting|credible sources|may determine|subjective|spirit of the market|reasonable interpretation/i.test(rules);
  const revisedDataLanguage = /revision|revised|initial release|first published|final release|subsequent revisions/i.test(rules);
  const unofficialSourceLanguage = /unofficial|social media|announcement|report(?:ed|ing)? by|credible reporting/i.test(rules);

  const overlap = rules ? jaccard(tokens(title), tokens(rules)) : null;

  let ambiguity = 15;
  if (!rules) ambiguity += 45;
  if (!sourceMentions.length) ambiguity += 15;
  if (fallbackLanguage) ambiguity += 10;
  if (discretionLanguage) ambiguity += 25;
  if (unofficialSourceLanguage) ambiguity += 8;
  if (thresholdMentions.length > 0 && comparator === "unknown") ambiguity += 10;
  if (overlap !== null && overlap < 0.18) ambiguity += 20;
  ambiguity = Math.max(0, Math.min(100, ambiguity));

  let risk = ambiguity * 0.65;
  if (revisedDataLanguage) risk += 8;
  if (fallbackLanguage) risk += 6;
  if (candidate.resolutionSource === null) risk += 8;
  risk = Math.max(0, Math.min(100, risk));

  const flags: string[] = [];
  if (!rules) flags.push("missing_resolution_rules");
  if (!sourceMentions.length) flags.push("resolution_source_not_explicit");
  if (fallbackLanguage) flags.push("fallback_source_language");
  if (discretionLanguage) flags.push("resolver_discretion_language");
  if (revisedDataLanguage) flags.push("revision_semantics_present");
  if (unofficialSourceLanguage) flags.push("unofficial_or_reporting_language");
  if (overlap !== null && overlap < 0.18) flags.push("title_rule_divergence");
  if (ambiguity >= 60) flags.push("high_resolution_ambiguity");

  return {
    sourceMentions: uniq(sourceMentions).slice(0, 12),
    deadlineMentions,
    thresholdMentions,
    comparator,
    fallbackLanguage,
    discretionLanguage,
    revisedDataLanguage,
    unofficialSourceLanguage,
    titleRuleTokenOverlap: overlap === null ? null : Number(overlap.toFixed(4)),
    ambiguityScore: Number(ambiguity.toFixed(1)),
    resolutionRiskScore: Number(risk.toFixed(1)),
    flags
  };
}
