# Polymarket MCP

A read-only, Railway-hosted Model Context Protocol server for scanning **all active Polymarket markets** and surfacing markets that resolve soon.

## V1 goals

- Scan the full active Gamma market universe, not a hand-picked category.
- Focus on markets ending within a configurable window (default: 120 minutes).
- Enrich candidates with live CLOB order books.
- Calculate spread, top-of-book depth, executable payout examples for $10/$25/$50/$100, and binary YES+NO structural-arbitrage flags.
- Return the actual resolution rules/source so an AI client can research the underlying event before any manual trade.
- Never place orders, store private keys, or require wallet credentials.

## Architecture

```
ChatGPT / MCP client
        |
        v
Railway Streamable HTTP MCP
        |
        +--> Gamma API   (market universe + rules)
        +--> CLOB API    (order books + history)
        +--> Scanner     (time window + quality + execution math)
```

The server is deliberately split so an authenticated execution module can be added later without changing the read-only scanner.

## MCP tools

- `markets.scan_closing_soon`
- `markets.arbitrage_closing_soon`
- `markets.search`
- `markets.get_by_slug`
- `markets.order_book`
- `markets.price_history`
- `system.upstream_check`

## HTTP endpoints

- `GET /health`
- `GET /api/closing-soon?minutes=120&limit=50&books=true`
- `GET /api/arbitrage?minutes=120&limit=100`
- `GET /api/market/:slug`
- `GET /api/upstream-check`
- `POST /mcp`

## Opportunity model

The server does **not** claim to know which outcome will occur. Its score is a **rapid-review / tradability score**, based on:

- time to resolution
- spread
- liquidity
- order-book depth
- 24h volume
- resolution-rule availability

Actual event probability is intentionally left to the AI client, which can cross-check live external evidence and compare that evidence with the market-implied price.

## Safety

V1 is read-only. No wallet, private key, API secret, order placement, or automatic trading code exists in this deployment.

## Influences

- Polymarket official API/client structure: used for endpoint/data-model conventions.
- BrainDAO/IQAI Polymarket MCP (MIT): MCP tool organization pattern only; code here is independently implemented.
- demwick/polymarket-agent-mcp: remote Streamable HTTP lifecycle pattern.
- sancarhuseyin/polymarket-scanner (MIT): paper-first scanner separation and structural-arbitrage ideas; implementation here is rewritten and narrower.

