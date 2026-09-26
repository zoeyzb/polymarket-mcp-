import { describe, expect, it } from "vitest";
import { classifySportsMarketStructure } from "./sports-market-structure.js";
import { findSportsLineViolations } from "./sports-structural.js";
import type { GammaMarket, ScanCandidate } from "./types.js";

function market(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    question: "Chiefs vs. Colts",
    slug: "nfl-ind-kc-2026-09-21",
    active: true,
    closed: false,
    acceptingOrders: true,
    events: [{
      title: "Colts vs. Chiefs",
      gameId: 19484,
      score: "0-0",
      elapsed: "11:08",
      period: "Q1",
      live: true,
      ended: false,
      startTime: "2026-09-21T00:20:00Z"
    }],
    ...overrides
  };
}

function candidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return {
    id: "1",
    slug: "test",
    question: "test",
    conditionId: "c1",
    endDate: "2026-09-21T03:00:00Z",
    minutesRemaining: 60,
    acceptingOrders: true,
    liquidityUsd: 10000,
    volumeUsd: 100000,
    volume24hUsd: 20000,
    outcomes: ["Chiefs", "Colts"],
    tokenIds: ["a","b"],
    displayedOutcomePrices: [0.55,0.45],
    resolutionSource: null,
    resolutionRules: null,
    url: null,
    categories: ["sports"],
    primaryCategory: "sports",
    opportunityClass: "research_candidate",
    opportunityScore: 50,
    rapidReviewScore: 50,
    scoreBreakdown: {},
    flags: [],
    ...overrides
  };
}

describe("sports market structure", () => {
  it("uses official spread metadata and live scoreboard state", () => {
    const result = classifySportsMarketStructure(market({
      question: "Spread: Chiefs (-6.5)",
      sportsMarketType: "spreads",
      line: -6.5,
      groupItemTitle: "Spread -6.5"
    }));
    expect(result?.kind).toBe("spread");
    expect(result?.line).toBe(-6.5);
    expect(result?.subject).toBe("Chiefs");
    expect(result?.liveState?.score).toBe("0-0");
    expect(result?.liveState?.period).toBe("Q1");
    expect(result?.liveState?.live).toBe(true);
  });

  it("classifies moneyline", () => {
    const result = classifySportsMarketStructure(market({
      sportsMarketType: "moneyline"
    }));
    expect(result?.kind).toBe("moneyline");
  });

  it("classifies game totals", () => {
    const result = classifySportsMarketStructure(market({
      question: "Total Points: Over/Under 47.5",
      sportsMarketType: "totals",
      line: 47.5,
      outcomes: ["Over", "Under"]
    }));
    expect(result?.kind).toBe("game_total");
    expect(result?.line).toBe(47.5);
  });

  it("classifies O/U shorthand as a game total", () => {
    const result = classifySportsMarketStructure(market({
      question: "Granada CF vs. FC Andorra: O/U 6.5",
      sportsMarketType: ""
    }));
    expect(result?.kind).toBe("game_total");
    expect(result?.line).toBe(6.5);
  });

  it("classifies team-specific O/U shorthand as a team total", () => {
    const result = classifySportsMarketStructure(market({
      question: "Iceland vs. Estonia: Estonia O/U 2.5",
      sportsMarketType: "",
      events: [{ title: "Iceland vs. Estonia", gameId: 12345 }]
    }));
    expect(result?.kind).toBe("team_total");
    expect(result?.subject).toBe("Estonia");
    expect(result?.line).toBe(2.5);
  });

  it("classifies team-specific corners O/U as a team total even without matching event title", () => {
    const result = classifySportsMarketStructure(market({
      question: "England vs. Spain: Spain O/U 2.5 Corners",
      sportsMarketType: "",
      events: [{ title: "Women's international soccer", gameId: 12346 }]
    }));
    expect(result?.kind).toBe("team_total");
    expect(result?.subject).toBe("Spain");
    expect(result?.stat).toBe("corners");
    expect(result?.line).toBe(2.5);
  });

  it("classifies participant corners O/U without game metadata", () => {
    const result = classifySportsMarketStructure(market({
      question: "Slovakia vs. Moldova: Slovakia O/U 5.5 Corners",
      sportsMarketType: "",
      gameId: undefined,
      events: [{ title: "International markets" }]
    }));
    expect(result?.kind).toBe("team_total");
    expect(result?.subject).toBe("Slovakia");
    expect(result?.stat).toBe("corners");
    expect(result?.line).toBe(5.5);
  });

  it("does not let resolution boilerplate turn a dated moneyline into a score band", () => {
    const result = classifySportsMarketStructure(market({
      question: "Will CA Acassuso win on 2026-09-27?",
      sportsMarketType: "",
      gameId: undefined,
      description: "This market resolves based on the final score of the match.",
      events: [{ title: "CA Acassuso vs. Sacachispas" }]
    }));
    expect(result?.kind).toBe("moneyline");
  });

  it("classifies leading at halftime as a first-half moneyline", () => {
    const result = classifySportsMarketStructure(market({
      question: "Vitesse Arnhem leading at halftime?",
      sportsMarketType: ""
    }));
    expect(result?.kind).toBe("period_moneyline");
    expect(result?.scope).toBe("first_half");
  });

  it("classifies score bands like 4-7", () => {
    const result = classifySportsMarketStructure(market({
      question: "Total goals 4-7"
    }));
    expect(result?.kind).toBe("score_band");
    expect(result?.rangeMin).toBe(4);
    expect(result?.rangeMax).toBe(7);
  });

  it("classifies 8+ threshold bands", () => {
    const result = classifySportsMarketStructure(market({
      question: "Total goals 8+"
    }));
    expect(result?.kind).toBe("score_band");
    expect(result?.rangeMin).toBe(8);
    expect(result?.rangeMax).toBeNull();
  });
});

