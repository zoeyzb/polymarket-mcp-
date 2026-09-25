import type { ScanCandidate } from "./types.js";

export interface StrategyTag {
  id:
    | "binary_complete_set"
    | "negrisk_complete_set"
    | "logical_relative_value"
    | "sports_line_relative_value"
    | "maker_edge"
    | "cross_venue"
    | "behavioral_anomaly"
    | "research";
  label: string;
  strength: number;
}

export function detectStrategies(candidate: ScanCandidate): StrategyTag[] {
  const out: StrategyTag[] = [];

  if (candidate.opportunityClass === "executable_structural" && candidate.binaryArbitrage) {
    out.push({ id:"binary_complete_set", label:"Depth-backed complete-set", strength:100 });
  }
  if (candidate.logicalRelations?.length) {
    out.push({ id:"logical_relative_value", label:"Logical relative value", strength:Math.min(100, 60 + candidate.logicalRelations.length * 5) });
  }
  if (candidate.sportsRelations?.length) {
    out.push({ id:"sports_line_relative_value", label:"Sports line relative value", strength:Math.min(100, 60 + candidate.sportsRelations.length * 5) });
  }
  if ((candidate.makerEdge?.makerOpportunityScore ?? 0) >= 50) {
    out.push({ id:"maker_edge", label:"Maker spread opportunity", strength:Math.min(100, candidate.makerEdge?.makerOpportunityScore ?? 0) });
  }
  if ((candidate.crossVenue?.length ?? 0) > 0) {
    out.push({ id:"cross_venue", label:"Cross-venue discrepancy", strength:Math.min(100, candidate.crossVenue?.[0]?.resolutionMatchScore ? candidate.crossVenue[0].resolutionMatchScore * 100 : 65) });
  }
  if (candidate.flags.some(flag => ["price_shock","strong_recent_trade_imbalance","large_recent_trade"].includes(flag))) {
    out.push({ id:"behavioral_anomaly", label:"Behavioral anomaly", strength:Math.min(100, candidate.attentionScore ?? candidate.opportunityScore) });
  }
  if (!out.length) {
    out.push({ id:"research", label:"Research candidate", strength:Math.min(100, candidate.discoveryScore ?? candidate.opportunityScore) });
  }

  return out;
}
