import { describe, expect, it } from "vitest";
import { classifyResearchConfidenceBand } from "./research-confidence.js";

describe("classifyResearchConfidenceBand", () => {
  it("separates conservative, high and exploratory price bands", () => {
    expect(classifyResearchConfidenceBand(0.94)).toBe("ultra_high");
    expect(classifyResearchConfidenceBand(0.86)).toBe("high");
    expect(classifyResearchConfidenceBand(0.72)).toBe("exploratory");
  });

  it("rejects prices outside the research range", () => {
    expect(classifyResearchConfidenceBand(0.59)).toBeNull();
    expect(classifyResearchConfidenceBand(0.995)).toBeNull();
  });
});