describe("sports line monotonicity", () => {
  it("flags a harder spread priced more likely than an easier spread", () => {
    const easier = candidate({
      conditionId: "easy",
      question: "Spread: Chiefs (-4.5)",
      sportsStructure: {
        kind: "spread",
        scope: "full_game",
        sport: "NFL",
        rawSportsMarketType: "spreads",
        eventTitle: "Colts vs. Chiefs",
        subject: "Chiefs",
        stat: null,
        line: -4.5,
        thresholdComparator: null,
        rangeMin: null,
        rangeMax: null,
        exactValue: null,
        liveState: null,
        flags: []
      },
      displayedOutcomePrices: [0.45,0.55]
    });
    const harder = candidate({
      conditionId: "hard",
      question: "Spread: Chiefs (-6.5)",
      sportsStructure: {
        ...easier.sportsStructure!,
        line: -6.5
      },
      displayedOutcomePrices: [0.60,0.40]
    });

    const violations = findSportsLineViolations([easier, harder]);
    expect(violations.some(v => v.type === "spread_monotonicity")).toBe(true);
  });

  it("flags Over 48.5 priced above Over 47.5", () => {
    const baseStructure = {
      kind: "game_total" as const,
      scope: "full_game" as const,
      sport: "NFL",
      rawSportsMarketType: "totals",
      eventTitle: "Colts vs. Chiefs",
      subject: null,
      stat: "points",
      thresholdComparator: "over" as const,
      rangeMin: null,
      rangeMax: null,
      exactValue: null,
      liveState: null,
      flags: []
    };
    const easier = candidate({
      conditionId: "o475",
      question: "Total Points: Over/Under 47.5",
      outcomes: ["Over","Under"],
      displayedOutcomePrices: [0.45,0.55],
      sportsStructure: { ...baseStructure, line: 47.5 }
    });
    const harder = candidate({
      conditionId: "o485",
      question: "Total Points: Over/Under 48.5",
      outcomes: ["Over","Under"],
      displayedOutcomePrices: [0.60,0.40],
      sportsStructure: { ...baseStructure, line: 48.5 }
    });

    const violations = findSportsLineViolations([easier, harder]);
    expect(violations.some(v =>
      v.type === "total_monotonicity" && v.side === "over"
    )).toBe(true);
  });
});
