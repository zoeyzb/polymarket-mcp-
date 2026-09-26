import { describe, expect, it, beforeEach } from "vitest";
import {
  resetEphemeralPaperLab,
  createEphemeralPaperTrade,
  getEphemeralOpenTrades,
  getEphemeralPaperStats,
  listEphemeralPaperTrades,
  getEphemeralDailyStats,
  settleEphemeralPaperTrade
} from "./ephemeral-paper-lab.js";

describe("ephemeral paper lab", () => {
  beforeEach(()=>resetEphemeralPaperLab());

  it("deduplicates strategy + condition + token", () => {
    const input={strategyId:"research_shadow_high_sports_sports_total",conditionId:"c1",tokenId:"t1",slug:"m1",question:"Over 3.5?",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:5,expectedResolutionAt:new Date(Date.now()+60000).toISOString()};
    expect(createEphemeralPaperTrade(input).inserted).toBe(true);
    expect(createEphemeralPaperTrade(input).inserted).toBe(false);
    expect(getEphemeralOpenTrades().length).toBe(1);
  });

  it("tracks a real $100 champion bankroll after settlement", () => {
    const r=createEphemeralPaperTrade({
      strategyId:"champion_100_sports_sports_total",conditionId:"c1",tokenId:"t1",slug:"m1",question:"Over 3.5?",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:10,expectedResolutionAt:new Date().toISOString()
    });
    settleEphemeralPaperTrade({id:r.id!,won:true,winningOutcome:"Yes"});
    const stats=getEphemeralPaperStats("champion_100_");
    expect(stats.wins).toBe(1);
    expect(stats.openTrades).toBe(0);
    expect(stats.netPnlUsd).toBeGreaterThan(0);
  });

  it("keeps research and champion prefixes isolated", () => {
    createEphemeralPaperTrade({strategyId:"research_shadow_high_sports_sports_total",conditionId:"a",tokenId:"a",slug:"a",question:"a",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:5,expectedResolutionAt:new Date().toISOString()});
    createEphemeralPaperTrade({strategyId:"champion_100_sports_sports_total",conditionId:"b",tokenId:"b",slug:"b",question:"b",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:10,expectedResolutionAt:new Date().toISOString()});
    expect(getEphemeralPaperStats("research_shadow_").trades).toBe(1);
    expect(getEphemeralPaperStats("champion_100_").trades).toBe(1);
  });
  it("lists resolved and open ephemeral trades, newest first", () => {
    const a=createEphemeralPaperTrade({strategyId:"growth_100_sports_sports_total",conditionId:"a",tokenId:"a",slug:"a",question:"a",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.8,stakeUsd:10,expectedResolutionAt:null});
    createEphemeralPaperTrade({strategyId:"growth_100_sports_sports_total",conditionId:"b",tokenId:"b",slug:"b",question:"b",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.8,stakeUsd:10,expectedResolutionAt:null});
    settleEphemeralPaperTrade({id:Number(a.id),won:true,winningOutcome:"Yes"});
    const rows=listEphemeralPaperTrades(10,"growth_100_");
    expect(rows).toHaveLength(2);
    expect(rows.some(r=>r.status==="WIN")).toBe(true);
    expect(rows.some(r=>r.status==="OPEN")).toBe(true);
  });

  it("reports same-day pnl separately for each paper strategy", () => {
    const r=createEphemeralPaperTrade({strategyId:"growth_100_sports_sports_total",conditionId:"g",tokenId:"g",slug:"g",question:"g",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.8,stakeUsd:20,expectedResolutionAt:null});
    settleEphemeralPaperTrade({id:Number(r.id),won:true,winningOutcome:"Yes"});
    const daily=getEphemeralDailyStats("growth_100_");
    expect(daily.resolvedTrades).toBe(1);
    expect(daily.netPnlUsd).toBeGreaterThan(0);
    expect(daily.winRatePct).toBe(100);
  });
});
