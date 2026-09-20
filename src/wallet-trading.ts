import { getOrderBook, getUserPositionsV2, getUserStatsV2 } from "./polymarket.js";

export type TradeSide = "BUY" | "SELL";
export type TradeOrderType = "LIMIT" | "MARKET";

export interface WalletProfile {
  id: string;
  walletAddress: string | null;
  funderAddress: string | null;
  proxyWallet: string | null;
  signatureType: number | null;
  walletType: string | null;
  chainId: number;
  enabled: boolean;
  configured: boolean;
  metadata?: Record<string, unknown>;
}

export interface TradePreviewInput {
  tokenId: string;
  side: TradeSide;
  orderType: TradeOrderType;
  price?: number;
  size?: number;
  amountUsdc?: number;
  maxSlippageBps?: number;
}

export interface TradePreview {
  tokenId: string;
  side: TradeSide;
  orderType: TradeOrderType;
  requestedPrice: number | null;
  requestedSize: number | null;
  requestedAmountUsdc: number | null;
  maxSlippageBps: number;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  estimatedShares: number | null;
  estimatedCostUsdc: number | null;
  estimatedProceedsUsdc: number | null;
  estimatedVwap: number | null;
  worstFillPrice: number | null;
  availableWithinSlippage: boolean;
  checks: Array<{
    id: string;
    ok: boolean;
    severity: "critical" | "warning" | "info";
    detail: string;
  }>;
  signingRequired: true;
  submissionEnabled: boolean;
  note: string;
}

function round(value: number, digits = 6) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function parseLevels(
  levels: Array<{ price?: string | number; size?: string | number }> | undefined,
  direction: "asc" | "desc"
) {
  const parsed = (levels || [])
    .map(level => ({
      price: Number(level.price),
      size: Number(level.size)
    }))
    .filter(level =>
      Number.isFinite(level.price) &&
      level.price > 0 &&
      level.price <= 1 &&
      Number.isFinite(level.size) &&
      level.size > 0
    );

  parsed.sort((a, b) =>
    direction === "asc" ? a.price - b.price : b.price - a.price
  );
  return parsed;
}

function walkBuyByBudget(
  asks: Array<{ price: number; size: number }>,
  budget: number,
  maxPrice: number
) {
  let remaining = budget;
  let shares = 0;
  let cost = 0;
  let worstPrice: number | null = null;

  for (const level of asks) {
    if (level.price > maxPrice) break;
    const maxCost = level.price * level.size;
    const levelCost = Math.min(remaining, maxCost);
    const levelShares = levelCost / level.price;
    cost += levelCost;
    shares += levelShares;
    remaining -= levelCost;
    if (levelShares > 0) worstPrice = level.price;
    if (remaining <= 1e-9) break;
  }

  return {
    filled: remaining <= Math.max(1e-6, budget * 1e-6),
    shares,
    cost,
    vwap: shares > 0 ? cost / shares : null,
    worstPrice
  };
}

function walkSellByShares(
  bids: Array<{ price: number; size: number }>,
  requestedShares: number,
  minPrice: number
) {
  let remaining = requestedShares;
  let shares = 0;
  let proceeds = 0;
  let worstPrice: number | null = null;

  for (const level of bids) {
    if (level.price < minPrice) break;
    const levelShares = Math.min(remaining, level.size);
    shares += levelShares;
    proceeds += levelShares * level.price;
    remaining -= levelShares;
    if (levelShares > 0) worstPrice = level.price;
    if (remaining <= 1e-9) break;
  }

  return {
    filled: remaining <= Math.max(1e-6, requestedShares * 1e-6),
    shares,
    proceeds,
    vwap: shares > 0 ? proceeds / shares : null,
    worstPrice
  };
}

export function tradingSubmissionEnabled() {
  return String(process.env.TRADING_ENABLED || "false").toLowerCase() === "true";
}

