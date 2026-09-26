import { describe, expect, it } from "vitest";
import { simulateBankroll, sizeBankrollTrade } from "./bankroll.js";

describe("bankroll simulation", () => {
  it("rejects trades when cash is exhausted by overlapping positions", () => {
    const result = simulateBankroll([
      { id:"a", entryAt:"2026-01-01T10:00:00Z", settleAt:"2026-01-01T12:00:00Z", requestedStakeUsd:80, returnMultiple:1.1 },
      { id:"b", entryAt:"2026-01-01T10:30:00Z", settleAt:"2026-01-01T11:30:00Z", requestedStakeUsd:30, returnMultiple:1.1 }
    ], { startingBankrollUsd:100, maxTradeFraction:1, maxConcurrentExposureFraction:1, dailyLossLimitFraction:1 });

    expect(result.tradesEntered).toBe(1);
    expect(result.tradesSkippedInsufficientCash).toBe(1);
    expect(result.endBankrollUsd).toBeCloseTo(108, 6);
  });

  it("recycles settled principal and pnl into later same-day trades", () => {
    const result = simulateBankroll([
      { id:"a", entryAt:"2026-01-01T09:00:00Z", settleAt:"2026-01-01T10:00:00Z", requestedStakeUsd:100, returnMultiple:1.1 },
      { id:"b", entryAt:"2026-01-01T10:30:00Z", settleAt:"2026-01-01T11:30:00Z", requestedStakeUsd:110, returnMultiple:1.1 }
    ], { startingBankrollUsd:100, maxTradeFraction:1, maxConcurrentExposureFraction:1, dailyLossLimitFraction:1 });

    expect(result.tradesEntered).toBe(2);
    expect(result.bankrollRotations).toBeGreaterThan(2);
    expect(result.endBankrollUsd).toBeCloseTo(121, 6);
  });

  it("stops new entries after the configured daily loss cap is reached", () => {
    const result = simulateBankroll([
      { id:"loss", entryAt:"2026-01-01T09:00:00Z", settleAt:"2026-01-01T10:00:00Z", requestedStakeUsd:20, returnMultiple:0 },
      { id:"later", entryAt:"2026-01-01T10:30:00Z", settleAt:"2026-01-01T11:00:00Z", requestedStakeUsd:20, returnMultiple:2 }
    ], { startingBankrollUsd:100, maxTradeFraction:1, maxConcurrentExposureFraction:1, dailyLossLimitFraction:0.2 });

    expect(result.tradesEntered).toBe(1);
    expect(result.tradesSkippedDailyLossLimit).toBe(1);
    expect(result.endBankrollUsd).toBeCloseTo(80, 6);
  });

  it("sizes stronger positive edges higher while respecting trade and exposure caps", () => {
    const weak = sizeBankrollTrade({
      bankrollUsd:100,
      availableCashUsd:100,
      concurrentExposureUsd:0,
      expectedEdgeBps:300,
      expectedNetRoiPct:2,
      maxTradeFraction:0.25,
      maxConcurrentExposureFraction:0.5
    });
    const strong = sizeBankrollTrade({
      bankrollUsd:100,
      availableCashUsd:100,
      concurrentExposureUsd:0,
      expectedEdgeBps:1200,
      expectedNetRoiPct:12,
      maxTradeFraction:0.25,
      maxConcurrentExposureFraction:0.5
    });

    expect(strong.stakeUsd).toBeGreaterThan(weak.stakeUsd);
    expect(strong.stakeUsd).toBeLessThanOrEqual(25);
    expect(strong.stakeUsd).toBeLessThanOrEqual(50);
  });
});
