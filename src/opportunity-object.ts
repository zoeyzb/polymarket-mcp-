import type { ScanCandidate } from "./types.js";
import { detectStrategies, type StrategyTag } from "./strategy-registry.js";

export type OpportunityLane = "urgent_2h" | "developing_6h" | "broader_24h" | "structural";

export interface UnifiedOpportunity {
  id: string;
  generatedAt: string;
  lane: OpportunityLane;
  market: {
    id: string | null;
    conditionId: string | null;
    slug: string | null;
    question: string;
    url: string | null;
    endDate: string;
    minutesRemaining: number;
    category: string;
    liquidityUsd: number;
    volume24hUsd: number;
  };
  economics: {
    executable: boolean;
    grossEdgePct: number | null;
    netProfitUsd: number | null;
    netRoiPct: number | null;
    maxTestedBudgetUsd: number | null;
  };
  scores: {
    structural: number;
    attention: number;
    discovery: number;
    packet: number | null;
  };
  strategies: StrategyTag[];
  evidence: {
    historical: ScanCandidate["historicalEvidence"] | null;
    external: ScanCandidate["externalEvidence"] | null;
    smartMoney: ScanCandidate["smartMoney"] | null;
    marketSignals: ScanCandidate["marketSignals"] | null;
  };
  risks: string[];
}

export function buildUnifiedOpportunity(
  candidate: ScanCandidate,
  lane: OpportunityLane,
  generatedAt = new Date().toISOString()
): UnifiedOpportunity {
  return {
    id: candidate.conditionId || candidate.id || candidate.slug || candidate.question,
    generatedAt,
    lane,
    market: {
      id: candidate.id,
      conditionId: candidate.conditionId,
      slug: candidate.slug,
      question: candidate.question,
      url: candidate.url,
      endDate: candidate.endDate,
      minutesRemaining: candidate.minutesRemaining,
      category: candidate.primaryCategory,
      liquidityUsd: candidate.liquidityUsd,
      volume24hUsd: candidate.volume24hUsd
    },
    economics: {
      executable: candidate.opportunityClass === "executable_structural",
      grossEdgePct: candidate.binaryArbitrage?.grossEdgePct ?? null,
      netProfitUsd: candidate.binaryArbitrage?.bestNetProfitUsd ?? null,
      netRoiPct: candidate.binaryArbitrage?.bestNetRoiPct ?? null,
      maxTestedBudgetUsd: candidate.binaryArbitrage?.bestExecutableBudgetUsd ?? null
    },
    scores: {
      structural: candidate.opportunityScore,
      attention: candidate.attentionScore ?? candidate.opportunityScore,
      discovery: candidate.discoveryScore ?? candidate.opportunityScore,
      packet: candidate.opportunityPacketScore ?? null
    },
    strategies: detectStrategies(candidate),
    evidence: {
      historical: candidate.historicalEvidence ?? null,
      external: candidate.externalEvidence ?? null,
      smartMoney: candidate.smartMoney ?? null,
      marketSignals: candidate.marketSignals ?? null
    },
    risks: [...new Set(candidate.flags)]
  };
}
