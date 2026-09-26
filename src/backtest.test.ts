import { describe, expect, it } from "vitest";
import { runCalendarWalkForwardEdgeBacktest, runCalibratedEdgeBacktest, runProbabilityThresholdBacktest, runWalkForwardEdgeBacktest, sweepProbabilityThresholds } from "./backtest.js";

const samples = [
  { conditionId:"1", resolvedAt:"2026-01-01T00:00:00Z", domain:"sports", actualOutcome0:1 as const, prices:{tMinus60m:0.8} },
  { conditionId:"2", resolvedAt:"2026-01-02T00:00:00Z", domain:"sports", actualOutcome0:0 as const, prices:{tMinus60m:0.2} },
  { conditionId:"3", resolvedAt:"2026-01-03T00:00:00Z", domain:"crypto", actualOutcome0:1 as const, prices:{tMinus60m:0.75} },
  { conditionId:"4", resolvedAt:"2026-01-04T00:00:00Z", domain:"crypto", actualOutcome0:0 as const, prices:{tMinus60m:0.25} },
  { conditionId:"5", resolvedAt:"2026-01-05T00:00:00Z", domain:"weather", actualOutcome0:1 as const, prices:{tMinus60m:0.9} },
  { conditionId:"6", resolvedAt:"2026-01-06T00:00:00Z", domain:"weather", actualOutcome0:0 as const, prices:{tMinus60m:0.1} }
];

