import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configureEphemeralPaperPersistence,
  createEphemeralPaperTrade,
  getEphemeralOpenTrades,
  getEphemeralPaperPersistenceStatus,
  getEphemeralPaperStats,
  getStructuralBasketPaperStats,
  listStructuralBasketPaper,
  recordStructuralBasketPaper,
  resetEphemeralPaperLab,
  settleEphemeralPaperTrade
} from "./ephemeral-paper-lab.js";

const dirs:string[]=[];

afterEach(async()=>{
  configureEphemeralPaperPersistence(null);
  resetEphemeralPaperLab();
  await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));
});

async function statePath(){
  const dir=await mkdtemp(join(tmpdir(),"poly-paper-"));
  dirs.push(dir);
  return join(dir,"paper-lab.json");
}

describe("durable ephemeral paper ledger",()=>{
  it("writes inserted paper trades to disk atomically", async()=>{
    const file=await statePath();
    const configured=configureEphemeralPaperPersistence(file);
    expect(configured.configured).toBe(true);

    const result=createEphemeralPaperTrade({
      strategyId:"growth_100_sports_sports_total",
      conditionId:"c1",tokenId:"t1",slug:"s1",question:"q1",
      domain:"sports",family:"sports_total",outcome:"Yes",
      entryPrice:0.85,stakeUsd:20,expectedResolutionAt:null
    });

    expect(result.inserted).toBe(true);
    expect(existsSync(file)).toBe(true);
    const persisted=JSON.parse(readFileSync(file,"utf8"));
    expect(persisted.trades).toHaveLength(1);
    expect(persisted.trades[0].conditionId).toBe("c1");
    expect(getEphemeralPaperPersistenceStatus().lastWriteAt).toBeTruthy();
  });

  it("restores open trades after memory is cleared", async()=>{
    const file=await statePath();
    configureEphemeralPaperPersistence(file);
    createEphemeralPaperTrade({
      strategyId:"champion_100_sports_sports_moneyline",
      conditionId:"c2",tokenId:"t2",slug:"s2",question:"q2",
      domain:"sports",family:"sports_moneyline",outcome:"No",
      entryPrice:0.9,stakeUsd:10,expectedResolutionAt:null
    });

    configureEphemeralPaperPersistence(null);
    resetEphemeralPaperLab();
    const loaded=configureEphemeralPaperPersistence(file);

    expect(loaded.loadedTrades).toBe(1);
    expect(getEphemeralOpenTrades(10)).toHaveLength(1);
    expect(getEphemeralPaperStats("champion_100_").openExposureUsd).toBe(10);
  });

  it("persists settlements so pnl survives a restart", async()=>{
    const file=await statePath();
    configureEphemeralPaperPersistence(file);
    const created=createEphemeralPaperTrade({
      strategyId:"growth_100_sports_sports_spread",
      conditionId:"c3",tokenId:"t3",slug:"s3",question:"q3",
      domain:"sports",family:"sports_spread",outcome:"Yes",
      entryPrice:0.8,stakeUsd:20,expectedResolutionAt:null
    });
    settleEphemeralPaperTrade({id:Number(created.id),won:true,winningOutcome:"Yes"});

    configureEphemeralPaperPersistence(null);
    resetEphemeralPaperLab();
    configureEphemeralPaperPersistence(file);

    const stats=getEphemeralPaperStats("growth_100_");
    expect(stats.resolvedTrades).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.netPnlUsd).toBeGreaterThan(0);
  });

  it("persists and restores structural basket observations without double-counting repeated scans", async()=>{
    const file=await statePath();
    configureEphemeralPaperPersistence(file);
    const first=recordStructuralBasketPaper({
      eventId:"event-1",eventTitle:"Three-way event",marketCount:3,
      yesTokenIds:["a","b","c"],budgetUsd:100,netProfitUsd:2.5,netRoiPct:2.5
    });
    const repeat=recordStructuralBasketPaper({
      eventId:"event-1",eventTitle:"Three-way event",marketCount:3,
      yesTokenIds:["c","b","a"],budgetUsd:100,netProfitUsd:3,netRoiPct:3
    });
    expect(first.inserted).toBe(true);
    expect(repeat.inserted).toBe(false);
    expect(getStructuralBasketPaperStats().uniqueBaskets).toBe(1);
    expect(getStructuralBasketPaperStats().sightings).toBe(2);
    expect(listStructuralBasketPaper(10)[0]?.bestNetProfitUsd).toBe(3);

    configureEphemeralPaperPersistence(null);
    resetEphemeralPaperLab();
    const loaded=configureEphemeralPaperPersistence(file);
    expect(loaded.loadedStructuralBaskets).toBe(1);
    expect(getStructuralBasketPaperStats().uniqueBaskets).toBe(1);
    expect(getStructuralBasketPaperStats().sightings).toBe(2);
  });

  it("fails open to memory when the state file is unreadable", async()=>{
    const file=await statePath();
    const { writeFile }=await import("node:fs/promises");
    await writeFile(file,"not-json","utf8");
    const result=configureEphemeralPaperPersistence(file);
    expect(result.configured).toBe(true);
    expect(result.loadedTrades).toBe(0);
    expect(result.error).toBeTruthy();

    const created=createEphemeralPaperTrade({
      strategyId:"research_shadow_high_sports_sports_total",
      conditionId:"c4",tokenId:"t4",slug:"s4",question:"q4",
      domain:"sports",family:"sports_total",outcome:"Yes",
      entryPrice:0.9,stakeUsd:5,expectedResolutionAt:null
    });
    expect(created.inserted).toBe(true);
  });
});
