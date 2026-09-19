import { parseNumberArray, parseStringArray } from "./polymarket.js";
import type { GammaMarket } from "./types.js";

export interface FinalResolution {
  winningOutcome: string;
  winningTokenId: string | null;
  winningIndex: number;
  finalPrices: number[];
}

export function inferFinalResolution(market: GammaMarket): FinalResolution | null {
  if (market.closed !== true) return null;

  const outcomes = parseStringArray(market.outcomes);
  const prices = parseNumberArray(market.outcomePrices);
  const tokenIds = parseStringArray(market.clobTokenIds);

  if (outcomes.length < 2 || prices.length !== outcomes.length) return null;

  let winningIndex = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[winningIndex]) winningIndex = i;
  }

  const winner = prices[winningIndex];
  const losers = prices.filter((_, i) => i !== winningIndex);
  const decisive =
    winner >= 0.999 &&
    losers.every(price => price <= 0.001) &&
    Math.abs(prices.reduce((sum, price) => sum + price, 0) - 1) <= 0.01;

  if (!decisive) return null;

  return {
    winningOutcome: outcomes[winningIndex],
    winningTokenId: tokenIds[winningIndex] ?? null,
    winningIndex,
    finalPrices: prices
  };
}
