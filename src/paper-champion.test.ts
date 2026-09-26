import { describe, expect, it } from "vitest";
import { chooseChampionCandidate, chooseChampionPortfolio, championStakeUsd } from "./paper-champion.js";

describe("paper champion selection", () => {
  it("prefers sports at the same confidence before other domains", () => {
    const pick=chooseChampionCandidate([
      {id:"crypto",domain:"crypto",family:"crypto_threshold",entryPrice:0.95,liquidityUsd:5000,minutesRemaining:30},
      {id:"sports",domain:"sports",family:"sports_total",entryPrice:0.95,liquidityUsd:500,minutesRemaining:90}
    ]);
    expect(pick?.id).toBe("sports");
  });

  it("uses observed family win rate before raw market price when enough paper results exist", () => {
    const pick=chooseChampionCandidate([
      {id:"price",domain:"sports",family:"sports_moneyline",entryPrice:0.97,liquidityUsd:5000,minutesRemaining:30,empiricalResolvedTrades:25,empiricalWinRatePct:96,empiricalRoiPct:0.5},
      {id:"tested",domain:"sports",family:"sports_total",entryPrice:0.92,liquidityUsd:1000,minutesRemaining:45,empiricalResolvedTrades:25,empiricalWinRatePct:100,empiricalRoiPct:4}
    ]);
    expect(pick?.id).toBe("tested");
  });

  it("rejects empirically weak families from the strict champion after enough samples", () => {
    expect(chooseChampionCandidate([
      {id:"weak",domain:"sports",family:"sports_total",entryPrice:0.96,liquidityUsd:5000,minutesRemaining:20,empiricalResolvedTrades:25,empiricalWinRatePct:88,empiricalRoiPct:-5}
    ],{minEmpiricalSamples:20,minEmpiricalWinRatePct:95})).toBeNull();
  });

  it("selects several distinct strict paper bets in one cycle", () => {
    const picks=chooseChampionPortfolio([
      {id:"a",domain:"sports",family:"sports_total",entryPrice:0.94,liquidityUsd:5000,minutesRemaining:30},
      {id:"b",domain:"sports",family:"sports_player_prop",entryPrice:0.93,liquidityUsd:5000,minutesRemaining:40},
      {id:"c",domain:"sports",family:"sports_spread",entryPrice:0.92,liquidityUsd:5000,minutesRemaining:50},
      {id:"d",domain:"sports",family:"sports_moneyline",entryPrice:0.91,liquidityUsd:5000,minutesRemaining:60},
      {id:"e",domain:"crypto",family:"crypto_threshold",entryPrice:0.98,liquidityUsd:5000,minutesRemaining:10}
    ],{maxPicks:4});
    expect(picks).toHaveLength(4);
    expect(picks.every(p=>p.domain==="sports")).toBe(true);
    expect(new Set(picks.map(p=>p.id)).size).toBe(4);
  });

  it("does not select exploratory candidates below 80 percent implied probability", () => {
    expect(chooseChampionCandidate([
      {id:"a",domain:"sports",family:"sports_total",entryPrice:0.79,liquidityUsd:5000,minutesRemaining:20}
    ])).toBeNull();
  });

  it("caps a $100 bankroll stake at ten percent and available cash", () => {
    expect(championStakeUsd({currentBankrollUsd:100,availableCashUsd:100,maxStakeUsd:10})).toBe(10);
    expect(championStakeUsd({currentBankrollUsd:250,availableCashUsd:7,maxStakeUsd:25})).toBe(7);
  });
});
