import type { ScanCandidate } from "./types.js";

export interface SportsLineViolation {
  type: "spread_monotonicity" | "total_monotonicity";
  eventTitle: string;
  subject: string | null;
  scope: string;
  side: string;
  easierConditionId: string | null;
  harderConditionId: string | null;
  easierQuestion: string;
  harderQuestion: string;
  easierLine: number;
  harderLine: number;
  easierProbability: number;
  harderProbability: number;
  violationProbabilityPoints: number;
  flags: string[];
}

function midpointForOutcome(candidate: ScanCandidate, outcomeName: string) {
  const needle = outcomeName.trim().toLowerCase();
  const index = candidate.outcomes.findIndex(outcome =>
    outcome.trim().toLowerCase() === needle
  );
  if (index < 0) return null;
  const mid = candidate.books?.[index]?.midpoint;
  if (mid !== null && mid !== undefined && Number.isFinite(mid)) return Number(mid);
  const displayed = candidate.displayedOutcomePrices[index];
  return Number.isFinite(displayed) ? displayed : null;
}

function spreadProbability(candidate: ScanCandidate) {
  const subject = candidate.sportsStructure?.subject;
  if (!subject) return null;
  return midpointForOutcome(candidate, subject);
}

function totalProbability(candidate: ScanCandidate, side: "over" | "under") {
  const names = side === "over"
    ? ["over", "yes"]
    : ["under", "no"];
  for (const name of names) {
    const p = midpointForOutcome(candidate, name);
    if (p !== null) return p;
  }
  return null;
}

function sameEvent(a: ScanCandidate, b: ScanCandidate) {
  const sa = a.sportsStructure;
  const sb = b.sportsStructure;
  return Boolean(
    sa &&
    sb &&
    sa.eventTitle &&
    sb.eventTitle &&
    sa.eventTitle === sb.eventTitle &&
    sa.scope === sb.scope &&
    sa.sport === sb.sport
  );
}

export function findSportsLineViolations(
  candidates: ScanCandidate[],
  epsilon = 0.01
): SportsLineViolation[] {
  const sports = candidates.filter(candidate =>
    candidate.sportsStructure &&
    candidate.sportsStructure.line !== null
  );
  const out: SportsLineViolation[] = [];

  for (let i = 0; i < sports.length; i++) {
    for (let j = i + 1; j < sports.length; j++) {
      const a = sports[i];
      const b = sports[j];
      const sa = a.sportsStructure!;
      const sb = b.sportsStructure!;
      if (!sameEvent(a, b)) continue;

      if (
        (sa.kind === "spread" || sa.kind === "period_spread") &&
        sa.kind === sb.kind &&
        sa.subject &&
        sb.subject &&
        sa.subject.toLowerCase() === sb.subject.toLowerCase()
      ) {
        const pa = spreadProbability(a);
        const pb = spreadProbability(b);
        if (pa === null || pb === null || sa.line === sb.line) continue;

        const easier = sa.line! > sb.line! ? a : b;
        const harder = sa.line! > sb.line! ? b : a;
        const pe = easier === a ? pa : pb;
        const ph = harder === a ? pa : pb;

        if (ph - pe > epsilon) {
          out.push({
            type: "spread_monotonicity",
            eventTitle: sa.eventTitle!,
            subject: sa.subject,
            scope: sa.scope,
            side: sa.subject,
            easierConditionId: easier.conditionId,
            harderConditionId: harder.conditionId,
            easierQuestion: easier.question,
            harderQuestion: harder.question,
            easierLine: easier.sportsStructure!.line!,
            harderLine: harder.sportsStructure!.line!,
            easierProbability: Number(pe.toFixed(6)),
            harderProbability: Number(ph.toFixed(6)),
            violationProbabilityPoints: Number(((ph - pe) * 100).toFixed(3)),
            flags: ["sports_line_monotonicity_violation"]
          });
        }
      }

      const totalKinds = new Set(["game_total", "team_total", "period_total"]);
      if (
        totalKinds.has(sa.kind) &&
        sa.kind === sb.kind &&
        (sa.subject || "") === (sb.subject || "") &&
        sa.line !== sb.line
      ) {
        for (const side of ["over", "under"] as const) {
          const pa = totalProbability(a, side);
          const pb = totalProbability(b, side);
          if (pa === null || pb === null) continue;

          let easier: ScanCandidate;
          let harder: ScanCandidate;
          let pe: number;
          let ph: number;

          if (side === "over") {
            easier = sa.line! < sb.line! ? a : b;
            harder = sa.line! < sb.line! ? b : a;
          } else {
            easier = sa.line! > sb.line! ? a : b;
            harder = sa.line! > sb.line! ? b : a;
          }
          pe = easier === a ? pa : pb;
          ph = harder === a ? pa : pb;

          if (ph - pe > epsilon) {
            out.push({
              type: "total_monotonicity",
              eventTitle: sa.eventTitle!,
              subject: sa.subject,
              scope: sa.scope,
              side,
              easierConditionId: easier.conditionId,
              harderConditionId: harder.conditionId,
              easierQuestion: easier.question,
              harderQuestion: harder.question,
              easierLine: easier.sportsStructure!.line!,
              harderLine: harder.sportsStructure!.line!,
              easierProbability: Number(pe.toFixed(6)),
              harderProbability: Number(ph.toFixed(6)),
              violationProbabilityPoints: Number(((ph - pe) * 100).toFixed(3)),
              flags: ["sports_line_monotonicity_violation"]
            });
          }
        }
      }
    }
  }

  return out.sort((a, b) =>
    b.violationProbabilityPoints - a.violationProbabilityPoints
  );
}
