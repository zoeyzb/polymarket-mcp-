import type { ScanCandidate } from "./types.js";
import { isPoliticalCandidate } from "./domain-policy.js";

export interface StructuralGraphViolation {
  type: "threshold_monotonicity" | "deadline_monotonicity";
  subject: string;
  direction: "above" | "below";
  threshold: number;
  easierConditionId: string | null;
  harderConditionId: string | null;
  easierQuestion: string;
  harderQuestion: string;
  easierProbability: number;
  harderProbability: number;
  violationProbabilityPoints: number;
  earlierEndDate?: string;
  laterEndDate?: string;
  resolutionRiskMax: number;
  classification: "logical_relative_value_candidate";
  flags: string[];
}

type Parsed = {
  candidate: ScanCandidate;
  subject: string;
  direction: "above" | "below";
  threshold: number;
  probability: number;
  barrierByDeadline: boolean;
};

const SUBJECTS: Array<{ re: RegExp; key: string }> = [
  { re: /\b(bitcoin|btc)\b/i, key: "BTC" },
  { re: /\b(ethereum|ether|eth)\b/i, key: "ETH" },
  { re: /\b(solana|sol)\b/i, key: "SOL" },
  { re: /\b(xrp|ripple)\b/i, key: "XRP" },
  { re: /\b(dogecoin|doge)\b/i, key: "DOGE" },
  { re: /\b(s&p\s*500|s&p|spx)\b/i, key: "SPX" },
  { re: /\b(nasdaq(?:\s*100)?|ndx)\b/i, key: "NDX" },
  { re: /\b(dow(?: jones)?|djia)\b/i, key: "DJIA" }
];

