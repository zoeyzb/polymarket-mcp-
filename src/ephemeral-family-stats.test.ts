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

  it("combines research and observation evidence without pulling in champion or growth feedback", () => {
    const research=createEphemeralPaperTrade({strategyId:"research_shadow_high_sports_sports_total",conditionId:"r1",tokenId:"rt1",slug:"r1",question:"r1",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:5,expectedResolutionAt:new Date().toISOString()});
    const observation=createEphemeralPaperTrade({strategyId:"observation_sports_sports_total",conditionId:"o1",tokenId:"ot1",slug:"o1",question:"o1",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:1,expectedResolutionAt:new Date().toISOString()});
    const champion=createEphemeralPaperTrade({strategyId:"champion_100_sports_sports_total",conditionId:"c1",tokenId:"ct1",slug:"c1",question:"c1",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:10,expectedResolutionAt:new Date().toISOString()});
    settleEphemeralPaperTrade({id:research.id!,won:true,winningOutcome:"Yes"});
    settleEphemeralPaperTrade({id:observation.id!,won:true,winningOutcome:"Yes"});
    settleEphemeralPaperTrade({id:champion.id!,won:false,winningOutcome:"No"});

    const [stats]=getEphemeralFamilyStats(["research_shadow_","observation_sports_"]);
    expect(stats.resolvedTrades).toBe(2);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(0);
  });
});
