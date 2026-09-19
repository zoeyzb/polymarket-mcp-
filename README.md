# Polymarket MCP

Current production architecture: **v0.3 intelligence engine**.

A read-only Railway-hosted MCP server that scans **all active Polymarket markets resolving within at most two hours** and ranks short-dated market-structure opportunities.

## What changed in v0.2

- Gamma is filtered to the exact closing window instead of crawling the entire universe first.
- CLOB order books are fetched with the official batch `POST /books` path (up to 500 tokens per batch), with single-book fallback.
- Binary complete-set edges are walked through real ask depth at $10 / $25 / $50 / $100.
- A configurable execution buffer (default 50 bps) is deducted before an edge is called executable.
- A top-of-book YES+NO sum below $1 is **not** treated as an opportunity unless the depth-aware calculation remains positive.
- Markets now receive both a tradability score and a separate market-structure opportunity score.
- No order placement or wallet credentials exist in this service.

## Architecture

```
ChatGPT / MCP client
        |
        v
Railway Streamable HTTP MCP
        |
        +--> Gamma API  (active markets + closing-window filter + rules)
        +--> CLOB API   (batched live order books + price history)
        +--> Brain      (depth-aware execution + structural edge + quality score)
```

The MCP client can then use the returned resolution rules and sources to do fresh event research. The server itself does not invent a directional probability or claim which outcome will win.

## MCP tools

- `markets.scan_opportunities` — opportunity-ranked scan across all markets ending within ≤120 minutes
- `markets.scan_closing_soon` — full closing-window scan
- `markets.arbitrage_closing_soon` — only depth-tested executable binary complete-set edges
- `markets.search`
- `markets.get_by_slug`
- `markets.order_book`
- `markets.price_history`
- `system.upstream_check`

## HTTP endpoints

- `GET /health`
- `GET /api/opportunities?minutes=120&limit=50&minScore=35&bufferBps=50`
- `GET /api/closing-soon?minutes=120&limit=50&books=true&sort=opportunity`
- `GET /api/arbitrage?minutes=120&limit=50&bufferBps=50`
- `GET /api/market/:slug`
- `GET /api/upstream-check`
- `POST /mcp`

## Opportunity classes

- `executable_structural`: a binary complete-set edge remains positive after walking both books and applying the configured execution buffer.
- `top_book_structural_only`: the first ask levels imply an edge, but depth/buffer removes it.
- `research_candidate`: liquid/tight enough to investigate, but the scanner has **not** found a structural profit.

The opportunity score is not a forecast of which side will win. For political/election markets in particular, this service stays market-structure-only and does not produce an election winner prediction.

## Verification

```bash
npm run verify
```

Railway is configured to run the verification suite during build before starting the service.

## Influences

- **Polymarket/agent-skills**: official current guidance for Gamma/CLOB data sources and batch order-book access.
- **Model Context Protocol SDK**: Streamable HTTP transport.
- Existing scanner code in this repository: preserved the read-only/no-wallet boundary and rewrote the opportunity logic around executable depth rather than headline prices.


## v0.3 intelligence additions

- Continuous 30-second background scans (configurable with `BACKGROUND_SCAN_SECONDS`).
- Rolling in-process scanner snapshots and health deltas.
- Automatic NegRisk / multi-outcome event grouping when Gamma marks the event as NegRisk.
- Equal-share complete-outcome basket execution across 3+ outcomes, walking live ask depth.
- Price-regime analysis for any outcome token: stable / trending / volatile / shock plus anomaly score.
- Manual complete-outcome basket MCP calculator for advanced research.
- Political/election markets remain structural-only; no internally generated winner forecast is produced.

### Additional MCP tools

- `markets.price_regime`
- `markets.complete_outcome_basket`
- `system.snapshot_health`
- `system.snapshots`

### Additional HTTP endpoints

- `GET /api/snapshot-health`
- `GET /api/snapshots?limit=100`
