#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  getMarketBySlug,
  getOrderBook,
  getOrderBooks,
  getPriceHistory,
  getRecentTrades,
  parseNumberArray,
  parseStringArray,
  searchActiveMarkets,
  upstreamCheck
} from "./polymarket.js";
import { scanBinaryArbitrage, scanClosingSoon, scanOpportunities } from "./scanner.js";
import { analyzePriceHistoryPayload, analyzeTradeFlowPayload, calculateCompleteOutcomeBasket } from "./intelligence.js";
import { getSnapshotHealth, getSnapshots } from "./snapshots.js";
import { realtimeTracker } from "./realtime.js";
import {
  getCalibrationStats,
  getHistoricalCandidateStats,
  getPersistentStats,
  getResolutionStats,
  getUnresolvedObservedMarkets,
  persistScan,
  persistenceConfig,
  recordResolution,
  testPersistenceConnection
} from "./persistence.js";
import { inferFinalResolution } from "./resolutions.js";
import { getExternalCryptoEvidence } from "./external-evidence.js";
import type { NormalizedBook } from "./types.js";

const PORT = Number(process.env.PORT || 3000);
const VERSION = "0.4.0";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createMcpServer() {
  const server = new McpServer({ name: "zoey-polymarket-mcp", version: VERSION });

  server.registerTool(
    "markets.scan_closing_soon",
    {
      description: "Scan all active Polymarket markets ending within at most 120 minutes. Uses live CLOB order books and can sort by executable opportunity, tradability, liquidity, or closing time. The opportunity score is market-structure based, not a prediction of which outcome will win.",
      inputSchema: {
        maxMinutes: z.number().int().min(1).max(120).default(120),
        minLiquidity: z.number().min(0).default(0),
        includeOrderBooks: z.boolean().default(true),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
        sort: z.enum(["soonest", "review_score", "liquidity", "opportunity"]).default("opportunity"),
        bufferBps: z.number().min(0).max(1000).default(50)
      }
    },
    async input => textResult(await scanClosingSoon(input))
  );

  server.registerTool(
    "markets.scan_opportunities",
    {
      description: "Return the strongest market-structure opportunities among all active markets ending within at most 120 minutes. Executable structural opportunities are depth-tested at $10/$25/$50/$100 and include a configurable execution buffer. Research candidates are tradable markets, not directional recommendations.",
      inputSchema: {
        maxMinutes: z.number().int().min(1).max(120).default(120),
        minLiquidity: z.number().min(0).default(0),
        minOpportunityScore: z.number().min(0).max(100).default(35),
        limit: z.number().int().min(1).max(200).default(50),
        bufferBps: z.number().min(0).max(1000).default(50)
      }
    },
    async input => textResult(await scanOpportunities(input))
  );

  server.registerTool(
    "markets.arbitrage_closing_soon",
    {
      description: "Scan all active markets ending within at most 120 minutes and return only binary complete-set edges that remain positive after walking real order-book depth and applying an execution buffer.",
      inputSchema: {
        maxMinutes: z.number().int().min(1).max(120).default(120),
        limit: z.number().int().min(1).max(200).default(50),
        bufferBps: z.number().min(0).max(1000).default(50)
      }
    },
    async input => textResult(await scanBinaryArbitrage(input.maxMinutes, input.limit, input.bufferBps))
  );

  server.registerTool(
    "markets.search",
    {
      description: "Search all currently active Polymarket markets by question, description, or slug. Read-only.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(25)
      }
    },
    async input => {
      const markets = await searchActiveMarkets(input.query, input.limit);
      return textResult(markets.map(m => ({
        id: m.id ?? null,
        slug: m.slug ?? null,
        question: m.question ?? null,
        endDate: m.endDateIso ?? m.endDate ?? null,
        acceptingOrders: m.acceptingOrders ?? null,
        liquidity: m.liquidityNum ?? m.liquidity ?? null,
        volume24hr: m.volume24hr ?? null,
        outcomes: parseStringArray(m.outcomes),
        prices: parseNumberArray(m.outcomePrices)
      })));
    }
  );

  server.registerTool(
    "markets.get_by_slug",
    {
      description: "Get a full Gamma market record, including resolution rules/source and outcome token IDs, by Polymarket slug.",
      inputSchema: { slug: z.string().min(1) }
    },
    async input => textResult(await getMarketBySlug(input.slug))
  );

  server.registerTool(
    "markets.order_book",
    {
      description: "Get the live CLOB order book summary and raw levels for an outcome token ID.",
      inputSchema: { tokenId: z.string().min(1) }
    },
    async input => textResult(await getOrderBook(input.tokenId))
  );

  server.registerTool(
    "markets.external_evidence",
    {
      description: "For supported short-dated crypto threshold questions, cross-check independent Coinbase and Kraken public spot data and report threshold distance/source divergence. Descriptive only; no win probability or outcome recommendation.",
      inputSchema: {
        question: z.string().min(1)
      }
    },
    async input => textResult({
      question: input.question,
      evidence: await getExternalCryptoEvidence(input.question)
    })
  );

  server.registerTool(
    "markets.research_packet",
    {
      description: "Build one read-only research packet for a Polymarket market: resolution rules/source, live CLOB books, price regimes, recent trade flow, and durable prior observations. Descriptive only; it does not choose or recommend an outcome.",
      inputSchema: {
        slug: z.string().min(1),
        historyHours: z.number().int().min(1).max(168).default(6),
        fidelityMinutes: z.number().int().min(1).max(60).default(5)
      }
    },
    async input => {
      const market = await getMarketBySlug(input.slug);
      if (!market) return textResult({ ok: false, reason: "market_not_found", slug: input.slug });

      const tokenIds = parseStringArray(market.clobTokenIds);
      const outcomes = parseStringArray(market.outcomes);
      const books = tokenIds.length ? await getOrderBooks(tokenIds) : new Map();
      const history = await Promise.all(tokenIds.map(async tokenId => {
        const payload = await getPriceHistory(tokenId, input.historyHours, input.fidelityMinutes).catch(() => null);
        return {
          tokenId,
          analysis: payload ? analyzePriceHistoryPayload(payload) : null
        };
      }));

      const conditionId = market.conditionId ? String(market.conditionId) : null;
      const trades = conditionId
        ? await getRecentTrades(conditionId, 200).catch(() => [])
        : [];
      const historical = conditionId
        ? (await getHistoricalCandidateStats([conditionId]).catch(() => new Map())).get(conditionId) ?? null
        : null;

      return textResult({
        ok: true,
        market: {
          id: market.id ?? null,
          slug: market.slug ?? input.slug,
          question: market.question ?? null,
          conditionId,
          endDate: market.endDateIso ?? market.endDate ?? null,
          active: market.active ?? null,
          closed: market.closed ?? null,
          acceptingOrders: market.acceptingOrders ?? null,
          resolutionSource: market.resolutionSource ?? null,
          resolutionRules: market.description ?? null,
          outcomes,
          displayedOutcomePrices: parseNumberArray(market.outcomePrices),
          tokenIds
        },
        books: tokenIds.map((tokenId, index) => {
          const book = books.get(tokenId);
          return {
            outcome: outcomes[index] ?? `Outcome ${index + 1}`,
            tokenId,
            bestBid: book?.bestBid ?? null,
            bestAsk: book?.bestAsk ?? null,
            spread: book?.spread ?? null,
            bidDepthUsdTop5: book?.bidDepthUsdTop5 ?? 0,
            askDepthUsdTop5: book?.askDepthUsdTop5 ?? 0
          };
        }),
        priceRegimes: history,
        tradeFlow: analyzeTradeFlowPayload(trades),
        historicalEvidence: historical,
        independentExternalEvidence: await getExternalCryptoEvidence(String(market.question || "")).catch(() => null),
        externalEvidenceNeeded: [
          "Verify the event state using current primary or authoritative sources.",
          "Check the exact resolution wording and source before interpreting evidence.",
          "Compare fresh event evidence with current market pricing; do not infer certainty from market price alone."
        ]
      });
    }
  );

  server.registerTool(
    "markets.trade_flow",
    {
      description: "Analyze recent public Data API trades for one market condition ID: notional flow, imbalance, largest trade, recent activity, and a flow-attention score. This is descriptive market behavior, not a winner prediction.",
      inputSchema: {
        conditionId: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async input => {
      const trades = await getRecentTrades(input.conditionId, input.limit);
      return textResult({
        conditionId: input.conditionId,
        analysis: analyzeTradeFlowPayload(trades)
      });
    }
  );

  server.registerTool(
    "markets.price_regime",
    {
      description: "Analyze a token's recent Polymarket price path for trend, volatility, shock behavior, and anomaly score. This describes market behavior only; it is not a directional recommendation.",
      inputSchema: {
        tokenId: z.string().min(1),
        hours: z.number().int().min(1).max(168).default(6),
        fidelityMinutes: z.number().int().min(1).max(60).default(1)
      }
    },
    async input => {
      const history = await getPriceHistory(input.tokenId, input.hours, input.fidelityMinutes);
      return textResult({
        tokenId: input.tokenId,
        hours: input.hours,
        fidelityMinutes: input.fidelityMinutes,
        analysis: analyzePriceHistoryPayload(history)
      });
    }
  );

  server.registerTool(
    "markets.complete_outcome_basket",
    {
      description: "Depth-test a caller-supplied mutually-exclusive and collectively-exhaustive outcome-token basket. Only use token IDs that truly form one complete outcome set. Returns executable equal-share package economics after an execution buffer.",
      inputSchema: {
        tokenIds: z.array(z.string().min(1)).min(2).max(100),
        budgetUsd: z.number().positive().max(100000).default(100),
        bufferBps: z.number().min(0).max(1000).default(50)
      }
    },
    async input => {
      const books = await getOrderBooks(input.tokenIds);
      const ordered = input.tokenIds
        .map(tokenId => books.get(tokenId))
        .filter((book): book is NormalizedBook => Boolean(book));
      if (ordered.length !== input.tokenIds.length) {
        return textResult({
          ok: false,
          reason: "missing_order_book",
          requested: input.tokenIds.length,
          loaded: ordered.length
        });
      }
      return textResult({
        ok: true,
        assumption: "tokenIds are mutually exclusive and collectively exhaustive",
        execution: calculateCompleteOutcomeBasket(ordered, input.budgetUsd, input.bufferBps)
      });
    }
  );

  server.registerTool(
    "markets.realtime_quote",
    {
      description: "Return the latest public Polymarket WebSocket quote cached for a subscribed short-dated outcome token.",
      inputSchema: {
        tokenId: z.string().min(1)
      }
    },
    async input => textResult({
      tokenId: input.tokenId,
      quote: realtimeTracker.getQuote(input.tokenId),
      realtime: realtimeTracker.getHealth()
    })
  );

  server.registerTool(
    "system.realtime_health",
    {
      description: "Return public Polymarket market-WebSocket connection, subscription, message, and reconnect health."
    },
    async () => textResult(realtimeTracker.getHealth())
  );

  server.registerTool(
    "system.resolution_history",
    {
      description: "Return durable finalized-outcome history counts for previously observed markets. This reports completed market outcomes only and does not predict future winners."
    },
    async () => textResult(await getResolutionStats())
  );

  server.registerTool(
    "system.calibration",
    {
      description: "Return empirical persistence/calibration statistics from durable historical scans, including repeated-market observations and structural-edge persistence."
    },
    async () => textResult(await getCalibrationStats())
  );

  server.registerTool(
    "system.persistence_health",
    {
      description: "Return durable Polymarket history backend status and aggregate stored scan statistics."
    },
    async () => textResult({
      config: persistenceConfig(),
      connection: await testPersistenceConnection().catch(error => ({ error: errorMessage(error) })),
      stats: await getPersistentStats().catch(error => ({
        error: errorMessage(error)
      }))
    })
  );

  server.registerTool(
    "system.snapshot_health",
    {
      description: "Return rolling in-process scanner health and deltas across recent scans."
    },
    async () => textResult(getSnapshotHealth())
  );

  server.registerTool(
    "system.snapshots",
    {
      description: "Return recent in-process opportunity scanner snapshots.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async input => textResult(getSnapshots(input.limit))
  );

  server.registerTool(
    "markets.price_history",
    {
      description: "Get CLOB price history for an outcome token ID.",
      inputSchema: {
        tokenId: z.string().min(1),
        hours: z.number().int().min(1).max(168).default(6),
        fidelityMinutes: z.number().int().min(1).max(60).default(1)
      }
    },
    async input => textResult(await getPriceHistory(input.tokenId, input.hours, input.fidelityMinutes))
  );

  server.registerTool(
    "system.upstream_check",
    { description: "Verify live access to Polymarket Gamma and CLOB public APIs and return sample latency/top-of-book data." },
    async () => textResult(await upstreamCheck())
  );

  return server;
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeAccept(req: IncomingMessage) {
  const accept = req.headers.accept || "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
  }
}

function numberParam(url: URL, name: string, fallback: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number(url.searchParams.get(name) || fallback)));
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "GET") return false;

  if (url.pathname === "/health") {
    json(res, 200, {
      status: "ok",
      service: "zoey-polymarket-mcp",
      version: VERSION,
      mode: "read-only",
      maxScannerWindowMinutes: 120,
      now: new Date().toISOString()
    });
    return true;
  }

  if (url.pathname === "/api/upstream-check") {
    json(res, 200, await upstreamCheck());
    return true;
  }

  if (url.pathname === "/api/external-evidence") {
    const question = url.searchParams.get("question") || "";
    if (!question.trim()) {
      json(res, 400, { error: "question_required" });
    } else {
      json(res, 200, {
        question,
        evidence: await getExternalCryptoEvidence(question).catch(error => ({
          error: errorMessage(error)
        }))
      });
    }
    return true;
  }

  if (url.pathname === "/api/snapshot-health") {
    json(res, 200, getSnapshotHealth());
    return true;
  }

  if (url.pathname === "/api/realtime-health") {
    json(res, 200, realtimeTracker.getHealth());
    return true;
  }

  if (url.pathname === "/api/persistence-health") {
    json(res, 200, {
      config: persistenceConfig(),
      connection: await testPersistenceConnection().catch(error => ({ error: errorMessage(error) })),
      stats: await getPersistentStats().catch(error => ({ error: errorMessage(error) }))
    });
    return true;
  }

  if (url.pathname === "/api/calibration") {
    json(res, 200, await getCalibrationStats().catch(error => ({ error: errorMessage(error) })));
    return true;
  }

  if (url.pathname === "/api/resolution-history") {
    json(res, 200, await getResolutionStats().catch(error => ({ error: errorMessage(error) })));
    return true;
  }

  if (url.pathname === "/api/snapshots") {
    json(res, 200, getSnapshots(numberParam(url, "limit", 100, 1, 500)));
    return true;
  }

  if (url.pathname === "/api/closing-soon") {
    const sortParam = url.searchParams.get("sort");
    const sort = sortParam === "review_score" || sortParam === "liquidity" || sortParam === "opportunity"
      ? sortParam
      : "soonest";
    json(res, 200, await scanClosingSoon({
      maxMinutes: numberParam(url, "minutes", 120, 1, 120),
      limit: numberParam(url, "limit", 50, 1, 500),
      minLiquidity: Math.max(0, Number(url.searchParams.get("minLiquidity") || 0)),
      includeOrderBooks: url.searchParams.get("books") !== "false",
      sort,
      bufferBps: numberParam(url, "bufferBps", 50, 0, 1000)
    }));
    return true;
  }

  if (url.pathname === "/api/opportunities") {
    json(res, 200, await scanOpportunities({
      maxMinutes: numberParam(url, "minutes", 120, 1, 120),
      limit: numberParam(url, "limit", 50, 1, 200),
      minLiquidity: Math.max(0, Number(url.searchParams.get("minLiquidity") || 0)),
      minOpportunityScore: numberParam(url, "minScore", 35, 0, 100),
      bufferBps: numberParam(url, "bufferBps", 50, 0, 1000)
    }));
    return true;
  }

  if (url.pathname === "/api/arbitrage") {
    json(res, 200, await scanBinaryArbitrage(
      numberParam(url, "minutes", 120, 1, 120),
      numberParam(url, "limit", 50, 1, 200),
      numberParam(url, "bufferBps", 50, 0, 1000)
    ));
    return true;
  }

  if (url.pathname.startsWith("/api/market/")) {
    const slug = decodeURIComponent(url.pathname.slice("/api/market/".length));
    const market = await getMarketBySlug(slug);
    if (!market) json(res, 404, { error: "market_not_found", slug });
    else json(res, 200, market);
    return true;
  }

  if (url.pathname === "/.well-known/mcp/server-card.json") {
    json(res, 200, {
      name: "Zoey Polymarket MCP",
      version: VERSION,
      description: "Read-only Polymarket full-universe two-hour opportunity scanner with depth-aware CLOB execution math.",
      transport: { type: "streamable-http", url: "/mcp" },
      capabilities: ["tools"],
      readOnly: true
    });
    return true;
  }

  if (url.pathname === "/") {
    json(res, 200, {
      name: "zoey-polymarket-mcp",
      version: VERSION,
      mode: "read-only",
      mcp: "/mcp",
      health: "/health",
      opportunities: "/api/opportunities?minutes=120&limit=50",
      scan: "/api/closing-soon?minutes=120&limit=50&books=true&sort=opportunity",
      arbitrage: "/api/arbitrage?minutes=120&limit=50",
      upstream: "/api/upstream-check",
      externalEvidence: "/api/external-evidence?question=Will%20Bitcoin%20be%20above%20%2485000%3F",
      snapshotHealth: "/api/snapshot-health",
      realtimeHealth: "/api/realtime-health",
      persistenceHealth: "/api/persistence-health",
      calibration: "/api/calibration",
      resolutionHistory: "/api/resolution-history"
    });
    return true;
  }

  return false;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (await handleRest(req, res, url)) return;

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        json(res, 405, { error: "method_not_allowed", allowed: ["POST"] });
        return;
      }

      normalizeAccept(req);
      const body = await parseBody(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
      return;
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      path: url.pathname,
      message: errorMessage(error),
      at: new Date().toISOString()
    }));
    if (!res.headersSent) json(res, 500, { error: "internal_error", message: errorMessage(error) });
    else res.end();
  }
});

