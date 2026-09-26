# Daily Bankroll Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated multi-horizon daily-growth research, bankroll simulation, horizon-aware entry routing, capped dynamic sizing, and structural rejection diagnostics without weakening existing production safety gates.

**Architecture:** Keep the existing causal calendar walk-forward and live calibrated-entry pipeline as the trust boundary. Add focused modules for bankroll simulation and horizon routing, extend calendar research to return per-horizon policies and daily-growth scoring, then wire the paper-entry worker to consume only validated domain+horizon pairs. Structural scanning remains separate and gains stage-level diagnostics rather than looser thresholds.

**Tech Stack:** TypeScript 7, Node.js >=20, Vitest 4, PostgreSQL, Railway.

**Spec:** `docs/superpowers/specs/2026-09-26-daily-bankroll-growth-design.md`

## Global Constraints

- Preserve causal historical calibration.
- Preserve calendar walk-forward validation with untouched holdout data.
- Preserve fee-aware expected ROI, live calibrated probability, minimum live edge, and order-book fillability checks.
- Preserve domain-level production gating.
- Do not enable real-money auto-trading.
- Do not guarantee $100 -> $500/$1,000 daily.
- Do not lower hit-rate or ROI thresholds solely to increase activity.
- Dynamic sizing must be capped by configurable per-trade, aggregate exposure, and daily-loss limits.
- Structural / NegRisk thresholds are not loosened without root-cause evidence.

## Review Focus

- Candidates near two supported horizons must route once, deterministically, and never duplicate.
- Bankroll simulation must not spend unsettled capital or exceed concurrent-exposure caps.
- Settlement ordering at identical timestamps must recycle returned cash deterministically.
- Missing horizon-specific calibration must abstain rather than fall back to tMinus60m.
- Structural diagnostics must count the exact rejection stage without changing structural eligibility.

---

### Task 1: Daily bankroll simulator and sizing

**Files:**
- Create: `src/bankroll.ts`
- Create: `src/bankroll.test.ts`

**Interfaces:**
- Produces: `simulateBankroll(trades, options): BankrollSimulationResult`
- Produces: `sizeBankrollTrade(input): BankrollSizingDecision`

- [ ] Write failing tests for $100 capital exhaustion, overlapping positions, settlement recycling, daily loss cap, and capped edge-aware sizing.
- [ ] Run `npx vitest run src/bankroll.test.ts`; expected FAIL because module does not exist.
- [ ] Implement deterministic chronological bankroll accounting with no leverage, no borrowing, no martingale, and configurable limits.
- [ ] Re-run targeted tests; expected PASS.
- [ ] Run full `npm test`; expected PASS.

### Task 2: Horizon routing and independent calibration mapping

**Files:**
- Create: `src/horizon-routing.ts`
- Create: `src/horizon-routing.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: domain+horizon policy records.
- Produces: `routeCandidateToValidatedHorizon(minutesRemaining, policies, toleranceMinutes)`
- Horizon keys: `tMinus15m`, `tMinus30m`, `tMinus60m`, `tMinus120m`.

- [ ] Write failing tests for nearest-horizon selection, deterministic ties, tolerance rejection, disabled horizon rejection, and no fallback calibration.
- [ ] Run targeted test; expected FAIL.
- [ ] Implement routing helper.
- [ ] Extend production strategy policy generation so each domain contains independently validated horizon policies when historical data exists.
- [ ] Preserve the existing top-level tMinus60m compatibility field until downstream dashboard code is migrated.
- [ ] Run targeted and full tests.

### Task 3: Daily-growth calendar scoring and bankroll validation

**Files:**
- Modify: `src/backtest.ts`
- Modify/create relevant `src/*.test.ts`

**Interfaces:**
- Consumes: existing `DailyPnlSummary` and bankroll simulator.
- Produces: daily-growth diagnostics in calendar policy results.
- Produces configurable score weights and score components.

- [ ] Add failing tests proving a lower aggregate-ROI policy can beat a higher aggregate-ROI policy only when it has superior median daily growth / drawdown-adjusted consistency.
- [ ] Add failing tests that losing-day concentration and max drawdown reduce the score.
- [ ] Implement score components from median/average daily return, profitable-day percentage, trade activity, fold consistency, worst-day loss, drawdown and concurrency.
- [ ] Run a $100 chronological bankroll simulation for selected holdout policies and expose end-bankroll and daily metrics.
- [ ] Preserve all hard performance gates before scoring.
- [ ] Run targeted and full tests.

### Task 4: Replace fixed 45-75m paper-entry window

**Files:**
- Modify: `src/server.ts`
- Modify/create server policy tests if available.

**Interfaces:**
- Consumes: `routeCandidateToValidatedHorizon`, horizon-specific selected policy, `sizeBankrollTrade`.
- Produces: horizon-tagged paper trades and rejection diagnostics.

- [ ] Add a failing regression test proving a valid 30m or 120m candidate is no longer rejected solely because it is outside 45-75m.
- [ ] Remove the fixed 45-75m condition from paper entry.
- [ ] Route each candidate to one validated domain+horizon policy.
- [ ] Query horizon-specific live calibration using the routed horizon.
- [ ] Keep market-shape, domain, holdout, edge, fee, liquidity and live-calibration gates unchanged.
- [ ] Store routed horizon in strategy ID and policy snapshot.
- [ ] Keep dynamic stake sizing disabled by default behind a shadow-only environment flag.
- [ ] Run targeted and full tests.

### Task 5: Structural / NegRisk zero-output diagnostics

**Files:**
- Modify: `src/scanner.ts`
- Modify: `src/server.ts`
- Modify/create scanner tests.

**Interfaces:**
- Produces: stage counters for discovery, grouping, complement math, stale filtering, fee/buffer rejection, depth rejection, NegRisk metadata rejection, and executable structural output.

- [ ] Write failing tests that known synthetic structural opportunities increment executable counters and rejected examples increment the exact rejection counter.
- [ ] Instrument the structural scan without changing thresholds.
- [ ] Surface counters in `multi_horizon_scan` logs and diagnostics API/dashboard payloads.
- [ ] Run targeted and full tests.

### Task 6: Dashboard / diagnostics and production verification

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `src/server.ts`
- Modify documentation if required.

**Interfaces:**
- Consumes: new per-horizon policies, bankroll simulation, and structural diagnostics.
- Produces: production-readiness visibility for daily-growth metrics.

- [ ] Surface production-enabled domain+horizon pairs, median daily ROI, profitable-day %, worst day, drawdown, $100 bankroll result, rotations/day, and structural rejection counts.
- [ ] Run `npm run verify`; expected typecheck, tests and build all PASS.
- [ ] Deploy active Railway services: production, scanner, streams, history, maintenance.
- [ ] Inspect fresh logs and upstream self-tests.
- [ ] Confirm entry diagnostics show horizon routing instead of a fixed entry window.
- [ ] Confirm no duplicate paper entries and no real-money execution enablement.
