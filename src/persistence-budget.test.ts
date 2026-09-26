import { describe, expect, it } from "vitest";
import { boundRealtimeQuotesForPersistence } from "./persistence.js";
import type { RealtimeQuote } from "./realtime.js";

function quote(tokenId: string, updatedAt: string): RealtimeQuote {
  return {
    tokenId,
    bestBid: 0.4,
    bestAsk: 0.6,
    spread: 0.2,
    lastTradePrice: null,
    lastTradeSide: null,
    eventType: "book",
    updatedAt
  };
}

describe("realtime persistence budget", () => {
  it("hard caps each persistence cycle at 400 unique tokens", () => {
    const quotes = Array.from({ length: 550 }, (_, i) =>
      quote(`token-${i}`, new Date(Date.UTC(2026, 8, 26, 3, 0, i)).toISOString())
    );

    const bounded = boundRealtimeQuotesForPersistence(quotes, 400);

    expect(bounded).toHaveLength(400);
    expect(new Set(bounded.map(item => item.tokenId)).size).toBe(400);
  });

  it("keeps the freshest quote when the same token appears more than once", () => {
    const bounded = boundRealtimeQuotesForPersistence([
      quote("same", "2026-09-26T03:00:00.000Z"),
      quote("other", "2026-09-26T03:01:00.000Z"),
      quote("same", "2026-09-26T03:02:00.000Z")
    ], 400);

    expect(bounded).toHaveLength(2);
    expect(bounded.find(item => item.tokenId === "same")?.updatedAt)
      .toBe("2026-09-26T03:02:00.000Z");
  });

  it("never allows a caller to raise the hard ceiling above 400", () => {
    const quotes = Array.from({ length: 500 }, (_, i) =>
      quote(`token-${i}`, new Date(Date.UTC(2026, 8, 26, 4, 0, i)).toISOString())
    );

    expect(boundRealtimeQuotesForPersistence(quotes, 2000)).toHaveLength(400);
  });
});