let backgroundScanRunning = false;
let resolutionWorkerRunning = false;
const BACKGROUND_SCAN_SECONDS = Math.max(15, Number(process.env.BACKGROUND_SCAN_SECONDS || 30));
const RESOLUTION_CHECK_SECONDS = Math.max(60, Number(process.env.RESOLUTION_CHECK_SECONDS || 300));

async function runBackgroundScan() {
  if (backgroundScanRunning) return;
  backgroundScanRunning = true;
  try {
    const scan = await scanClosingSoon({
      maxMinutes: 120,
      minLiquidity: 0,
      includeOrderBooks: true,
      limit: 500,
      sort: "opportunity",
      bufferBps: Number(process.env.OPPORTUNITY_BUFFER_BPS || 50)
    });

    await persistScan(scan).catch(error => {
      console.error(JSON.stringify({
        level: "error",
        message: "persistence_write_failed",
        error: errorMessage(error),
        at: new Date().toISOString()
      }));
    });

    const tokens = new Set<string>();
    for (const candidate of scan.candidates) {
      for (const tokenId of candidate.tokenIds) tokens.add(tokenId);
    }
    for (const basket of scan.eventBaskets || []) {
      for (const tokenId of basket.yesTokenIds) tokens.add(tokenId);
    }
    realtimeTracker.updateTokens([...tokens]);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "background_scan_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    backgroundScanRunning = false;
  }
}

