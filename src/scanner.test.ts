import { describe, expect, it } from "vitest";
import { parseNumberArray, parseStringArray } from "./polymarket.js";
import { calculateCompleteSetExecution } from "./scanner.js";
import type { NormalizedBook } from "./types.js";

function book(tokenId: string, asks: Array<[number, number]>): NormalizedBook {
  return {
    tokenId,
    bestBid: null,
    bestAsk: asks[0]?.[0] ?? null,
    spread: null,
    midpoint: asks[0]?.[0] ?? null,
    bidDepthUsdTop5: 0,
    askDepthUsdTop5: asks.slice(0, 5).reduce((s, [price, size]) => s + price * size, 0),
    raw: {
      asset_id: tokenId,
      bids: [],
      asks: asks.map(([price, size]) => ({ price, size }))
    }
  };
}

describe("Gamma parsing", () => {
  it("parses JSON encoded string arrays", () => {
    expect(parseStringArray('["Yes","No"]')).toEqual(["Yes", "No"]);
  });

  it("parses numeric outcome prices", () => {
    expect(parseNumberArray('["0.42","0.58"]')).toEqual([0.42, 0.58]);
  });
});

describe("complete-set execution", () => {
  it("finds executable binary arbitrage at real depth", () => {
    const yes = book("yes", [[0.45, 100]]);
    const no = book("no", [[0.50, 100]]);
    const result = calculateCompleteSetExecution([yes, no], 50, 50);

    expect(result.fillComplete).toBe(true);
    expect(result.sharesEach).toBeGreaterThan(52);
    expect(result.grossProfit).toBeGreaterThan(2.5);
    expect(result.netProfitAfterBuffer).toBeGreaterThan(2);
    expect(result.netRoiPct).toBeGreaterThan(4);
  });

  it("rejects a top-of-book mirage when depth cannot fill both legs", () => {
    const yes = book("yes", [[0.40, 1], [0.60, 100]]);
    const no = book("no", [[0.40, 1], [0.60, 100]]);
    const result = calculateCompleteSetExecution([yes, no], 50, 50);

    expect(result.fillComplete).toBe(true);
    expect(result.grossProfit).toBeLessThanOrEqual(0);
    expect(result.netProfitAfterBuffer).toBeLessThan(0);
  });

  it("returns no fill when any outcome has no asks", () => {
    const yes = book("yes", [[0.45, 100]]);
    const no = book("no", []);
    const result = calculateCompleteSetExecution([yes, no], 25, 50);

    expect(result.fillComplete).toBe(false);
    expect(result.sharesEach).toBe(0);
  });
});
