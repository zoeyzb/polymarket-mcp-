export interface DigitalOptionInput {
  spot: number;
  strike: number;
  volatility: number;
  timeYears: number;
  riskFreeRate?: number;
  dividendYield?: number;
  direction?: "above" | "below";
}

export interface DigitalOptionFairValue {
  direction: "above" | "below";
  spot: number;
  strike: number;
  volatility: number;
  timeYears: number;
  riskFreeRate: number;
  dividendYield: number;
  d1: number;
  d2: number;
  riskNeutralProbability: number;
  discountedCashValue: number;
  undiscountedDollarPayoutValue: number;
  distanceToStrikePct: number;
  warnings: string[];
  note: string;
}

function erf(x: number) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) *
    t *
    Math.exp(-ax * ax)
  );
  return sign * y;
}

function normalCdf(x: number) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function round(value: number, digits = 8) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export function priceCashOrNothingDigital(
  input: DigitalOptionInput
): DigitalOptionFairValue {
  const spot = Number(input.spot);
  const strike = Number(input.strike);
  const volatility = Number(input.volatility);
  const timeYears = Number(input.timeYears);
  const riskFreeRate = Number(input.riskFreeRate ?? 0);
  const dividendYield = Number(input.dividendYield ?? 0);
  const direction = input.direction ?? "above";

  if (!(spot > 0)) throw new Error("spot_must_be_positive");
  if (!(strike > 0)) throw new Error("strike_must_be_positive");
  if (!(volatility > 0)) throw new Error("volatility_must_be_positive");
  if (!(timeYears > 0)) throw new Error("time_years_must_be_positive");

  const sigmaSqrtT = volatility * Math.sqrt(timeYears);
  const d1 =
    (
      Math.log(spot / strike) +
      (riskFreeRate - dividendYield + 0.5 * volatility * volatility) * timeYears
    ) / sigmaSqrtT;
  const d2 = d1 - sigmaSqrtT;

  const probability =
    direction === "above"
      ? normalCdf(d2)
      : normalCdf(-d2);
  const discount = Math.exp(-riskFreeRate * timeYears);
  const discountedCashValue = discount * probability;

  const warnings: string[] = [];
  if (volatility > 2) warnings.push("extreme_volatility_input");
  if (timeYears < 1 / 365) warnings.push("sub_day_expiry_model_sensitivity");
  if (Math.abs((spot - strike) / strike) < 0.01) warnings.push("near_strike_high_gamma");
  if (Math.abs(riskFreeRate) > 0.2) warnings.push("unusual_rate_input");

  return {
    direction,
    spot,
    strike,
    volatility,
    timeYears,
    riskFreeRate,
    dividendYield,
    d1: round(d1),
    d2: round(d2),
    riskNeutralProbability: round(probability),
    discountedCashValue: round(discountedCashValue),
    undiscountedDollarPayoutValue: round(probability),
    distanceToStrikePct: round(((spot - strike) / strike) * 100, 5),
    warnings,
    note:
      "Black-Scholes cash-or-nothing digital comparator. The probability is risk-neutral, not a guaranteed real-world event probability. For systematic use, prefer live option-implied volatility around the same strike/expiry."
  };
}
