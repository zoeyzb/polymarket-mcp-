import { describe, expect, it } from "vitest";
import { renderDashboardHtml } from "./dashboard.js";

describe("dashboard", () => {
  it("contains live opportunities, replay, wallet, and GPT surfaces", () => {
    const html = renderDashboardHtml();
    expect(html).toContain("Live Opportunities");
    expect(html).toContain("Historical Replay");
    expect(html).toContain("Connect Wallet");
    expect(html).toContain("Ask GPT");
    expect(html).toContain("Control token");
    expect(html).not.toContain("OPENAI_API_KEY");
  });
});