function n(value: unknown): number | null {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function parseMoneyThreshold(question: string): number | null {
  const matches = [
    ...question.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)([kmb])?/gi),
    ...question.matchAll(/\b([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)([kmb])?\b/gi)
  ];
  if (!matches.length) return null;
  const raw = String(matches[0][1]).replace(/,/g, "");
  let value = Number(raw);
  const suffix = String(matches[0][2] || "").toLowerCase();
  if (suffix === "k") value *= 1_000;
  if (suffix === "m") value *= 1_000_000;
  if (suffix === "b") value *= 1_000_000_000;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function yesProbability(candidate: ScanCandidate): number | null {
  const yesIndex = candidate.outcomes.findIndex(outcome => outcome.toLowerCase() === "yes");
  if (yesIndex < 0) return null;
  const mid = candidate.books?.[yesIndex]?.midpoint;
  if (mid !== null && mid !== undefined && Number.isFinite(mid)) return Number(mid);
  const displayed = n(candidate.displayedOutcomePrices[yesIndex]);
  return displayed !== null && displayed >= 0 && displayed <= 1 ? displayed : null;
}

function parseCandidate(candidate: ScanCandidate): Parsed | null {
  if (isPoliticalCandidate(candidate)) return null;
  const subject = SUBJECTS.find(item => item.re.test(candidate.question))?.key;
  if (!subject) return null;

  const direction: "above" | "below" | null =
    /\b(above|over|higher than|greater than|at least|reach|hit|touch|exceed)\b/i.test(candidate.question)
      ? "above"
      : /\b(below|under|lower than|less than|at most)\b/i.test(candidate.question)
        ? "below"
        : null;
  if (!direction) return null;

  const threshold = parseMoneyThreshold(candidate.question);
  const probability = yesProbability(candidate);
  if (threshold === null || probability === null) return null;

  const barrierByDeadline =
    /\b(by|before|any time before|reach|hit|touch)\b/i.test(candidate.question) &&
    !/\b(close|closing|settle|settles|at \d{1,2}:\d{2}|at the end)\b/i.test(candidate.question);

  return { candidate, subject, direction, threshold, probability, barrierByDeadline };
}

function risk(candidate: ScanCandidate) {
  return candidate.resolutionIntelligence?.resolutionRiskScore ?? 50;
}

function sameExpiry(a: ScanCandidate, b: ScanCandidate) {
  const x = Date.parse(a.endDate);
  const y = Date.parse(b.endDate);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 2 * 3600_000;
}

function violation(
  type: StructuralGraphViolation["type"],
  easier: Parsed,
  harder: Parsed,
  magnitude: number,
  earlierEndDate?: string,
  laterEndDate?: string
): StructuralGraphViolation {
  return {
    type,
    subject: easier.subject,
    direction: easier.direction,
    threshold: harder.threshold,
    easierConditionId: easier.candidate.conditionId,
    harderConditionId: harder.candidate.conditionId,
    easierQuestion: easier.candidate.question,
    harderQuestion: harder.candidate.question,
    easierProbability: Number(easier.probability.toFixed(6)),
    harderProbability: Number(harder.probability.toFixed(6)),
    violationProbabilityPoints: Number((magnitude * 100).toFixed(3)),
    earlierEndDate,
    laterEndDate,
    resolutionRiskMax: Math.max(risk(easier.candidate), risk(harder.candidate)),
    classification: "logical_relative_value_candidate",
    flags: [
      "logical_monotonicity_violation",
      ...(Math.max(risk(easier.candidate), risk(harder.candidate)) >= 60
        ? ["resolution_rules_need_manual_verification"]
        : [])
    ]
  };
}

export function findStructuralGraphViolations(candidates: ScanCandidate[]) {
  const parsed = candidates.map(parseCandidate).filter((x): x is Parsed => x !== null);
  const out: StructuralGraphViolation[] = [];
  const epsilon = Math.max(0.001, Number(process.env.LOGICAL_GRAPH_EPSILON || 0.01));

  // Same expiry, different thresholds.
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      if (
        a.subject !== b.subject ||
        a.direction !== b.direction ||
        a.threshold === b.threshold ||
        !sameExpiry(a.candidate, b.candidate)
      ) continue;

      const low = a.threshold < b.threshold ? a : b;
      const high = a.threshold < b.threshold ? b : a;

      if (a.direction === "above") {
        // P(S > lower) must be >= P(S > higher).
        if (high.probability - low.probability > epsilon) {
          out.push(violation(
            "threshold_monotonicity",
            low,
            high,
            high.probability - low.probability
          ));
        }
      } else {
        // P(S < lower) must be <= P(S < higher).
        if (low.probability - high.probability > epsilon) {
          out.push(violation(
            "threshold_monotonicity",
            high,
            low,
            low.probability - high.probability
          ));
        }
      }
    }
  }

  // Barrier events: the probability of hitting a threshold "by" a later date
  // cannot be lower than the same event by an earlier date.
  const barrier = parsed.filter(item => item.barrierByDeadline);
  for (let i = 0; i < barrier.length; i++) {
    for (let j = i + 1; j < barrier.length; j++) {
      const a = barrier[i];
      const b = barrier[j];
      if (
        a.subject !== b.subject ||
        a.direction !== b.direction ||
        a.threshold !== b.threshold
      ) continue;

      const aTs = Date.parse(a.candidate.endDate);
      const bTs = Date.parse(b.candidate.endDate);
      if (!Number.isFinite(aTs) || !Number.isFinite(bTs) || aTs === bTs) continue;
      const earlier = aTs < bTs ? a : b;
      const later = aTs < bTs ? b : a;

      if (earlier.probability - later.probability > epsilon) {
        out.push(violation(
          "deadline_monotonicity",
          earlier,
          later,
          earlier.probability - later.probability,
          earlier.candidate.endDate,
          later.candidate.endDate
        ));
      }
    }
  }

  return out.sort((a, b) =>
    b.violationProbabilityPoints - a.violationProbabilityPoints ||
    a.resolutionRiskMax - b.resolutionRiskMax
  );
}
