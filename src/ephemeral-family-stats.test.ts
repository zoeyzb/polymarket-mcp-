import { beforeEach, describe, expect, it } from "vitest";
import {
  createEphemeralPaperTrade,
  getEphemeralFamilyStats,
  resetEphemeralPaperLab,
  settleEphemeralPaperTrade
} from "./ephemeral-paper-lab.js";

describe("ephemeral family paper stats", () => {
  beforeEach(()=>resetEphemeralPaperLab());

  it("tracks resolved win rate and roi by market family", () => {
    const a=createEphemeralPaperTrade({
      strategyId:"research_shadow_high_sports_sports_total",conditionId:"a",tokenId:"a0",slug:"a",question:"a",
      domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.8,stakeUsd:10,expectedResolutionAt:null
    });
    const b=createEphemeralPaperTrade({
      strategyId:"research_shadow_high_sports_sports_total",conditionId:"b",tokenId:"b0",slug:"b",question:"b",
      domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.8,stakeUsd:10,expectedResolutionAt:null
    });
    settleEphemeralPaperTrade({id:Number(a.id),won:true,winningOutcome:"Yes"});
    settleEphemeralPaperTrade({id:Number(b.id),won:false,winningOutcome:"No"});

    const row=getEphemeralFamilyStats("research_shadow_").find(x=>x.family==="sports_total");
    expect(row?.resolvedTrades).toBe(2);
    expect(row?.winRatePct).toBe(50);
    expect(row?.aggregateRoiPct).not.toBeNull();
  });
});
