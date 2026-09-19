#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  getMarketBySlug,
  getOrderBook,
  getPriceHistory,
  parseNumberArray,
  parseStringArray,
  searchActiveMarkets,
  upstreamCheck
} from "./polymarket.js";
import { scanBinaryArbitrage, scanClosingSoon, scanOpportunities } from "./scanner.js";

const PORT = Number(process.env.PORT || 3000);
const VERSION = "0.2.0";

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
      upstream: "/api/upstream-check"
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
});

function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", message: "shutdown", signal }));
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
