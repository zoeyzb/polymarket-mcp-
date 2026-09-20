import type { GammaMarket, NormalizedBook, OrderBook, OrderLevel } from "./types.js";

const GAMMA_BASE = process.env.GAMMA_API_BASE || "https://gamma-api.polymarket.com";
const CLOB_BASE = process.env.CLOB_API_BASE || "https://clob.polymarket.com";
const DATA_BASE = process.env.DATA_API_BASE || "https://data-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 10000);

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "zoey-polymarket-mcp/0.2",
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`Upstream ${response.status} ${response.statusText}: ${url}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function numberOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(",").map(v => v.trim()).filter(Boolean);
  }
}

export function parseNumberArray(value: unknown): number[] {
  return parseStringArray(value).map(Number).filter(Number.isFinite);
}

let activeMarketCache: { at: number; markets: GammaMarket[] } | null = null;
const ACTIVE_CACHE_MS = Math.max(0, Number(process.env.ACTIVE_MARKET_CACHE_MS || 15000));

export async function listAllActiveMarkets(maxPages = 1000, pageSize = 100): Promise<GammaMarket[]> {
  if (activeMarketCache && Date.now() - activeMarketCache.at < ACTIVE_CACHE_MS) {
    return activeMarketCache.markets;
  }

  const byKey = new Map<string, GammaMarket>();

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      limit: String(pageSize),
      offset: String(offset)
    });

    let batch: GammaMarket[];
    try {
      batch = await fetchJson<GammaMarket[]>(`${GAMMA_BASE}/markets?${params}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (page > 0 && message.includes("422")) break;
      throw error;
    }

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const market of batch) {
      const key = String(market.id || market.conditionId || market.slug || `${page}-${byKey.size}`);
      byKey.set(key, market);
    }

    if (batch.length < pageSize) break;
  }

  const markets = [...byKey.values()];
  activeMarketCache = { at: Date.now(), markets };
  return markets;
}

export async function listActiveMarketsEndingBetween(
  start: Date,
  end: Date,
  maxPages = 1000,
  pageSize = 100
): Promise<GammaMarket[]> {
  const byKey = new Map<string, GammaMarket>();

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      end_date_min: start.toISOString(),
      end_date_max: end.toISOString(),
      order: "endDate",
      ascending: "true",
      limit: String(pageSize),
      offset: String(offset)
    });

    let batch: GammaMarket[];
    try {
      batch = await fetchJson<GammaMarket[]>(`${GAMMA_BASE}/markets?${params}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (page > 0 && message.includes("422")) break;
      throw error;
    }

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const market of batch) {
      const key = String(market.id || market.conditionId || market.slug || `${page}-${byKey.size}`);
      byKey.set(key, market);
    }

    if (batch.length < pageSize) break;
  }

  return [...byKey.values()];
}

export async function listClosedMarketsEndingBetween(
  start: Date,
  end: Date,
  maxPages = 20,
  pageSize = 100
): Promise<GammaMarket[]> {
  const byKey = new Map<string, GammaMarket>();

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const params = new URLSearchParams({
      closed: "true",
      end_date_min: start.toISOString(),
      end_date_max: end.toISOString(),
      order: "endDate",
      ascending: "false",
      limit: String(pageSize),
      offset: String(offset)
    });

    let batch: GammaMarket[];
    try {
      batch = await fetchJson<GammaMarket[]>(`${GAMMA_BASE}/markets?${params}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (page > 0 && message.includes("422")) break;
      throw error;
    }

    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const market of batch) {
      const key = String(market.id || market.conditionId || market.slug || `${page}-${byKey.size}`);
      byKey.set(key, market);
    }
    if (batch.length < pageSize) break;
  }

  return [...byKey.values()];
}

