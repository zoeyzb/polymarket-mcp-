export interface GammaMarket {
  id?: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  description?: string;
  resolutionSource?: string;
  endDate?: string;
  endDateIso?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  liquidity?: string | number;
  liquidityNum?: number;
  volume?: string | number;
  volumeNum?: number;
  volume24hr?: number;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  events?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OrderLevel {
  price: string | number;
  size: string | number;
}

export interface OrderBook {
  market?: string;
  asset_id?: string;
  bids?: OrderLevel[];
  asks?: OrderLevel[];
  [key: string]: unknown;
}

export interface NormalizedBook {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midpoint: number | null;
  bidDepthUsdTop5: number;
  askDepthUsdTop5: number;
  raw: OrderBook;
}

export interface ExecutionEstimate {
  budgetUsd: number;
  spendableUsd: number;
  avgFillPrice: number | null;
  shares: number;
  maxPayoutIfWinning: number;
  profitIfWinning: number;
  roiIfWinningPct: number | null;
  fillPct: number;
}

export interface ScanCandidate {
  id: string | null;
  slug: string | null;
  question: string;
  conditionId: string | null;
  endDate: string;
  minutesRemaining: number;
  acceptingOrders: boolean;
  liquidityUsd: number;
  volumeUsd: number;
  volume24hUsd: number;
  outcomes: string[];
  tokenIds: string[];
  displayedOutcomePrices: number[];
  resolutionSource: string | null;
  resolutionRules: string | null;
  url: string | null;
  books?: Array<{
    outcome: string;
    tokenId: string;
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
    midpoint: number | null;
    bidDepthUsdTop5: number;
    askDepthUsdTop5: number;
    executions: ExecutionEstimate[];
  }>;
  binaryArbitrage?: {
    buyBothAskTotal: number;
    grossEdgePerDollar: number;
    grossEdgePct: number;
    note: string;
  } | null;
  rapidReviewScore: number;
  scoreBreakdown: Record<string, number>;
  flags: string[];
}

export interface ScanResult {
  generatedAt: string;
  maxMinutes: number;
  totalActiveMarketsScanned: number;
  totalInWindowBeforeFilters: number;
  returned: number;
  candidates: ScanCandidate[];
}