async function runResolutionWorker() {
  if (resolutionWorkerRunning) return;
  resolutionWorkerRunning = true;
  try {
    const unresolved = await getUnresolvedObservedMarkets(100);
    let recorded = 0;
    for (const observed of unresolved) {
      const market = await getMarketBySlug(observed.slug).catch(() => null);
      if (!market) continue;
      const resolution = inferFinalResolution(market);
      if (!resolution) continue;

      await recordResolution({
        conditionId: observed.conditionId,
        marketId: observed.marketId,
        resolvedAt: new Date().toISOString(),
        winningOutcome: resolution.winningOutcome,
        winningTokenId: resolution.winningTokenId,
        source: "gamma_final_prices",
        payload: {
          slug: observed.slug,
          question: observed.question,
          finalPrices: resolution.finalPrices,
          winningIndex: resolution.winningIndex
        }
      });
      recorded += 1;
    }

    if (unresolved.length || recorded) {
      console.log(JSON.stringify({
        level: "info",
        message: "resolution_worker",
        checked: unresolved.length,
        recorded,
        at: new Date().toISOString()
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "resolution_worker_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    resolutionWorkerRunning = false;
  }
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({
    level: "info",
    message: "Polymarket MCP listening",
    version: VERSION,
    port: PORT,
    mode: "read-only",
    mcp: "/mcp",
    at: new Date().toISOString()
  }));

  upstreamCheck()
    .then(result => console.log(JSON.stringify({
      level: "info",
      message: "upstream_self_test",
      result,
      at: new Date().toISOString()
    })))
    .catch(error => console.error(JSON.stringify({
      level: "error",
      message: "upstream_self_test_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    })));

  runBackgroundScan().catch(() => {});
  setInterval(() => {
    runBackgroundScan().catch(() => {});
  }, BACKGROUND_SCAN_SECONDS * 1000).unref();

  runResolutionWorker().catch(() => {});
  setInterval(() => {
    runResolutionWorker().catch(() => {});
  }, RESOLUTION_CHECK_SECONDS * 1000).unref();
});

function shutdown(signal: string) {
  realtimeTracker.close();
  console.log(JSON.stringify({ level: "info", message: "shutdown", signal }));
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
