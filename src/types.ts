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
  negRisk?: boolean;
  enableNegRisk?: boolean;
  negRiskAugmented?: boolean;
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
  tick_size?: string | number;
  min_order_size?: string | number;
  neg_risk?: boolean;
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

export interface CompleteSetExecution {
  budgetUsd: number;
  bufferBps: number;
  fillComplete: boolean;
  sharesEach: number;
  totalCostUsd: number;
  guaranteedPayoutUsd: number;
  grossProfit: number;
  grossRoiPct: number | null;
  bufferCostUsd: number;
  netProfitAfterBuffer: number;
  netRoiPct: number | null;
}

export type OpportunityClass =
  | "executable_structural"
  | "top_book_structural_only"
  | "research_candidate";

export interface ScanCandidate {
  id: string | null;
  slug: string | null;
  question: string;
  conditionId: string | null;
  endDate: string;
  minutesRemaining: number;
  marketWindowMinutes?: number | null;
  isFiveMinuteMarket?: boolean;
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
    executable: CompleteSetExecution[];
    bestExecutableBudgetUsd: number | null;
    bestNetProfitUsd: number;
    bestNetRoiPct: number | null;
    note: string;
  } | null;
  categories: import("./category-taxonomy.js").MarketCategory[];
  primaryCategory: import("./category-taxonomy.js").MarketCategory;
  sportsStructure?: import("./sports-market-structure.js").SportsMarketStructure | null;
  opportunityClass: OpportunityClass;
  opportunityScore: number;
  attentionScore?: number;
  discoveryScore?: number;
  marketSignals?: {
    priceRegime: import("./intelligence.js").PriceRegimeAnalysis | null;
    tradeFlow: import("./intelligence.js").TradeFlowAnalysis | null;
  };
  externalEvidence?: import("./external-evidence.js").ExternalCryptoEvidence | null;
  historicalEvidence?: {
    observations: number;
    executableObservations: number;
    avgOpportunityScore: number | null;
    maxOpportunityScore: number | null;
    avgAttentionScore: number | null;
    firstSeen: string | null;
    lastSeen: string | null;
    persistenceBoost: number;
  };
  makerEdge?: import("./maker-edge.js").MakerEdgeEstimate | null;
  resolutionIntelligence?: import("./resolution-intelligence.js").ResolutionIntelligence | null;
  crossVenue?: import("./cross-venue.js").CrossVenueMatch[];
  logicalRelations?: import("./structural-graph.js").StructuralGraphViolation[];
  smartMoney?: {
    signals: Array<Record<string, unknown>>;
    uniqueWallets: number;
    highScoreWallets: number;
    totalNotionalUsd: number;
    weightedSmartMoneyScore: number;
    yesDirectionalBias: number | null;
    dominantSide: "YES" | "NO" | "MIXED" | null;
    yesWeightedFlow: number;
    noWeightedFlow: number;
    flags: string[];
  } | null;
  opportunityPacketScore?: number;
  rapidReviewScore: number;
  scoreBreakdown: Record<string, number>;
  flags: string[];
}

export interface EventBasketOpportunity {
  eventId: string;
  eventTitle: string | null;
  marketCount: number;
  marketIds: string[];
  outcomeQuestions: string[];
  yesTokenIds: string[];
  executable: import("./intelligence.js").BasketExecution[];
  bestNetProfitUsd: number;
  bestNetRoiPct: number | null;
  bestBudgetUsd: number | null;
  flags: string[];
}

export interface ScanResult {
  generatedAt: string;
  maxMinutes: number;
  totalActiveMarketsScanned: number;
  totalInWindowBeforeFilters: number;
  returned: number;
  scanDurationMs?: number;
  candidates: ScanCandidate[];
  eventBaskets?: EventBasketOpportunity[];
}


export interface MultiHorizonLane {
  key: "urgent_2h" | "developing_6h" | "broader_24h";
  maxMinutes: number;
  totalInWindow: number;
  returned: number;
  categoryCounts: Record<string, number>;
  candidates: ScanCandidate[];
}

export interface StructuralUniverseResult {
  binary: ScanCandidate[];
  eventBaskets: EventBasketOpportunity[];
  categoryCounts: Record<string, number>;
  executableCount: number;
  topBookOnlyCount: number;
}

export interface MultiHorizonScanResult {
  generatedAt: string;
  totalActiveMarketsScanned: number;
  eligibleMarketsScanned?: number;
  retainedCandidateCount?: number;
  scanDurationMs: number;
  bufferBps: number;
  lanes: {
    urgent2h: MultiHorizonLane;
    developing6h: MultiHorizonLane;
    broader24h: MultiHorizonLane;
  };
  structuralUniverse: StructuralUniverseResult;
  logicalViolations: import("./structural-graph.js").StructuralGraphViolation[];
}
