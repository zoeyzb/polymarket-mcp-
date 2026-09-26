import { describe, expect, it } from "vitest";
import { classifyMarketFamily } from "./market-family.js";

describe("classifyMarketFamily", () => {
  it("separates sports totals, spreads, player props and thresholds", () => {
    expect(classifyMarketFamily({domain:"sports",question:"Will the game have over 3.5 goals?",outcomeCount:2,sportsKind:"game_total"})).toBe("sports_total");
    expect(classifyMarketFamily({domain:"sports",question:"Lakers -3.5",outcomeCount:2,sportsKind:"spread"})).toBe("sports_spread");
    expect(classifyMarketFamily({domain:"sports",question:"LeBron James 30+ points",outcomeCount:2,sportsKind:"player_prop"})).toBe("sports_player_prop");
    expect(classifyMarketFamily({domain:"sports",question:"Will Team A score at least 3 goals?",outcomeCount:2,sportsKind:"threshold"})).toBe("sports_threshold");
  });

  it("infers sports families from historical text when official sports type is unavailable", () => {
    expect(classifyMarketFamily({domain:"sports",question:"Will the game have over 3.5 goals?",outcomeCount:2})).toBe("sports_total");
    expect(classifyMarketFamily({domain:"sports",question:"LeBron James over 30 points",outcomeCount:2})).toBe("sports_player_prop");
    expect(classifyMarketFamily({domain:"sports",question:"Will Team A score 3+ goals?",outcomeCount:2})).toBe("sports_threshold");
  });

  it("keeps multi-outcome sports score markets in a sports family", () => {
    expect(classifyMarketFamily({
      domain:"sports",
      question:"Correct score",
      outcomeCount:8,
      sportsKind:"exact_score"
    })).toBe("sports_score_band");
    expect(classifyMarketFamily({
      domain:"sports",
      question:"Goals score band",
      outcomeCount:5,
      sportsKind:"score_band"
    })).toBe("sports_score_band");
  });

  it("keeps multi-outcome sports props distinct when official structure identifies them", () => {
    expect(classifyMarketFamily({
      domain:"sports",
      question:"LeBron James points",
      outcomeCount:4,
      sportsKind:"player_prop"
    })).toBe("sports_player_prop");
  });

  it("does not mistake ISO dates in moneyline questions for score bands", () => {
    expect(classifyMarketFamily({
      domain:"sports",
      question:"Will Vitesse Arnhem win on 2026-09-26?",
      outcomeCount:2
    })).toBe("sports_moneyline");
  });

  it("still recognizes semantic numeric score bands", () => {
    expect(classifyMarketFamily({
      domain:"sports",
      question:"Will total goals be 2-3?",
      outcomeCount:2
    })).toBe("sports_score_band");
  });

  it("recognizes non-sports threshold markets", () => {
    expect(classifyMarketFamily({domain:"crypto",question:"Will Bitcoin be above $100,000?",outcomeCount:2})).toBe("crypto_threshold");
    expect(classifyMarketFamily({domain:"weather",question:"Will temperature exceed 90 degrees?",outcomeCount:2})).toBe("weather_threshold");
  });

  it("keeps arbitrary multi-outcome non-sports markets separate from binary calibration", () => {
    expect(classifyMarketFamily({domain:"other",question:"Who will win?",outcomeCount:5})).toBe("multi_outcome");
  });
});
