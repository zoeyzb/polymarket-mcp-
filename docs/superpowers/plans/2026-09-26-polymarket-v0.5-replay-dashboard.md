# Polymarket v0.5 Replay + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-year historical replay/backtest pipeline, unified opportunity objects, standardized strategy detectors, a live dashboard with wallet connect, and optional GPT analysis without weakening existing non-custodial trading safeguards.

**Architecture:** Keep the existing five-service Railway topology. The scanner remains the producer of live market state; history backfills resolved non-political samples in rolling windows; replay evaluates simple probability-threshold strategies on chronological train/holdout splits; the API exposes unified opportunity and replay endpoints; the dashboard consumes only API endpoints and never receives server secrets.

**Tech Stack:** TypeScript, Node 20+, Vitest, MCP Streamable HTTP, Postgres/Neon, Railway, browser-injected EVM wallet, optional OpenAI Responses API.

**Spec:** User request in ChatGPT project conversation, 2026-09-26.

## Global Constraints

- Preserve political markets as structural-only; do not add directional political predictions.
- Do not store seed phrases or raw private keys.
- A wallet connection may persist only public address/config metadata.
- Historical replay must separate chronological training and holdout samples.
- Do not optimize for hit rate alone; report return, drawdown, sample size, and calibration limitations.
- Live order submission stays behind existing feature gates and user-wallet signatures.
- Existing MCP tools and REST endpoints remain backward compatible.

## Review Focus

- Empty/small historical samples return stable zero-trade results rather than NaN.
- Very high thresholds can show high hit rate but negative expected return; UI must display both.
- Political samples remain excluded from replay via the existing historical classifier.
- Dashboard never exposes OPENAI_API_KEY or wallet secrets.
- Wallet connect rejects malformed/non-EVM addresses and never silently enables live submission.

---

### Task 1: Replay engine

**Files:**
- Create: `src/backtest.ts`
- Test: `src/backtest.test.ts`

**Interfaces:**
- Consumes: resolved historical calibration rows.
- Produces: `runProbabilityThresholdBacktest()` and `sweepProbabilityThresholds()`.

- [ ] Write failing tests for chronological train/holdout split, PnL math, and empty samples.
- [ ] Implement minimal replay engine.
- [ ] Verify tests.

### Task 2: Unified opportunity + strategy registry

**Files:**
- Create: `src/strategy-registry.ts`
- Create: `src/opportunity-object.ts`
- Test: `src/opportunity-object.test.ts`

**Interfaces:**
- Consumes: `ScanCandidate`.
- Produces: stable `UnifiedOpportunity` with economics, evidence, strategies, risks, and lane.

- [ ] Write failing tests for structural and research candidates.
- [ ] Implement registry and builder.
- [ ] Verify tests.

### Task 3: Historical access + wallet metadata

**Files:**
- Modify: `src/persistence.ts`

**Interfaces:**
- Produces: `getHistoricalReplaySamples()` and `upsertWalletProfileAddress()`.

- [ ] Add query helpers using existing tables only.
- [ ] Preserve wallet disabled state by default on first connect.

### Task 4: API/MCP + backfill worker

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Adds MCP tools: `markets.unified_opportunities`, `markets.historical_replay`, `wallet.connect`.
- Adds REST: `/api/unified-opportunities`, `/api/historical-replay`, `/api/wallet/connect`, `/api/gpt`, `/health/deep`, `/dashboard`.

- [ ] Expand historical worker from short recent lookback to rolling configurable multi-year windows.
- [ ] Add chronological replay endpoint.
- [ ] Add optional server-side GPT endpoint that uses OPENAI_API_KEY only when configured.
- [ ] Add public-address-only wallet connection.
- [ ] Keep existing signing gates unchanged.

### Task 5: Dashboard

**Files:**
- Create: `src/dashboard.ts`
- Test: `src/dashboard.test.ts`

**Interfaces:**
- Produces: `renderDashboardHtml()`.

- [ ] Render live opportunity lanes, structural edges, historical replay metrics, wallet connection, and GPT chat.
- [ ] Fetch only server APIs.
- [ ] Verify required sections and no secret interpolation.

### Task 6: Documentation + CI

**Files:**
- Modify: `README.md`
- Modify: `.github/workflows/verify.yml`
- Modify: `package.json`

- [ ] Document v0.5 architecture and limitations.
- [ ] Run verification on pull requests as well as main pushes.
- [ ] Bump version to 0.5.0.

### Task 7: Railway rollout

- [ ] Merge after CI passes.
- [ ] Confirm five active production roles remain healthy.
- [ ] Set multi-year history environment variables.
- [ ] Verify deployment SUCCESS and `/health/deep`.
- [ ] Leave retired sleeping services untouched unless separately confirmed for deletion.
