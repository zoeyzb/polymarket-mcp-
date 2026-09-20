import { describe, expect, it } from "vitest";
import { estimateMakerEdge } from "./maker-edge.js";
import { priceCashOrNothingDigital } from "./digital-fair-value.js";
import { analyzeResolutionRules } from "./resolution-intelligence.js";
import { findStructuralGraphViolations } from "./structural-graph.js";
import { matchCandidateToKalshi, type KalshiMarket } from "./cross-venue.js";
import { scoreWalletProfile } from "./wallet-intelligence.js";
import type { NormalizedBook, ScanCandidate } from "./types.js";

function book(
  tokenId: string,
  bid: number,
  ask: number,
  midpoint = (bid + ask) / 2
): NormalizedBook {
  return {
    tokenId,
    bestBid: bid,
    bestAsk: ask,
    spread: ask - bid,
    midpoint,
    bidDepthUsdTop5: 10_000,
    askDepthUsdTop5: 10_000,
    raw: { asset_id: tokenId, bids: [], asks: [] }
  };
}

function candidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  const endDate = new Date(Date.now() + 24 * 3600_000).toISOString();
  return {
    id: "1",
    slug: "btc-above-100k",
    question: "Will Bitcoin be above $100,000 by December 31, 2026?",
    conditionId: "0xabc",
    endDate,
    minutesRemaining: 1440,
    acceptingOrders: true,
    liquidityUsd: 20_000,
    volumeUsd: 100_000,
    volume24hUsd: 25_000,
    outcomes: ["Yes", "No"],
    tokenIds: ["yes", "no"],
    displayedOutcomePrices: [0.5, 0.5],
    resolutionSource: "Coinbase",
    resolutionRules: "Resolves Yes if Bitcoin is above $100,000 according to Coinbase by December 31, 2026.",
    url: null,
    books: [
      {
        outcome: "Yes",
        tokenId: "yes",
        bestBid: 0.48,
        bestAsk: 0.50,
        spread: 0.02,
        midpoint: 0.49,
        bidDepthUsdTop5: 10_000,
        askDepthUsdTop5: 10_000,
        executions: []
      },
      {
        outcome: "No",
        tokenId: "no",
        bestBid: 0.50,
        bestAsk: 0.52,
        spread: 0.02,
        midpoint: 0.51,
        bidDepthUsdTop5: 10_000,
        askDepthUsdTop5: 10_000,
        executions: []
      }
    ],
    binaryArbitrage: null,
    categories: ["crypto"],
    primaryCategory: "crypto",
    opportunityClass: "research_candidate",
    opportunityScore: 50,
    rapidReviewScore: 50,
    scoreBreakdown: {},
    flags: [],
    ...overrides
  };
}

describe("maker economics", () => {
  it("respects explicit feesEnabled=false even in a normally fee-enabled category", () => {
    const result = estimateMakerEdge(
      { question: "BTC test", feesEnabled: false },
      "crypto",
      book("yes", 0.48, 0.52)
    );
    expect(result.feeEnabled).toBe(false);
    expect(result.feeRate).toBe(0);
    expect(result.indicativeRebatePoolContributionPer100Shares).toBe(0);
  });

  it("models fee-equivalent without claiming guaranteed rebate", () => {
    const result = estimateMakerEdge(
      { question: "BTC test", feesEnabled: true },
      "crypto",
      book("yes", 0.49, 0.51)
    );
    expect(result.feeEnabled).toBe(true);
    expect(result.feeEquivalentPer100Shares).toBeGreaterThan(0);
    expect(result.note.toLowerCase()).toContain("not");
  });
});

describe("digital option comparator", () => {
  it("returns the Black-Scholes cash-or-nothing risk-neutral probability", () => {
    const result = priceCashOrNothingDigital({
      spot: 100,
      strike: 100,
      volatility: 0.2,
      timeYears: 1,
      riskFreeRate: 0,
      dividendYield: 0,
      direction: "above"
    });
    expect(result.riskNeutralProbability).toBeCloseTo(0.46017, 4);
    expect(result.note).toContain("risk-neutral");
  });
});

