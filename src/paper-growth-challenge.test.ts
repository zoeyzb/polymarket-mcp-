import { describe, expect, it } from "vitest";
import { chooseGrowthCandidate, growthStakeUsd } from "./paper-growth-challenge.js";

describe("paper growth challenge", () => {
  it("prefers sports candidates with a useful payout-confidence balance", () => {
    const pick=chooseGrowthCandidate([
      {id:"safe",domain:"sports",family:"sports_total",entryPrice:0.96,liquidityUsd:5000,minutesRemaining:30},
      {id:"balanced",domain:"sports",family:"sports_threshold",entryPrice:0.84,liquidityUsd:1500,minutesRemaining:25},
      {id:"crypto",domain:"crypto",family:"crypto_threshold",entryPrice:0.82,liquidityUsd:10000,minutesRemaining:20}
    ]);
    expect(pick?.id).toBe("balanced");
  });

  it("rejects low-confidence or near-zero-payout candidates", () => {
    expect(chooseGrowthCandidate([
      {id:"too-risky",domain:"sports",family:"sports_total",entryPrice:0.61,liquidityUsd:5000,minutesRemaining:20},
      {id:"too-safe",domain:"sports",family:"sports_total",entryPrice:0.995,liquidityUsd:5000,minutesRemaining:20}
    ])).toBeNull();
  });

  it("prefers faster resolution when growth quality is otherwise close", () => {
    const pick=chooseGrowthCandidate([
      {id:"slow",domain:"sports",family:"sports_total",entryPrice:0.84,liquidityUsd:2000,minutesRemaining:300},
      {id:"fast",domain:"sports",family:"sports_total",entryPrice:0.84,liquidityUsd:1500,minutesRemaining:30}
    ]);
    expect(pick?.id).toBe("fast");
  });

  it("can exclude families that already have an open growth position", () => {
    const pick=chooseGrowthCandidate([
      {id:"score",domain:"sports",family:"sports_score_band",entryPrice:0.85,liquidityUsd:5000,minutesRemaining:10},
      {id:"total",domain:"sports",family:"sports_total",entryPrice:0.84,liquidityUsd:3000,minutesRemaining:20}
    ],{excludedFamilies:new Set(["sports_score_band"])});
    expect(pick?.id).toBe("total");
  });

  it("can exclude already-open market ids independently of family", () => {
    const pick=chooseGrowthCandidate([
      {id:"open",domain:"sports",family:"sports_total",entryPrice:0.85,liquidityUsd:5000,minutesRemaining:10},
      {id:"fresh",domain:"sports",family:"sports_total",entryPrice:0.84,liquidityUsd:3000,minutesRemaining:20}
    ],{excludedIds:new Set(["open"])});
    expect(pick?.id).toBe("fresh");
  });

  it("caps stake by bankroll fraction, cash and configured max", () => {
    expect(growthStakeUsd({currentBankrollUsd:100,availableCashUsd:100,maxStakeUsd:25,maxFraction:0.2})).toBe(20);
    expect(growthStakeUsd({currentBankrollUsd:200,availableCashUsd:15,maxStakeUsd:40,maxFraction:0.25})).toBe(15);
  });
});
