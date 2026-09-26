import { describe, expect, it } from "vitest";
import { computePaperPortfolioState } from "./paper-portfolio.js";

describe("computePaperPortfolioState", () => {
  it("subtracts open exposure from available cash", () => {
    expect(computePaperPortfolioState({
      startingBankrollUsd:100,
      realizedNetPnlUsd:10,
      openExposureUsd:35
    })).toEqual({
      startingBankrollUsd:100,
      currentBankrollUsd:110,
      openExposureUsd:35,
      availableCashUsd:75,
      returnPct:10
    });
  });

  it("never allows negative available cash or bankroll", () => {
    const result=computePaperPortfolioState({
      startingBankrollUsd:100,
      realizedNetPnlUsd:-120,
      openExposureUsd:20
    });
    expect(result.currentBankrollUsd).toBe(0);
    expect(result.availableCashUsd).toBe(0);
  });
});
