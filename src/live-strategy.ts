export interface LiveCalibratedEntryInput {
  calibratedWinProbability: number;
  executionPrice: number;
  minEdgeBps: number;
  feeRate: number;
  samples: number;
  minSamples: number;
}

export interface LiveCalibratedEntryEvaluation {
  pass: boolean;
  reason: string | null;
  expectedEdgeBps: number;
  expectedNetRoiPct: number;
  estimatedFeePerDollarStake: number;
}

function round(value: number, digits = 6) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export function evaluateLiveCalibratedEntry(
  input: LiveCalibratedEntryInput
): LiveCalibratedEntryEvaluation {
  const probability = Number(input.calibratedWinProbability);
  const price = Number(input.executionPrice);
  const minEdgeBps = Math.max(0, Number(input.minEdgeBps || 0));
  const feeRate = Math.max(0, Number(input.feeRate || 0));
  const samples = Math.max(0, Math.floor(Number(input.samples || 0)));
  const minSamples = Math.max(1, Math.floor(Number(input.minSamples || 1)));

  if (!Number.isFinite(probability) || probability <= 0 || probability > 1) {
    return {
      pass:false,
      reason:"invalid_calibrated_probability",
      expectedEdgeBps:Number.NEGATIVE_INFINITY,
      expectedNetRoiPct:Number.NEGATIVE_INFINITY,
      estimatedFeePerDollarStake:0
    };
  }
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return {
      pass:false,
      reason:"invalid_execution_price",
      expectedEdgeBps:Number.NEGATIVE_INFINITY,
      expectedNetRoiPct:Number.NEGATIVE_INFINITY,
      estimatedFeePerDollarStake:0
    };
  }

  const expectedEdgeBps = round((probability - price) * 10_000, 3);
  const estimatedFeePerDollarStake = round(feeRate * (1 - price), 8);
  const expectedNetReturnPerDollar =
    probability / price - 1 - estimatedFeePerDollarStake;
  const expectedNetRoiPct = round(expectedNetReturnPerDollar * 100, 4);

  if (samples < minSamples) {
    return {
      pass:false,
      reason:"insufficient_calibration_samples",
      expectedEdgeBps,
      expectedNetRoiPct,
      estimatedFeePerDollarStake
    };
  }
  if (expectedEdgeBps < minEdgeBps) {
    return {
      pass:false,
      reason:"live_calibrated_edge_below_policy",
      expectedEdgeBps,
      expectedNetRoiPct,
      estimatedFeePerDollarStake
    };
  }
  if (!(expectedNetRoiPct > 0)) {
    return {
      pass:false,
      reason:"non_positive_live_expected_roi",
      expectedEdgeBps,
      expectedNetRoiPct,
      estimatedFeePerDollarStake
    };
  }

  return {
    pass:true,
    reason:null,
    expectedEdgeBps,
    expectedNetRoiPct,
    estimatedFeePerDollarStake
  };
}
