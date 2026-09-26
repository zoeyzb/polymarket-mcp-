import { describe, expect, it } from "vitest";
import { evaluateLiveCalibratedEntry } from "./live-strategy.js";

describe("live calibrated shadow entry", () => {
  it("rejects a 0.999 fill that cannot clear a 300 bps edge floor", () => {
    const out = evaluateLiveCalibratedEntry({
      calibratedWinProbability: 0.99,
      executionPrice: 0.999,
      minEdgeBps: 300,
      feeRate: 0.05,
      samples: 100,
      minSamples: 20
    });

    expect(out.pass).toBe(false);
    expect(out.expectedEdgeBps).toBeLessThan(300);
    expect(out.expectedNetRoiPct).toBeLessThan(0);
  });

  it("accepts a sufficiently discounted fill with positive fee-aware expected ROI", () => {
    const out = evaluateLiveCalibratedEntry({
      calibratedWinProbability: 0.9,
      executionPrice: 0.85,
      minEdgeBps: 300,
      feeRate: 0.05,
      samples: 100,
      minSamples: 20
    });

    expect(out.pass).toBe(true);
    expect(out.expectedEdgeBps).toBe(500);
    expect(out.expectedNetRoiPct).toBeGreaterThan(0);
  });

  it("rejects a calibration bucket that is below the selected minimum sample count", () => {
    const out = evaluateLiveCalibratedEntry({
      calibratedWinProbability: 0.92,
      executionPrice: 0.85,
      minEdgeBps: 300,
      feeRate: 0.05,
      samples: 19,
      minSamples: 20
    });

    expect(out.pass).toBe(false);
    expect(out.reason).toBe("insufficient_calibration_samples");
  });
});
