import { describe, expect, it } from "vitest";
import { runProbabilityThresholdBacktest, sweepProbabilityThresholds } from "./backtest.js";

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
});
