type Direction = "above" | "below";

export interface CryptoThresholdSpec {
  asset: string;
  coinbaseProduct: string;
  krakenPair: string;
  thresholdUsd: number;
  direction: Direction;
}

export interface ExternalCryptoEvidence {
  type: "crypto_threshold";
  supported: true;
  asset: string;
  thresholdUsd: number;
  direction: Direction;
  sources: Array<{
    source: "coinbase" | "kraken";
    priceUsd: number;
    bestBidUsd: number | null;
    bestAskUsd: number | null;
  }>;
  consensusPriceUsd: number;
  sourceDivergenceBps: number | null;
  distanceToThresholdUsd: number;
  distanceToThresholdPct: number;
  currentlyAboveThreshold: boolean;
  nearThreshold: boolean;
  observedAt: string;
  flags: string[];
}

const ASSETS: Array<{
  aliases: RegExp;
  asset: string;
  coinbaseProduct: string;
  krakenPair: string;
}> = [
  { aliases: /\b(bitcoin|btc)\b/i, asset: "BTC", coinbaseProduct: "BTC-USD", krakenPair: "xbtusd" },
  { aliases: /\b(ethereum|ether|eth)\b/i, asset: "ETH", coinbaseProduct: "ETH-USD", krakenPair: "ethusd" },
  { aliases: /\b(solana|sol)\b/i, asset: "SOL", coinbaseProduct: "SOL-USD", krakenPair: "solusd" },
  { aliases: /\b(xrp|ripple)\b/i, asset: "XRP", coinbaseProduct: "XRP-USD", krakenPair: "xrpusd" },
  { aliases: /\b(dogecoin|doge)\b/i, asset: "DOGE", coinbaseProduct: "DOGE-USD", krakenPair: "dogeusd" }
];

const cache = new Map<string, { at: number; evidence: ExternalCryptoEvidence }>();
const CACHE_MS = Math.max(1000, Number(process.env.EXTERNAL_EVIDENCE_CACHE_MS || 5000));
const TIMEOUT_MS = Math.max(1000, Number(process.env.EXTERNAL_EVIDENCE_TIMEOUT_MS || 5000));

function n(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

export function parseCryptoThresholdQuestion(question: string): CryptoThresholdSpec | null {
  const asset = ASSETS.find(item => item.aliases.test(question));
  if (!asset) return null;

  const direction: Direction | null =
    /\b(above|over|higher than|at least|greater than|exceed)\b/i.test(question) ? "above" :
    /\b(below|under|lower than|less than|at most)\b/i.test(question) ? "below" :
    null;
  if (!direction) return null;

  const moneyMatches = [...question.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)];
  const plainMatches = [...question.matchAll(/\b([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)\b/g)];
  const match = moneyMatches[0] || plainMatches[0];
  if (!match) return null;

  const thresholdUsd = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) return null;

  return {
    asset: asset.asset,
    coinbaseProduct: asset.coinbaseProduct,
    krakenPair: asset.krakenPair,
    thresholdUsd,
    direction
  };
}

async function fetchJson(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "zoey-polymarket-mcp/0.3" }
    });
    if (!response.ok) throw new Error(`external_${response.status}`);
    return await response.json() as any;
  } finally {
    clearTimeout(timer);
  }
}

async function coinbaseQuote(product: string) {
  const payload = await fetchJson(
    `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(product)}/ticker?limit=1`
  );
  const tradePrice = n(payload?.trades?.[0]?.price);
  const bestBid = n(payload?.best_bid);
  const bestAsk = n(payload?.best_ask);
  const price = tradePrice ?? (
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk
  );
  if (price === null || price <= 0) throw new Error("coinbase_price_missing");
  return {
    source: "coinbase" as const,
    priceUsd: price,
    bestBidUsd: bestBid,
    bestAskUsd: bestAsk
  };
}

async function krakenQuote(pair: string) {
  const payload = await fetchJson(
    `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`
  );
  if (Array.isArray(payload?.error) && payload.error.length) {
    throw new Error(`kraken_${payload.error.join("_")}`);
  }
  const result = payload?.result && Object.values(payload.result)[0] as any;
  const price = n(result?.c?.[0]);
  const bestBid = n(result?.b?.[0]);
  const bestAsk = n(result?.a?.[0]);
  if (price === null || price <= 0) throw new Error("kraken_price_missing");
  return {
    source: "kraken" as const,
    priceUsd: price,
    bestBidUsd: bestBid,
    bestAskUsd: bestAsk
  };
}

export async function getExternalCryptoEvidence(question: string): Promise<ExternalCryptoEvidence | null> {
  const spec = parseCryptoThresholdQuestion(question);
  if (!spec) return null;

  const cacheKey = `${spec.asset}:${spec.thresholdUsd}:${spec.direction}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.evidence;

  const settled = await Promise.allSettled([
    coinbaseQuote(spec.coinbaseProduct),
    krakenQuote(spec.krakenPair)
  ]);

  const sources = settled
    .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof coinbaseQuote>> | Awaited<ReturnType<typeof krakenQuote>>> =>
      result.status === "fulfilled"
    )
    .map(result => result.value);

  if (!sources.length) return null;

  const sorted = sources.map(source => source.priceUsd).sort((a, b) => a - b);
  const consensus =
    sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const divergenceBps = sources.length >= 2
    ? ((Math.max(...sorted) - Math.min(...sorted)) / consensus) * 10_000
    : null;
  const distanceUsd = consensus - spec.thresholdUsd;
  const distancePct = (distanceUsd / spec.thresholdUsd) * 100;
  const nearThreshold = Math.abs(distancePct) <= 0.5;
  const flags: string[] = [];
  if (sources.length < 2) flags.push("single_external_source");
  if (divergenceBps !== null && divergenceBps > 25) flags.push("external_source_divergence");
  if (nearThreshold) flags.push("near_external_resolution_threshold");

  const evidence: ExternalCryptoEvidence = {
    type: "crypto_threshold",
    supported: true,
    asset: spec.asset,
    thresholdUsd: spec.thresholdUsd,
    direction: spec.direction,
    sources: sources.map(source => ({
      ...source,
      priceUsd: round(source.priceUsd, 6),
      bestBidUsd: source.bestBidUsd === null ? null : round(source.bestBidUsd, 6),
      bestAskUsd: source.bestAskUsd === null ? null : round(source.bestAskUsd, 6)
    })),
    consensusPriceUsd: round(consensus, 6),
    sourceDivergenceBps: divergenceBps === null ? null : round(divergenceBps, 2),
    distanceToThresholdUsd: round(distanceUsd, 6),
    distanceToThresholdPct: round(distancePct, 4),
    currentlyAboveThreshold: consensus > spec.thresholdUsd,
    nearThreshold,
    observedAt: new Date().toISOString(),
    flags
  };

  cache.set(cacheKey, { at: Date.now(), evidence });
  return evidence;
}
