import type { ScanResult } from "./types.js";
import { POLITICAL_DIRECTIONAL_FLAGS, isPoliticalCandidate } from "./domain-policy.js";

export interface AuditFinding {
  id: string;
  ok: boolean;
  severity: "info" | "warning" | "critical";
  detail: string;
}

export function auditScanResult(scan: ScanResult): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const push = (
    id: string,
    ok: boolean,
    severity: AuditFinding["severity"],
    detail: string
  ) => findings.push({ id, ok, severity, detail });

  push(
    "active_universe_nonempty",
    scan.totalActiveMarketsScanned > 0,
    "critical",
    `activeMarkets=${scan.totalActiveMarketsScanned}`
  );

  push(
    "returned_count_matches",
    scan.returned === scan.candidates.length,
    "critical",
    `returned=${scan.returned}, candidates=${scan.candidates.length}`
  );

  const timeViolations = scan.candidates.filter(
    candidate => candidate.minutesRemaining < 0 || candidate.minutesRemaining > scan.maxMinutes + 0.05
  );
  push(
    "closing_window_integrity",
    timeViolations.length === 0,
    "critical",
    `violations=${timeViolations.length}, maxMinutes=${scan.maxMinutes}`
  );

  const identityViolations = scan.candidates.filter(
    candidate => !candidate.question || !candidate.conditionId || candidate.tokenIds.length < 2
  );
  push(
    "candidate_identity_integrity",
    identityViolations.length === 0,
    "warning",
    `violations=${identityViolations.length}`
  );

  const executableViolations = scan.candidates.filter(candidate => {
    if (candidate.opportunityClass !== "executable_structural") return false;
    const arb = candidate.binaryArbitrage;
    if (!arb) return true;
    return !(arb.bestNetProfitUsd > 0 && (arb.bestNetRoiPct ?? 0) > 0);
  });
  push(
    "executable_edge_integrity",
    executableViolations.length === 0,
    "critical",
    `violations=${executableViolations.length}`
  );

  const scoreViolations = scan.candidates.filter(candidate =>
    candidate.opportunityScore < 0 ||
    candidate.opportunityScore > 100 ||
    (candidate.attentionScore !== undefined &&
      (candidate.attentionScore < 0 || candidate.attentionScore > 100)) ||
    (candidate.discoveryScore !== undefined &&
      (candidate.discoveryScore < 0 || candidate.discoveryScore > 100))
  );
  push(
    "score_bounds",
    scoreViolations.length === 0,
    "critical",
    `violations=${scoreViolations.length}`
  );

  const politicalViolations = scan.candidates.filter(candidate =>
    isPoliticalCandidate(candidate) && (
      candidate.flags.some(flag => POLITICAL_DIRECTIONAL_FLAGS.has(flag)) ||
      Math.abs((candidate.attentionScore ?? candidate.opportunityScore) - candidate.opportunityScore) > 0.01 ||
      Math.abs((candidate.discoveryScore ?? candidate.opportunityScore) - candidate.opportunityScore) > 0.01
    )
  );
  push(
    "political_structural_only_integrity",
    politicalViolations.length === 0,
    "critical",
    `violations=${politicalViolations.length}`
  );

  const unverifiedNegRiskBaskets = (scan.eventBaskets || []).filter(
    basket => !basket.flags.includes("gamma_event_child_set_verified")
  );
  push(
    "negrisk_child_set_verification",
    unverifiedNegRiskBaskets.length === 0,
    "critical",
    `violations=${unverifiedNegRiskBaskets.length}`
  );

  const augmentedFlags = (scan.eventBaskets || []).filter(basket =>
    basket.flags.some(flag => /augmented/i.test(flag))
  );
  push(
    "no_augmented_negrisk_baskets",
    augmentedFlags.length === 0,
    "critical",
    `violations=${augmentedFlags.length}`
  );

  return findings;
}

export function summarizeAudit(findings: AuditFinding[]) {
  const criticalFailures = findings.filter(f => !f.ok && f.severity === "critical");
  const warnings = findings.filter(f => !f.ok && f.severity === "warning");
  return {
    ok: criticalFailures.length === 0,
    status:
      criticalFailures.length > 0 ? "critical" :
      warnings.length > 0 ? "degraded" :
      "healthy",
    checks: findings.length,
    passed: findings.filter(f => f.ok).length,
    failed: findings.filter(f => !f.ok).length,
    criticalFailures: criticalFailures.length,
    warnings: warnings.length
  };
}
