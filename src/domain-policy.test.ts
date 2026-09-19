import { describe, expect, it } from "vitest";
import { isPoliticalMarket, POLITICAL_DIRECTIONAL_FLAGS } from "./domain-policy.js";
import { classifyHistoricalDomain } from "./historical-calibration.js";
import { auditScanResult } from "./audit.js";
import type { GammaMarket, ScanCandidate, ScanResult } from "./types.js";

describe("political structural-only policy", () => {
  it("classifies election markets as political", () => {
    const market: GammaMarket = {
      question: "Will United Russia win between 310 and 324 seats in the next Russian State Duma election?",
      slug: "united-russia-state-duma-election"
    };
    expect(isPoliticalMarket(market)).toBe(true);
  });

  it("does not classify an ordinary sports market as political", () => {
    const market: GammaMarket = {
      question: "Map 2 Total Rounds: Over/Under 33.5",
      slug: "cs2-map-2-total-rounds"
    };
    expect(isPoliticalMarket(market)).toBe(false);
  });

  it("keeps the directional political flag denylist explicit", () => {
    expect(POLITICAL_DIRECTIONAL_FLAGS.has("strong_recent_trade_imbalance")).toBe(true);
    expect(POLITICAL_DIRECTIONAL_FLAGS.has("large_recent_trade")).toBe(true);
    expect(POLITICAL_DIRECTIONAL_FLAGS.has("price_shock")).toBe(true);
  });

  it("audit rejects directional boosts on political candidates", () => {
    const candidate: ScanCandidate = {
      id: "1",
      slug: "election-market",
      question: "Will Party A win the most seats in the election?",
      conditionId: "0x1",
      endDate: new Date(Date.now() + 60_000).toISOString(),
      minutesRemaining: 1,
      acceptingOrders: true,
      liquidityUsd: 1000,
      volumeUsd: 1000,
      volume24hUsd: 100,
      outcomes: ["Yes", "No"],
      tokenIds: ["yes", "no"],
      displayedOutcomePrices: [0.5, 0.5],
      resolutionSource: null,
      resolutionRules: "Election result.",
      url: null,
      binaryArbitrage: null,
      categories: ["elections", "politics"],
      primaryCategory: "elections",
      opportunityClass: "research_candidate",
      opportunityScore: 40,
      attentionScore: 55,
      discoveryScore: 55,
      rapidReviewScore: 60,
      scoreBreakdown: {},
      flags: ["political_structural_only", "strong_recent_trade_imbalance"]
    };

    const scan: ScanResult = {
      generatedAt: new Date().toISOString(),
      maxMinutes: 120,
      totalActiveMarketsScanned: 1,
      totalInWindowBeforeFilters: 1,
      returned: 1,
      candidates: [candidate],
      eventBaskets: []
    };

    const finding = auditScanResult(scan).find(x => x.id === "political_structural_only_integrity");
    expect(finding?.ok).toBe(false);
  });
});

describe("NegRisk basket audit", () => {
  const baseScan = (): ScanResult => ({
    generatedAt: new Date().toISOString(),
    maxMinutes: 120,
    totalActiveMarketsScanned: 3,
    totalInWindowBeforeFilters: 3,
    returned: 0,
    candidates: [],
    eventBaskets: []
  });

  it("rejects automatic NegRisk baskets without authoritative child-set verification", () => {
    const scan = baseScan();
    scan.eventBaskets = [{
      eventId: "event-1",
      eventTitle: "Who wins?",
      marketCount: 3,
      marketIds: ["1", "2", "3"],
      outcomeQuestions: ["A", "B", "Other"],
      yesTokenIds: ["a", "b", "c"],
      executable: [],
      bestNetProfitUsd: 0,
      bestNetRoiPct: null,
      bestBudgetUsd: null,
      flags: ["neg_risk_complete_outcome_set"]
    }];

    const finding = auditScanResult(scan).find(x => x.id === "negrisk_child_set_verification");
    expect(finding?.ok).toBe(false);
  });

  it("accepts Gamma-verified NegRisk child sets", () => {
    const scan = baseScan();
    scan.eventBaskets = [{
      eventId: "event-1",
      eventTitle: "Who wins?",
      marketCount: 3,
      marketIds: ["1", "2", "3"],
      outcomeQuestions: ["A", "B", "Other"],
      yesTokenIds: ["a", "b", "c"],
      executable: [],
      bestNetProfitUsd: 0,
      bestNetRoiPct: null,
      bestBudgetUsd: null,
      flags: ["neg_risk_complete_outcome_set", "gamma_event_child_set_verified"]
    }];

    const finding = auditScanResult(scan).find(x => x.id === "negrisk_child_set_verification");
    expect(finding?.ok).toBe(true);
  });
});

describe("historical calibration domain classification", () => {
  it("classifies sports markets", () => {
    expect(classifyHistoricalDomain({
      question: "Map 2 Total Rounds: Over/Under 30.5",
      sportsMarketType: "round_over_under_game_2"
    })).toBe("sports");
  });

  it("classifies crypto markets", () => {
    expect(classifyHistoricalDomain({
      question: "Will Bitcoin be above $100,000?"
    })).toBe("crypto");
  });

  it("classifies weather markets", () => {
    expect(classifyHistoricalDomain({
      question: "Will New York receive more than 2 inches of snow?"
    })).toBe("weather");
  });

  it("does not admit political markets into historical calibration", () => {
    expect(classifyHistoricalDomain({
      question: "Will Party A win the election?"
    })).toBeNull();
  });
});
