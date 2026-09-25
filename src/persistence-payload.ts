import type { ScanCandidate, ScanResult } from "./types.js";

export function compactCandidatePersistencePayload(candidate: ScanCandidate) {
  return {
    tokenIds: candidate.tokenIds,
    outcomes: candidate.outcomes,
    primaryCategory: candidate.primaryCategory,
    categories: candidate.categories,
    discoveryScore: candidate.discoveryScore ?? candidate.opportunityScore,
    opportunityPacketScore: candidate.opportunityPacketScore ?? null,
    flags: candidate.flags
  };
}

export function compactScanPersistencePayload(scan: ScanResult) {
  return {
    generatedAt: scan.generatedAt,
    maxMinutes: scan.maxMinutes,
    totalActiveMarketsScanned: scan.totalActiveMarketsScanned,
    totalInWindowBeforeFilters: scan.totalInWindowBeforeFilters,
    returned: scan.returned,
    scanDurationMs: scan.scanDurationMs ?? null,
    candidateKeys: scan.candidates.map(candidate =>
      candidate.conditionId || candidate.id || candidate.slug || candidate.question
    ),
    eventBasketKeys: (scan.eventBaskets || []).map(basket => basket.eventId)
  };
}
