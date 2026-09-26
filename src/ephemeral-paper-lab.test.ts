import { describe, expect, it, beforeEach } from "vitest";
import {
  resetEphemeralPaperLab,
  createEphemeralPaperTrade,
  getEphemeralOpenTrades,
  listEphemeralPaperTrades,
  getEphemeralPaperStats,
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

  it("lists both open and resolved paper trades for inspection", () => {
    const r=createEphemeralPaperTrade({strategyId:"growth_100_sports_sports_total",conditionId:"g1",tokenId:"gt1",slug:"g1",question:"g1",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.85,stakeUsd:20,expectedResolutionAt:new Date().toISOString()});
    settleEphemeralPaperTrade({id:r.id!,won:true,winningOutcome:"Yes"});
    createEphemeralPaperTrade({strategyId:"growth_100_sports_sports_total",conditionId:"g2",tokenId:"gt2",slug:"g2",question:"g2",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.82,stakeUsd:20,expectedResolutionAt:new Date(Date.now()+60000).toISOString()});
    const rows=listEphemeralPaperTrades(10,"growth_100_");
    expect(rows).toHaveLength(2);
    expect(rows.some(row=>row.status==="WIN")).toBe(true);
    expect(rows.some(row=>row.status==="OPEN")).toBe(true);
  });

  it("reports current UTC-day results separately for daily bankroll analysis", () => {
    const r=createEphemeralPaperTrade({strategyId:"growth_100_sports_sports_threshold",conditionId:"d1",tokenId:"dt1",slug:"d1",question:"d1",domain:"sports",family:"sports_threshold",outcome:"Yes",entryPrice:0.8,stakeUsd:20,expectedResolutionAt:new Date().toISOString()});
    settleEphemeralPaperTrade({id:r.id!,won:true,winningOutcome:"Yes"});
    const daily=getEphemeralDailyStats("growth_100_");
    expect(daily.trades).toBe(1);
    expect(daily.resolvedTrades).toBe(1);
    expect(daily.wins).toBe(1);
    expect(daily.netPnlUsd).toBeGreaterThan(0);
    expect(daily.day).toBe(new Date().toISOString().slice(0,10));
  });

  it("keeps research and champion prefixes isolated", () => {
    createEphemeralPaperTrade({strategyId:"research_shadow_high_sports_sports_total",conditionId:"a",tokenId:"a",slug:"a",question:"a",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:5,expectedResolutionAt:new Date().toISOString()});
    createEphemeralPaperTrade({strategyId:"champion_100_sports_sports_total",conditionId:"b",tokenId:"b",slug:"b",question:"b",domain:"sports",family:"sports_total",outcome:"Yes",entryPrice:0.9,stakeUsd:10,expectedResolutionAt:new Date().toISOString()});
    expect(getEphemeralPaperStats("research_shadow_").trades).toBe(1);
    expect(getEphemeralPaperStats("champion_100_").trades).toBe(1);
  });
});
