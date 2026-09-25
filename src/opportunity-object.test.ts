import { describe, expect, it } from "vitest";
import { buildUnifiedOpportunity } from "./opportunity-object.js";
import type { ScanCandidate } from "./types.js";

function candidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return {
    id:"1", slug:"test-market", question:"Will test happen?", conditionId:"0x1",
    endDate:"2026-09-26T10:00:00Z", minutesRemaining:90, acceptingOrders:true,
    liquidityUsd:5000, volumeUsd:10000, volume24hUsd:2500,
    outcomes:["Yes","No"], tokenIds:["yes","no"], displayedOutcomePrices:[0.45,0.55],
    resolutionSource:null, resolutionRules:"Resolves from official source.", url:"https://polymarket.com/event/test-market",
    binaryArbitrage:null, categories:["other"], primaryCategory:"other",
    opportunityClass:"research_candidate", opportunityScore:42, attentionScore:55,
    discoveryScore:55, rapidReviewScore:60, scoreBreakdown:{}, flags:[],
    ...overrides
  };
}

describe("unified opportunity object", () => {
  it("normalizes a research candidate into one stable object", () => {
    const out = buildUnifiedOpportunity(candidate(), "urgent_2h", "2026-09-26T00:00:00Z");
    expect(out.id).toBe("0x1");
    expect(out.lane).toBe("urgent_2h");
    expect(out.market.slug).toBe("test-market");
    expect(out.economics.executable).toBe(false);
    expect(out.scores.discovery).toBe(55);
  });

  it("captures executable complete-set economics and strategy tags", () => {
    const out = buildUnifiedOpportunity(candidate({
      opportunityClass:"executable_structural",
      opportunityScore:91,
      binaryArbitrage:{
        buyBothAskTotal:0.96,
        grossEdgePerDollar:0.04,
        grossEdgePct:4,
        executable:[],
        bestExecutableBudgetUsd:100,
        bestNetProfitUsd:3.25,
        bestNetRoiPct:3.4,
        note:"test"
      },
      flags:["binary_structural_edge_executable_at_depth"]
    }), "structural", "2026-09-26T00:00:00Z");

    expect(out.economics.executable).toBe(true);
    expect(out.economics.netProfitUsd).toBe(3.25);
    expect(out.strategies.some(s => s.id === "binary_complete_set")).toBe(true);
  });
});
