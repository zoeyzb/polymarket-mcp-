import { describe, expect, it } from "vitest";
import { compactCandidatePersistencePayload, compactScanPersistencePayload } from "./persistence-payload.js";
import type { ScanCandidate } from "./types.js";

const candidate: ScanCandidate = {
  id:"1",slug:"x",question:"Q?",conditionId:"c",endDate:"2026-09-26T00:00:00Z",
  minutesRemaining:10,acceptingOrders:true,liquidityUsd:1000,volumeUsd:2000,volume24hUsd:500,
  outcomes:["Yes","No"],tokenIds:["a","b"],displayedOutcomePrices:[0.4,0.6],
  resolutionSource:null,resolutionRules:"long rules that should not be duplicated",url:null,
  categories:["crypto"],primaryCategory:"crypto",opportunityClass:"research_candidate",
  opportunityScore:40,discoveryScore:55,rapidReviewScore:50,scoreBreakdown:{},flags:["x"],
  books:[{outcome:"Yes",tokenId:"a",bestBid:.39,bestAsk:.4,spread:.01,midpoint:.395,bidDepthUsdTop5:100,askDepthUsdTop5:100,executions:[]}],
  binaryArbitrage:null
};

describe("persistence payload compaction", () => {
  it("keeps fields required by historical/behavior queries and drops heavy books/rules", () => {
    const out = compactCandidatePersistencePayload(candidate);
    expect(out.tokenIds).toEqual(["a","b"]);
    expect(out.primaryCategory).toBe("crypto");
    expect(JSON.stringify(out)).not.toContain("long rules");
    expect(JSON.stringify(out)).not.toContain("bestBid");
  });

  it("stores scan keys instead of duplicating full candidate payloads", () => {
    const out = compactScanPersistencePayload({
      generatedAt:"2026-09-26T00:00:00Z",maxMinutes:1440,totalActiveMarketsScanned:100,
      totalInWindowBeforeFilters:1,returned:1,candidates:[candidate],eventBaskets:[]
    });
    expect(out.candidateKeys).toEqual(["c"]);
    expect(JSON.stringify(out)).not.toContain("long rules");
  });
});
