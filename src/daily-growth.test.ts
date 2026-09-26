import { describe, expect, it } from "vitest";
import { scoreDailyGrowthPolicy } from "./backtest.js";

describe("daily growth policy scoring", () => {
  it("rewards consistent median daily growth over slightly higher aggregate roi", () => {
    const consistent=scoreDailyGrowthPolicy({
      minRoiPct:4,avgRoiPct:6,totalTrades:200,
      profitableDayPct:96,medianDailyPnlPerDollar:0.08,avgDailyPnlPerDollar:0.09,
      worstDayPnlPerDollar:-0.05,maxDrawdownPerDollar:0.08,peakConcurrentTrades:3
    });
    const lumpy=scoreDailyGrowthPolicy({
      minRoiPct:5,avgRoiPct:8,totalTrades:200,
      profitableDayPct:80,medianDailyPnlPerDollar:0.02,avgDailyPnlPerDollar:0.12,
      worstDayPnlPerDollar:-0.4,maxDrawdownPerDollar:0.5,peakConcurrentTrades:8
    });
    expect(consistent.score).toBeGreaterThan(lumpy.score);
  });

  it("penalizes losing-day concentration and drawdown", () => {
    const safe=scoreDailyGrowthPolicy({
      minRoiPct:5,avgRoiPct:7,totalTrades:150,
      profitableDayPct:95,medianDailyPnlPerDollar:0.06,avgDailyPnlPerDollar:0.07,
      worstDayPnlPerDollar:-0.05,maxDrawdownPerDollar:0.1,peakConcurrentTrades:2
    });
    const risky=scoreDailyGrowthPolicy({
      minRoiPct:5,avgRoiPct:7,totalTrades:150,
      profitableDayPct:70,medianDailyPnlPerDollar:0.06,avgDailyPnlPerDollar:0.07,
      worstDayPnlPerDollar:-0.5,maxDrawdownPerDollar:0.8,peakConcurrentTrades:10
    });
    expect(safe.score).toBeGreaterThan(risky.score);
    expect(risky.components.riskPenalty).toBeGreaterThan(safe.components.riskPenalty);
  });
});