export async function previewTrade(input: TradePreviewInput): Promise<TradePreview> {
  const maxSlippageBps = Math.max(0, Math.min(5000, input.maxSlippageBps ?? 100));
  const book = await getOrderBook(input.tokenId);
  const asks = parseLevels(book.raw.asks, "asc");
  const bids = parseLevels(book.raw.bids, "desc");

  const checks: TradePreview["checks"] = [];
  let estimatedShares: number | null = null;
  let estimatedCostUsdc: number | null = null;
  let estimatedProceedsUsdc: number | null = null;
  let estimatedVwap: number | null = null;
  let worstFillPrice: number | null = null;
  let availableWithinSlippage = false;

  if (input.orderType === "LIMIT") {
    const price = Number(input.price);
    const size = Number(input.size);
    const validPrice = Number.isFinite(price) && price > 0 && price < 1;
    const validSize = Number.isFinite(size) && size > 0;

    checks.push({
      id: "valid_limit_price",
      ok: validPrice,
      severity: "critical",
      detail: validPrice ? `price=${price}` : "limit price must be between 0 and 1"
    });
    checks.push({
      id: "valid_share_size",
      ok: validSize,
      severity: "critical",
      detail: validSize ? `size=${size}` : "share size must be positive"
    });

    if (validPrice && validSize) {
      estimatedShares = size;
      if (input.side === "BUY") {
        estimatedCostUsdc = price * size;
        availableWithinSlippage = true;
      } else {
        estimatedProceedsUsdc = price * size;
        availableWithinSlippage = true;
      }
      estimatedVwap = price;
      worstFillPrice = price;
    }
  } else if (input.side === "BUY") {
    const amount = Number(input.amountUsdc);
    const validAmount = Number.isFinite(amount) && amount > 0;
    checks.push({
      id: "valid_market_buy_amount",
      ok: validAmount,
      severity: "critical",
      detail: validAmount ? `amountUsdc=${amount}` : "market BUY requires positive amountUsdc"
    });

    if (validAmount && book.bestAsk !== null) {
      const maxPrice = Math.min(1, book.bestAsk * (1 + maxSlippageBps / 10_000));
      const fill = walkBuyByBudget(asks, amount, maxPrice);
      estimatedShares = fill.shares;
      estimatedCostUsdc = fill.cost;
      estimatedVwap = fill.vwap;
      worstFillPrice = fill.worstPrice;
      availableWithinSlippage = fill.filled;
    }
  } else {
    const size = Number(input.size);
    const validSize = Number.isFinite(size) && size > 0;
    checks.push({
      id: "valid_market_sell_size",
      ok: validSize,
      severity: "critical",
      detail: validSize ? `size=${size}` : "market SELL requires positive share size"
    });

    if (validSize && book.bestBid !== null) {
      const minPrice = Math.max(0, book.bestBid * (1 - maxSlippageBps / 10_000));
      const fill = walkSellByShares(bids, size, minPrice);
      estimatedShares = fill.shares;
      estimatedProceedsUsdc = fill.proceeds;
      estimatedVwap = fill.vwap;
      worstFillPrice = fill.worstPrice;
      availableWithinSlippage = fill.filled;
    }
  }

  checks.push({
    id: "orderbook_available",
    ok: book.bestBid !== null || book.bestAsk !== null,
    severity: "critical",
    detail: `bestBid=${book.bestBid ?? "none"}, bestAsk=${book.bestAsk ?? "none"}`
  });

  checks.push({
    id: "slippage_liquidity",
    ok: input.orderType === "LIMIT" || availableWithinSlippage,
    severity: input.orderType === "LIMIT" ? "info" : "critical",
    detail:
      input.orderType === "LIMIT"
        ? "resting limit order does not require immediate fill"
        : availableWithinSlippage
          ? `requested size fits within ${maxSlippageBps} bps`
          : `insufficient visible depth within ${maxSlippageBps} bps`
  });

  const submissionEnabled = tradingSubmissionEnabled();
  checks.push({
    id: "server_trade_submission_enabled",
    ok: submissionEnabled,
    severity: "info",
    detail: submissionEnabled
      ? "submission feature flag is enabled; wallet signature is still required"
      : "disabled until wallet onboarding is completed"
  });

  return {
    tokenId: input.tokenId,
    side: input.side,
    orderType: input.orderType,
    requestedPrice: input.price == null ? null : round(Number(input.price)),
    requestedSize: input.size == null ? null : round(Number(input.size)),
    requestedAmountUsdc: input.amountUsdc == null ? null : round(Number(input.amountUsdc)),
    maxSlippageBps,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midpoint: book.midpoint,
    spread: book.spread,
    estimatedShares: estimatedShares === null ? null : round(estimatedShares),
    estimatedCostUsdc: estimatedCostUsdc === null ? null : round(estimatedCostUsdc),
    estimatedProceedsUsdc: estimatedProceedsUsdc === null ? null : round(estimatedProceedsUsdc),
    estimatedVwap: estimatedVwap === null ? null : round(estimatedVwap),
    worstFillPrice: worstFillPrice === null ? null : round(worstFillPrice),
    availableWithinSlippage,
    checks,
    signingRequired: true,
    submissionEnabled,
    note:
      "Non-custodial flow: the server may prepare and validate an order, but the configured wallet must sign the final Polymarket order. Never store a seed phrase or raw private key in this service."
  };
}


export async function getWalletPortfolio(profile: WalletProfile | null) {
  if (!profile?.configured || !profile.walletAddress) {
    return {
      configured: false,
      walletAddress: null,
      stats: null,
      openPositions: []
    };
  }

  const lookupAddress =
    profile.proxyWallet ||
    profile.funderAddress ||
    profile.walletAddress;

  const [stats, openPositions] = await Promise.all([
    getUserStatsV2(lookupAddress).catch(() => null),
    getUserPositionsV2(lookupAddress, "OPEN", 500).catch(() => [])
  ]);

  return {
    configured: true,
    walletAddress: profile.walletAddress,
    lookupAddress,
    chainId: profile.chainId,
    walletType: profile.walletType,
    signatureType: profile.signatureType,
    stats,
    openPositions,
    signingMode: "user_wallet_signature",
    privateKeyStored: false
  };
}