describe("resolution intelligence", () => {
  it("extracts explicit sources and threshold semantics", () => {
    const result = analyzeResolutionRules(candidate());
    expect(result.sourceMentions.join(" ").toLowerCase()).toContain("coinbase");
    expect(result.thresholdMentions.length).toBeGreaterThan(0);
    expect(result.comparator).toBe(">");
  });
});

describe("structural graph", () => {
  it("finds impossible same-expiry threshold ordering", () => {
    const easier = candidate({
      conditionId: "easy",
      question: "Will Bitcoin be above $90,000 by December 31, 2026?",
      displayedOutcomePrices: [0.4, 0.6],
      books: [
        { ...candidate().books![0], midpoint: 0.4 },
        { ...candidate().books![1], midpoint: 0.6 }
      ]
    });
    const harder = candidate({
      conditionId: "hard",
      question: "Will Bitcoin be above $100,000 by December 31, 2026?",
      displayedOutcomePrices: [0.6, 0.4],
      books: [
        { ...candidate().books![0], midpoint: 0.6 },
        { ...candidate().books![1], midpoint: 0.4 }
      ],
      endDate: easier.endDate
    });

    const violations = findStructuralGraphViolations([easier, harder]);
    expect(violations.some(v => v.type === "threshold_monotonicity")).toBe(true);
  });

  it("excludes political candidates from directional logical graph analysis", () => {
    const political = candidate({
      question: "Will Candidate A receive above 50% of the vote?",
      categories: ["elections", "politics"],
      primaryCategory: "elections",
      flags: ["political_structural_only"]
    });
    expect(findStructuralGraphViolations([political])).toEqual([]);
  });
});

describe("cross-venue matching", () => {
  it("requires strong semantic/resolution matching before arb classification", () => {
    const c = candidate();
    const kalshi: KalshiMarket[] = [{
      ticker: "KXBTC-100K",
      title: "Will Bitcoin be above $100,000 by December 31, 2026?",
      yes_ask_dollars: "0.40",
      no_ask_dollars: "0.60",
      expected_expiration_time: c.endDate,
      rules_primary: "Resolves Yes if Bitcoin is above $100,000 according to Coinbase by December 31, 2026."
    }];

    const matches = matchCandidateToKalshi(c, kalshi, 3);
    expect(matches.length).toBe(1);
    expect(matches[0].numericMatch).toBe(1);
    expect(matches[0].resolutionMatchScore).toBeGreaterThan(0.7);
  });

  it("does not call a weak title match arbitrage", () => {
    const matches = matchCandidateToKalshi(candidate(), [{
      ticker: "UNRELATED",
      title: "Will the Lakers win tonight?",
      yes_ask_dollars: "0.10",
      no_ask_dollars: "0.10"
    }], 3);
    expect(matches.find(match => match.classification === "cross_venue_arb_candidate")).toBeUndefined();
  });
});

describe("wallet intelligence", () => {
  it("uses actual distinct resolved conditions for sample confidence", () => {
    const profile = scoreWalletProfile({
      leaderboard: {
        user_id: "0x1111111111111111111111111111111111111111",
        rank: 10,
        pnl: 100_000,
        volume: 1_000_000,
        user_name: "tester"
      },
      stats: {
        proxy_wallet: "0x1111111111111111111111111111111111111111",
        trades: 500,
        biggest_win: 25_000,
        all_time_pnl: {
          trade_count: 500,
          economic_pnl: 100_000,
          realized_market_pnl: 80_000,
          maker_rebate: 1_000,
          taker_rebate: 100,
          reward_income: 200,
          volume_usdc: 1_000_000
        }
      },
      closedPositions: [
        { condition_id: "a", title: "Team A vs Team B", slug: "nba-a-b", realized_pnl: 1000 },
        { condition_id: "a", title: "Team A vs Team B", slug: "nba-a-b", realized_pnl: 500 },
        { condition_id: "b", title: "Bitcoin above $100k", slug: "btc-100k", realized_pnl: -200 }
      ],
      recentTrades: []
    });

    expect(profile.distinctMarkets).toBe(2);
    expect(profile.smartScore).toBeGreaterThan(0);
    expect(profile.flags).toContain("maker_rebate_heavy");
  });
});
