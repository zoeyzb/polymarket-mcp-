import { describe, expect, it } from "vitest";
import { chooseChampionCandidate, championStakeUsd } from "./paper-champion.js";

describe("paper champion selection", () => {
  it("prefers sports at the same confidence before other domains", () => {
    const pick=chooseChampionCandidate([
      {id:"crypto",domain:"crypto",family:"crypto_threshold",entryPrice:0.95,liquidityUsd:5000,minutesRemaining:30},
      {id:"sports",domain:"sports",family:"sports_total",entryPrice:0.95,liquidityUsd:500,minutesRemaining:90}
    ]);
    expect(pick?.id).toBe("sports");
  });

  it("prefers higher confidence within sports", () => {
    const pick=chooseChampionCandidate([
      {id:"a",domain:"sports",family:"sports_total",entryPrice:0.84,liquidityUsd:5000,minutesRemaining:20},
      {id:"b",domain:"sports",family:"sports_player_prop",entryPrice:0.94,liquidityUsd:400,minutesRemaining:100}
    ]);
    expect(pick?.id).toBe("b");
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
