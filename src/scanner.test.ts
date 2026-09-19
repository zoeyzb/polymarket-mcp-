import { describe, expect, it } from "vitest";
import { parseNumberArray, parseStringArray } from "./polymarket.js";

describe("Gamma parsing", () => {
  it("parses JSON encoded string arrays", () => {
    expect(parseStringArray('["Yes","No"]')).toEqual(["Yes", "No"]);
  });

  it("parses numeric outcome prices", () => {
    expect(parseNumberArray('["0.42","0.58"]')).toEqual([0.42, 0.58]);
  });
});