export async function getEventById(eventId: string): Promise<Record<string, unknown> | null> {
  if (!eventId) return null;
  try {
    const event = await fetchJson<Record<string, unknown>>(
      `${GAMMA_BASE}/events/${encodeURIComponent(eventId)}`
    );
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

export async function getMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const params = new URLSearchParams({ slug });
  const markets = await fetchJson<GammaMarket[]>(`${GAMMA_BASE}/markets?${params}`);
  return Array.isArray(markets) && markets.length ? markets[0] : null;
}

export async function searchActiveMarkets(query: string, limit = 25): Promise<GammaMarket[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const markets = await listAllActiveMarkets();
  return markets
    .filter(m => {
      const haystack = [m.question, m.description, m.slug]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    })
    .slice(0, limit);
}

function normalizeLevels(levels: OrderLevel[] | undefined, direction: "bid" | "ask") {
  const normalized = (levels || [])
    .map(level => ({ price: numberOf(level.price), size: numberOf(level.size) }))
    .filter(level => level.price > 0 && level.price <= 1 && level.size > 0);
  normalized.sort((a, b) => direction === "bid" ? b.price - a.price : a.price - b.price);
  return normalized;
}

function normalizeBook(raw: OrderBook, fallbackTokenId?: string): NormalizedBook {
  const tokenId = String(raw.asset_id || fallbackTokenId || "");
  const bids = normalizeLevels(raw.bids, "bid");
  const asks = normalizeLevels(raw.asks, "ask");
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null;
  const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestAsk ?? bestBid);
  const bidDepthUsdTop5 = bids.slice(0, 5).reduce((sum, l) => sum + l.price * l.size, 0);
  const askDepthUsdTop5 = asks.slice(0, 5).reduce((sum, l) => sum + l.price * l.size, 0);
  return { tokenId, bestBid, bestAsk, spread, midpoint, bidDepthUsdTop5, askDepthUsdTop5, raw };
}

export async function getOrderBook(tokenId: string): Promise<NormalizedBook> {
  const params = new URLSearchParams({ token_id: tokenId });
  const raw = await fetchJson<OrderBook>(`${CLOB_BASE}/book?${params}`);
  return normalizeBook(raw, tokenId);
}

export async function getOrderBooks(tokenIds: string[]): Promise<Map<string, NormalizedBook>> {
  const unique = [...new Set(tokenIds.filter(Boolean))];
  const out = new Map<string, NormalizedBook>();
  const chunkSize = 500;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    try {
      const raws = await fetchJson<OrderBook[]>(
        `${CLOB_BASE}/books`,
        {
          method: "POST",
          body: JSON.stringify(chunk.map(token_id => ({ token_id })))
        },
        Math.max(DEFAULT_TIMEOUT_MS, 20000)
      );

      if (!Array.isArray(raws)) throw new Error("CLOB /books returned a non-array payload");
      raws.forEach((raw, index) => {
        const normalized = normalizeBook(raw, chunk[index]);
        if (normalized.tokenId) out.set(normalized.tokenId, normalized);
      });
    } catch {
      const fallback = await Promise.all(chunk.map(async tokenId => {
        try { return await getOrderBook(tokenId); } catch { return null; }
      }));
      for (const book of fallback) if (book) out.set(book.tokenId, book);
    }
  }

  return out;
}

type DataV2Envelope<T> = {
  data: T;
  pagination?: {
    has_more?: boolean;
    next_cursor?: string | null;
    limit?: number;
    offset?: number;
  };
};

export async function getLeaderboardV2(
  limit = 50,
  timePeriod: "day" | "week" | "month" | "all" = "all",
  category = "overall",
  sortBy: "PNL" | "VOLUME" = "PNL"
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({
    limit: String(Math.min(1000, Math.max(1, limit))),
    sort_by: sortBy,
    time_period: timePeriod,
    category
  });
  const payload = await fetchJson<DataV2Envelope<Array<Record<string, unknown>>>>(
    `${DATA_BASE}/v2/leaderboard?${params}`
  );
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function getUserStatsV2(user: string): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ user });
  const payload = await fetchJson<DataV2Envelope<Record<string, unknown> | null>>(
    `${DATA_BASE}/v2/user-stats?${params}`
  );
  return payload?.data && typeof payload.data === "object" ? payload.data : null;
}

