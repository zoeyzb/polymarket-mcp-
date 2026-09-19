import { describe, expect, it } from "vitest";
import { parseNumberArray, parseStringArray } from "./polymarket.js";
import { calculateCompleteSetExecution } from "./scanner.js";
import {
  analyzePriceHistoryPayload,
  analyzeTradeFlowPayload,
  calculateCompleteOutcomeBasket
} from "./intelligence.js";
import { inferFinalResolution } from "./resolutions.js";
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


describe("multi-outcome basket execution", () => {
  it("finds a depth-backed complete-set edge across three outcomes", () => {
    const a = book("a", [[0.25, 100]]);
    const b = book("b", [[0.30, 100]]);
    const c = book("c", [[0.35, 100]]);
    const result = calculateCompleteOutcomeBasket([a, b, c], 90, 50);

    expect(result.fillComplete).toBe(true);
    expect(result.grossProfitUsd).toBeGreaterThan(9);
    expect(result.netProfitUsd).toBeGreaterThan(8);
    expect(result.netRoiPct).toBeGreaterThan(9);
  });

  it("rejects an incomplete complete-set basket", () => {
    const a = book("a", [[0.25, 100]]);
    const b = book("b", []);
    const c = book("c", [[0.35, 100]]);
    const result = calculateCompleteOutcomeBasket([a, b, c], 90, 50);
    expect(result.fillComplete).toBe(false);
  });
});

describe("price regime analysis", () => {
  it("detects a shock move", () => {
    const analysis = analyzePriceHistoryPayload({
      history: [
        { t: 1, p: 0.20 },
        { t: 2, p: 0.21 },
        { t: 3, p: 0.22 },
        { t: 4, p: 0.36 }
      ]
    });
    expect(analysis.regime).toBe("shock");
    expect(analysis.anomalyScore).toBeGreaterThan(50);
  });

  it("classifies stable prices without overcalling an anomaly", () => {
    const analysis = analyzePriceHistoryPayload({
      history: [
        { t: 1, p: 0.50 },
        { t: 2, p: 0.501 },
        { t: 3, p: 0.499 },
        { t: 4, p: 0.502 }
      ]
    });
    expect(analysis.regime).toBe("stable");
    expect(analysis.anomalyScore).toBeLessThan(20);
  });
});


describe("trade flow analysis", () => {
  it("detects concentrated buy-side flow", () => {
    const now = 2_000_000_000_000;
    const analysis = analyzeTradeFlowPayload([
      { price: 0.6, size: 1000, side: "BUY", timestamp: (now - 60_000) / 1000 },
      { price: 0.61, size: 500, side: "BUY", timestamp: (now - 120_000) / 1000 },
      { price: 0.59, size: 50, side: "SELL", timestamp: (now - 180_000) / 1000 }
    ], now);

    expect(analysis.buyUsd).toBeGreaterThan(800);
    expect(analysis.signedImbalance).toBeGreaterThan(0.8);
    expect(analysis.recent5mUsd).toBeGreaterThan(800);
    expect(analysis.flowScore).toBeGreaterThan(50);
  });

  it("does not fabricate flow when trades are malformed", () => {
    const analysis = analyzeTradeFlowPayload([
      { price: 2, size: 10, side: "BUY" },
      { price: 0.5, size: 0, side: "SELL" }
    ]);
    expect(analysis.trades).toBe(0);
    expect(analysis.totalUsd).toBe(0);
    expect(analysis.signedImbalance).toBe(0);
  });
});


describe("final resolution inference", () => {
  it("records only decisive closed-market outcomes", () => {
    const result = inferFinalResolution({
      closed: true,
      outcomes: '["Yes","No"]',
      outcomePrices: '["1","0"]',
      clobTokenIds: '["yes-token","no-token"]'
    });
    expect(result?.winningOutcome).toBe("Yes");
    expect(result?.winningTokenId).toBe("yes-token");
  });

  it("rejects open or non-final price states", () => {
    expect(inferFinalResolution({
      closed: false,
      outcomes: '["Yes","No"]',
      outcomePrices: '["1","0"]'
    })).toBeNull();

    expect(inferFinalResolution({
      closed: true,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.98","0.02"]'
    })).toBeNull();
  });
});
