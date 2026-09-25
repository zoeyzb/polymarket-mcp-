# Polymarket MCP

Current production architecture: **v0.5 intelligence engine**.

A Railway-hosted Polymarket intelligence control plane that scans **≤2h, ≤6h, ≤24h, and structural/NegRisk opportunities across the active universe**, persists live evidence, runs historical replay on resolved non-political markets, exposes a clean dashboard, and keeps wallet execution non-custodial.

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


## v0.4 learning + external evidence

- Dedicated Neon Postgres history store isolated from the Recover Revenue database.
- Transactional persistence for every continuous scan, candidate observation, and event basket.
- Empirical calibration statistics: repeated observations, persistent structural edges, class score distributions, and coverage duration.
- Historical evidence is fed back into the live **attention score** only; structural opportunity math remains independent.
- Conservative finalized-outcome backfill for observed markets after Gamma reports a decisive closed 1/0 state.
- `markets.research_packet` bundles rules, live books, price regimes, trade flow, durable history, and supported external evidence.
- `markets.external_evidence` independently cross-checks supported crypto threshold questions against Coinbase + Kraken public market data.
- External evidence reports threshold distance and source divergence. It does **not** manufacture a win probability.

Additional operational endpoints:

- `GET /api/persistence-health`
- `GET /api/calibration`
- `GET /api/resolution-history`
- `GET /api/realtime-health`


## v0.5 replay + dashboard

- Unified opportunity objects across urgent, developing, 24-hour, and structural lanes.
- Strategy registry for complete-set, logical-relative-value, sports-line, maker, cross-venue, behavioral, and research signals.
- Chronological train/holdout historical replay using resolved sports, crypto, and weather markets.
- Configurable rolling historical backfill targeting up to three years by default.
- Replay reports hit rate **and** ROI, maximum drawdown, sample counts, and an execution haircut. A high win rate is not treated as sufficient evidence of profitability.
- Live dashboard at `/dashboard` with opportunities, replay metrics, deep service health, public-address wallet connection, and optional GPT research chat.
- Optional GPT analysis uses `OPENAI_API_KEY` only on the server. The key is never sent to the browser.
- Wallet connection stores only a public EVM address. Existing live-trading feature gates and wallet-signature requirements remain unchanged.

### New MCP tools

- `markets.unified_opportunities`
- `markets.historical_replay`
- `wallet.connect`

### New HTTP endpoints

- `GET /dashboard`
- `GET /health/deep`
- `GET /api/unified-opportunities?lane=urgent_2h&limit=50`
- `GET /api/historical-replay?years=3&horizon=tMinus60m&threshold=0.75`
- `POST /api/wallet/connect`
- `POST /api/gpt`

### Historical replay limits

Historical replay is a **backtest**, not model training in the sense of fine-tuning GPT. It repeatedly evaluates fixed strategy rules against historical resolved markets and keeps chronological holdout data separate to reduce look-ahead bias. Exact historical execution cannot be reconstructed from settlement prices alone, so results use a configurable execution buffer and should be treated as diagnostic rather than a promise of future returns.

### Recommended Railway history settings

```
HISTORICAL_LOOKBACK_HOURS=26280
HISTORICAL_BACKFILL_WINDOW_DAYS=30
HISTORICAL_BACKFILL_LIMIT=500
HISTORICAL_BACKFILL_RUN_MINUTES=25
HISTORICAL_BACKFILL_SECONDS=300
```