export async function getUserPositionsV2(
  user: string,
  status: "OPEN" | "REDEEMABLE" | "CLOSED" = "CLOSED",
  limit = 200
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({
    user,
    status,
    limit: String(Math.min(1000, Math.max(1, limit))),
    sort_by: status === "CLOSED" ? "REALIZED_PNL" : "CURRENT_VALUE",
    sort_direction: "DESC"
  });
  const payload = await fetchJson<DataV2Envelope<Array<Record<string, unknown>>>>(
    `${DATA_BASE}/v2/positions?${params}`
  );
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function getUserTradesV2(
  user: string,
  limit = 100
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({
    user,
    limit: String(Math.min(1000, Math.max(1, limit)))
  });
  const payload = await fetchJson<DataV2Envelope<Array<Record<string, unknown>>>>(
    `${DATA_BASE}/v2/trades?${params}`
  );
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function getConditionTradesV2(
  conditionId: string,
  limit = 100
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({
    condition: conditionId,
    limit: String(Math.min(1000, Math.max(1, limit)))
  });
  const payload = await fetchJson<DataV2Envelope<Array<Record<string, unknown>>>>(
    `${DATA_BASE}/v2/trades?${params}`
  );
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function getRecentTrades(conditionId: string, limit = 100): Promise<unknown[]> {
  const params = new URLSearchParams({
    market: conditionId,
    limit: String(Math.min(500, Math.max(1, limit))),
    offset: "0"
  });
  const payload = await fetchJson<unknown>(`${DATA_BASE}/trades?${params}`);
  return Array.isArray(payload) ? payload : [];
}

export async function getPriceHistoryRange(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelityMinutes = 5
): Promise<unknown> {
  const params = new URLSearchParams({
    market: tokenId,
    startTs: String(Math.max(0, Math.floor(startTs))),
    endTs: String(Math.max(0, Math.floor(endTs))),
    fidelity: String(Math.max(1, fidelityMinutes))
  });
  return fetchJson<unknown>(`${CLOB_BASE}/prices-history?${params}`);
}

export async function getPriceHistory(tokenId: string, hours = 6, fidelityMinutes = 1): Promise<unknown> {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.max(1, hours) * 3600;
  const params = new URLSearchParams({
    market: tokenId,
    startTs: String(startTs),
    endTs: String(endTs),
    fidelity: String(Math.max(1, fidelityMinutes))
  });
  return fetchJson<unknown>(`${CLOB_BASE}/prices-history?${params}`);
}

export async function upstreamCheck(): Promise<Record<string, unknown>> {
  const started = Date.now();
  const params = new URLSearchParams({ active: "true", closed: "false", limit: "1", offset: "0" });
  const markets = await fetchJson<GammaMarket[]>(`${GAMMA_BASE}/markets?${params}`);
  const gammaLatencyMs = Date.now() - started;
  const market = markets?.[0] ?? null;
  const tokenIds = market ? parseStringArray(market.clobTokenIds) : [];
  let clob: Record<string, unknown> = { ok: false, reason: "no token available" };

  if (tokenIds[0]) {
    const clobStarted = Date.now();
    try {
      const book = await getOrderBook(tokenIds[0]);
      clob = {
        ok: true,
        latencyMs: Date.now() - clobStarted,
        tokenId: tokenIds[0],
        bestBid: book.bestBid,
        bestAsk: book.bestAsk
      };
    } catch (error) {
      clob = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    ok: true,
    gamma: {
      ok: Array.isArray(markets),
      latencyMs: gammaLatencyMs,
      sampleMarket: market?.question ?? null
    },
    clob
  };
}