describe("historical probability replay", () => {
  it("uses chronological train and holdout samples", () => {
    const result = runProbabilityThresholdBacktest(samples, {
      horizon:"tMinus60m",
      threshold:0.7,
      trainFraction:0.5,
      bufferBps:0
    });
    expect(result.training.sampleCount).toBe(3);
    expect(result.holdout.sampleCount).toBe(3);
    expect(result.training.endAt).toBe("2026-01-03T00:00:00.000Z");
    expect(result.holdout.startAt).toBe("2026-01-04T00:00:00.000Z");
  });

  it("computes profitable $1-stake replay when high-confidence sides resolve correctly", () => {
    const result = runProbabilityThresholdBacktest(samples, {
      horizon:"tMinus60m",
      threshold:0.7,
      trainFraction:0.5,
      bufferBps:0
    });
    expect(result.holdout.trades).toBe(3);
    expect(result.holdout.wins).toBe(3);
    expect(result.holdout.hitRatePct).toBe(100);
    expect(result.holdout.totalPnlPerDollarStake).toBeGreaterThan(0);
    expect(result.holdout.roiPct).toBeGreaterThan(0);
    expect(result.holdoutDaily?.activeDays ?? 0).toBeGreaterThan(0);
    expect(result.holdoutDaily?.requiredDailyTurnoverUsd.target100 ?? 0).toBeGreaterThan(0);
  });

  it("returns stable zero-trade metrics for empty inputs", () => {
    const result = runProbabilityThresholdBacktest([], {
      horizon:"tMinus60m",
      threshold:0.9
    });
    expect(result.training.trades).toBe(0);
    expect(result.holdout.trades).toBe(0);
    expect(result.holdout.hitRatePct).toBeNull();
    expect(result.holdout.roiPct).toBeNull();
  });

  it("sweeps thresholds without claiming a guaranteed target win rate", () => {
    const result = sweepProbabilityThresholds(samples, {
      horizon:"tMinus60m",
      thresholds:[0.7,0.8,0.9],
      trainFraction:0.5,
      bufferBps:0
    });
    expect(result.results).toHaveLength(3);
    expect(result.note.toLowerCase()).toContain("not");
    expect(result.note.toLowerCase()).toContain("guarantee");
  });

  it("applies execution buffer to entry price before payout math", () => {
    const result = runProbabilityThresholdBacktest(samples, {
      horizon:"tMinus60m",
      threshold:0.7,
      trainFraction:0.5,
      bufferBps:100
    });
    const noBuffer = runProbabilityThresholdBacktest(samples, {
      horizon:"tMinus60m",
      threshold:0.7,
      trainFraction:0.5,
      bufferBps:0
    });
    expect(result.holdout.totalPnlPerDollarStake).toBeLessThan(noBuffer.holdout.totalPnlPerDollarStake);
  });

  it("enforces calendar-window daily consistency before deployment", () => {
    const start = Date.UTC(2026,0,1);
    const synthetic = Array.from({ length: 2400 }, (_, i) => {
      const price = i % 2 === 0 ? 0.8 : 0.2;
      return {
        conditionId:"cal-"+String(i+1),
        resolvedAt:new Date(start + i * 3 * 3600_000).toISOString(),
        domain:"sports",
        actualOutcome0:(price > 0.5 ? 1 : 0) as 0 | 1,
        prices:{tMinus60m:price}
      };
    });
    const result = runCalendarWalkForwardEdgeBacktest(synthetic,{
      horizon:"tMinus60m",
      bufferBps:25,
      feeMode:"none",
      minBinSamples:5,
      calendarLookbackDays:120,
      calendarFoldDays:30,
      calendarHoldoutDays:30,
      minFoldTrades:10,
      minFoldRoiPct:0.1,
      minFoldHitRatePct:95,
      minFoldActiveDays:5,
      minFoldProfitableDayPct:80,
      minHoldoutTrades:20,
      minHoldoutRoiPct:0.1,
      minValidationHitRatePct:95,
      minHoldoutActiveDays:5,
      minHoldoutProfitableDayPct:80,
      thresholds:[0.7,0.8],
      minEdgesBps:[0,25]
    });
    expect(result.deployable).toBe(true);
    expect(result.folds.length).toBeGreaterThanOrEqual(2);
    expect(result.holdoutDaily?.activeDays ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("reports the exact calendar fold and rule that rejected near-pass policies", () => {
    const start = Date.UTC(2025,0,1);
    const synthetic = Array.from({ length: 2400 }, (_, i) => {
      const ts = start + i * 3 * 3600_000;
      const day = Math.floor((ts - start) / 86_400_000);
      const price = i % 2 === 0 ? 0.8 : 0.2;
      const badWindow = day >= 210 && day < 240;
      const actual = badWindow ? (price > 0.5 ? 0 : 1) : (price > 0.5 ? 1 : 0);
      return {
        conditionId:"cal-bad-"+String(i+1),
        resolvedAt:new Date(ts).toISOString(),
        domain:"sports",
        actualOutcome0:actual as 0 | 1,
        prices:{tMinus60m:price}
      };
    });
    const result = runCalendarWalkForwardEdgeBacktest(synthetic,{
      horizon:"tMinus60m",
      bufferBps:0,
      feeMode:"none",
      minBinSamples:5,
      calendarLookbackDays:120,
      calendarFoldDays:30,
      calendarHoldoutDays:30,
      minFoldTrades:10,
      minFoldRoiPct:0.1,
      minFoldHitRatePct:95,
      minFoldActiveDays:5,
      minFoldProfitableDayPct:80,
      minHoldoutTrades:20,
      minHoldoutRoiPct:0.1,
      minValidationHitRatePct:95,
      minHoldoutActiveDays:5,
      minHoldoutProfitableDayPct:80,
      thresholds:[0.7,0.8],
      minEdgesBps:[0,25]
    });
    expect(result.deployable).toBe(false);
    expect(result.diagnostics?.rejectedPolicies ?? 0).toBeGreaterThan(0);
    const failures = (result.diagnostics?.nearPassPolicies ?? [])
      .flatMap(policy => policy.foldReports)
      .flatMap(report => report.failures);
    expect(failures.some(failure => failure === "min_roi" || failure === "min_hit_rate")).toBe(true);
  });

  it("requires every walk-forward period to clear the profit floor before deployment", () => {
    const synthetic = Array.from({ length: 500 }, (_, i) => {
      const price = i % 2 === 0 ? 0.8 : 0.2;
      return {
        conditionId:"wf-"+String(i + 1),
        resolvedAt:new Date(Date.UTC(2025,0,1) + i * 3600_000).toISOString(),
        domain:"sports",
        actualOutcome0:(price > 0.5 ? 1 : 0) as 0 | 1,
        prices:{tMinus60m:price}
      };
    });
    const result = runWalkForwardEdgeBacktest(synthetic, {
      horizon:"tMinus60m",
      bufferBps:25,
      minBinSamples:5,
      walkForwardFolds:4,
      minFoldTrades:10,
      minFoldRoiPct:0.1,
      minFoldHitRatePct:95,
      minHoldoutTrades:20,
      minHoldoutRoiPct:0.1,
      thresholds:[0.7,0.8],
      minEdgesBps:[0,25,50]
    });
    expect(result.folds).toHaveLength(4);
    expect(result.folds.every(f => (f.roiPct ?? -1) > 0)).toBe(true);
    expect(result.holdoutDaily?.activeDays ?? 0).toBeGreaterThan(0);
    expect(result.holdoutDaily?.requiredDailyTurnoverUsd.target100 ?? 0).toBeGreaterThan(0);
    expect(result.deployable).toBe(true);
  });

  it("rejects a policy when one walk-forward period is bad", () => {
    const synthetic = Array.from({ length: 500 }, (_, i) => {
      const price = i % 2 === 0 ? 0.8 : 0.2;
      const badWindow = i >= 300 && i < 360;
      const actual = badWindow ? (price > 0.5 ? 0 : 1) : (price > 0.5 ? 1 : 0);
      return {
        conditionId:"bad-"+String(i + 1),
        resolvedAt:new Date(Date.UTC(2025,0,1) + i * 3600_000).toISOString(),
        domain:"sports",
        actualOutcome0:actual as 0 | 1,
        prices:{tMinus60m:price}
      };
    });
    const result = runWalkForwardEdgeBacktest(synthetic, {
      horizon:"tMinus60m",
      bufferBps:25,
      minBinSamples:5,
      walkForwardFolds:4,
      minFoldTrades:10,
      minFoldRoiPct:0.1,
      minFoldHitRatePct:95,
      minHoldoutTrades:20,
      minHoldoutRoiPct:0.1,
      thresholds:[0.7,0.8],
      minEdgesBps:[0,25,50]
    });
    expect(result.deployable).toBe(false);
  });

  it("keeps calibrated policy selection separate from untouched holdout", () => {
    const synthetic = Array.from({ length: 180 }, (_, i) => {
      const price = i % 2 === 0 ? 0.8 : 0.2;
      return {
        conditionId:String(i + 1),
        resolvedAt:new Date(Date.UTC(2026,0,i + 1)).toISOString(),
        domain:"sports",
        actualOutcome0:(price > 0.5 ? 1 : 0) as 0 | 1,
        prices:{tMinus60m:price}
      };
    });
    const result = runCalibratedEdgeBacktest(synthetic, {
      horizon:"tMinus60m",
      bufferBps:25,
      minBinSamples:5,
      minValidationTrades:5,
      minHoldoutTrades:20,
      minValidationHitRatePct:95,
      thresholds:[0.7,0.8],
      minEdgesBps:[0,25,50]
    });
    expect(result.selectedPolicy).not.toBeNull();
    expect(result.validation?.roiPct).toBeGreaterThan(0);
    expect(result.holdout?.roiPct).toBeGreaterThan(0);
    expect(result.deployable).toBe(true);
  });
});
