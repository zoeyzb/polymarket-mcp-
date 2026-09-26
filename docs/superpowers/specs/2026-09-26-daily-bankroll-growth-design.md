# Daily Bankroll Growth Architecture

Date: 2026-09-26
Repository: zoeyzb/polymarket-mcp-

## Objective

Reorient the existing Polymarket strategy system toward validated same-day bankroll growth rather than aggregate or long-horizon headline ROI.

The system should maximize repeatable daily capital growth from a small bankroll while preserving the strongest existing safety and validation mechanisms. A scenario such as $100 -> $500 or $1,000 in one day is treated as an upside capacity scenario, never as a guaranteed or required outcome.

## Existing Strengths To Preserve

- Causal historical calibration.
- Calendar walk-forward validation with untouched holdout data.
- Abstention-aware sparse calendar folds.
- Domain-level production gating.
- Fee-aware expected ROI.
- Live calibrated win-probability checks.
- Minimum live edge requirements.
- Order-book fillability and liquidity checks.
- Structural / NegRisk opportunity detection.
- Separation of research validation, shadow paper trading, and production execution.
- Conservative refusal to enable a directional domain unless it passes production gates.

## Problems Found

### 1. Entry starvation

The paper-entry worker currently consumes only the urgent2h lane and then restricts directional entries to 45-75 minutes before resolution.

A live diagnostic run showed:
- 306 urgent candidates.
- 242 rejected only for outside_entry_window.
- 56 rejected because crypto was disabled.
- 8 rejected because other was disabled.
- 0 candidates reached a live production entry.

The fixed 45-75 minute window therefore starves the strong live-calibration and edge checks.

### 2. Policy selection is not optimized for daily bankroll growth

The current calendar policy score is:

    minRoi * sqrt(totalTrades) + avgRoi

This rewards stable aggregate ROI and sample count, but does not directly optimize:
- median daily ROI;
- profitable-day percentage;
- same-day capital turnover;
- number of independent bankroll rotations;
- peak concurrent capital;
- daily drawdown;
- worst-day loss;
- geometric bankroll growth.

### 3. Capacity reporting is not a bankroll simulation

The existing daily-capacity estimator converts validated ROI into required turnover for target PnL. That is useful as a liquidity upper bound, but it does not model a real $100 bankroll recycling capital after settlements.

### 4. Structural opportunity flow is currently empty

Recent production scans report:
- structuralBinary = 0
- structuralEventBaskets = 0
- executableStructural = 0

This path must be audited independently. It should not be weakened merely to increase counts.

## Architecture

### A. Multi-horizon directional research

Directional policy research will support independently validated entry horizons rather than a single tMinus60m assumption.

Initial research horizons:
- tMinus15m
- tMinus30m
- tMinus60m
- tMinus120m

A horizon is only eligible for shadow/production use when enough causal samples exist.

Each horizon/domain pair receives its own:
- causal calibration;
- walk-forward folds;
- holdout;
- daily performance summary;
- minimum edge;
- threshold;
- live calibration requirement;
- production-enabled flag.

No horizon inherits another horizon's validation.

### B. Daily-growth policy objective

A policy must continue to pass hard gates before scoring:

Hard gates:
- minimum holdout trades;
- minimum fold ROI;
- minimum holdout ROI;
- minimum fold hit rate;
- minimum holdout hit rate;
- minimum active days;
- minimum profitable-day percentage;
- sufficient causal calibration samples;
- positive fee-aware expected live ROI.

Among policies that pass, selection should favor robust daily growth.

The score will reward:
- median daily return;
- profitable-day percentage;
- average daily return;
- daily trade count;
- capital turnover potential;
- consistency across evaluable folds.

The score will penalize:
- worst-day loss;
- maximum drawdown;
- excessive concurrency;
- concentration in too few days;
- unstable fold performance.

The exact weights must be configurable and surfaced in policy diagnostics.

### C. Entry horizon routing

The entry worker will stop using a single hardcoded 45-75 minute window.

Instead:
1. Take current candidates from all relevant short-horizon lanes.
2. Determine candidate minutes-to-resolution.
3. Map the candidate to the nearest validated production horizon within a configured tolerance.
4. Load that domain+horizon's selected policy.
5. Apply existing market shape, production domain, holdout, threshold, order-book, live calibration, edge, fee and expected ROI checks.
6. Enter only when all gates pass.

Default tolerance must be conservative and configurable.

Candidates must not be duplicated across horizons.

### D. Bankroll simulator

Add a deterministic bankroll simulation layer for validated historical trades.

Required starting bankroll scenarios:
- $100
- $500
- $1,000

The $100 path is the primary small-bankroll scenario.

The simulator must process trades chronologically and model:
- cash available;
- stake allocation;
- overlapping positions;
- settlement times;
- returned principal;
- realized PnL;
- capital recycling;
- concurrent exposure;
- daily opening and closing bankroll;
- daily return;
- drawdown;
- trade rejection when insufficient bankroll exists.

It must not assume unlimited capital.

Required outputs:
- start bankroll;
- end bankroll;
- daily growth percentage;
- trades entered;
- trades skipped for insufficient capital;
- bankroll rotations;
- peak capital deployed;
- peak concurrent exposure;
- worst intraday drawdown;
- worst daily return;
- median daily return;
- profitable-day percentage.

### E. Risk-aware dynamic sizing

Do not use a fixed $25 stake when evaluating what a $100 bankroll can do.

Sizing must be bankroll-aware and capped.

Initial model:
- fractional risk allocation based on validated edge;
- hard maximum percentage of bankroll per trade;
- hard maximum aggregate concurrent exposure;
- hard daily loss limit;
- no martingale;
- no loss-chasing;
- no leverage assumption;
- no borrowed-capital assumption.

Dynamic sizing must be tested in paper simulation before any live execution path uses it.

### F. Structural / NegRisk audit

Audit the structural scanner separately.

The audit must identify why all three current structural counters are zero:
- source-market discovery;
- event grouping;
- complementary outcome math;
- fee/buffer logic;
- order-book depth;
- NegRisk metadata;
- stale market filtering;
- execution filters.

No structural threshold is lowered until the root cause is demonstrated with diagnostics.

### G. Production rollout

Rollout stages:

1. Research only:
   - compute multi-horizon policies;
   - run bankroll simulations;
   - expose diagnostics.

2. Shadow paper:
   - allow only horizon/domain pairs that pass all hard gates;
   - record real order-book entry prices and fillability;
   - compare simulated vs observed paper results.

3. Production eligible:
   - only after sufficient shadow sample count and daily performance;
   - wallet execution remains separately gated.

This change must not automatically enable real-money auto-trading.

## Metrics

The primary dashboard/readiness metrics become:

- current production-enabled domain+horizon pairs;
- trades per active day;
- profitable-day percentage;
- median daily ROI;
- average daily ROI;
- worst daily ROI;
- maximum drawdown;
- realized paper win rate;
- realized paper ROI;
- average bankroll rotations/day;
- $100 bankroll median end-of-day balance;
- $100 bankroll worst end-of-day balance;
- $100 bankroll best end-of-day balance;
- $100 bankroll distribution across validated historical days;
- fillable daily turnover;
- structural executable opportunity count.

Aggregate ROI remains visible but is not the primary success metric.

## Acceptance Criteria

1. The entry worker no longer has a single fixed 45-75 minute eligibility window.
2. At least four research horizons are supported independently when data exists.
3. No horizon can trade using another horizon's calibration.
4. Current calendar walk-forward, causal, fee, edge, liquidity and domain gates remain active.
5. Passing policy selection includes daily return and drawdown information.
6. A deterministic $100 bankroll simulation exists and rejects trades when cash is unavailable.
7. Bankroll simulation supports overlapping trades and capital recycling.
8. Dynamic sizing is capped by configurable per-trade and concurrent-exposure limits.
9. Live/paper code cannot use dynamic sizing until the shadow gate permits it.
10. Structural zero-output diagnostics identify the exact rejection stage.
11. Tests cover horizon routing, bankroll accounting, capital exhaustion, overlapping trades, settlement recycling, daily loss caps and duplicate prevention.
12. Existing test suite remains green.
13. Railway production, scanner, streams, history and maintenance services deploy successfully.
14. Production diagnostics expose the new daily-growth and horizon metrics.
15. No code or dashboard claims that $100 -> $500/$1,000 daily is guaranteed.

## Non-Goals

- Guaranteeing daily profit.
- Forcing a minimum number of trades.
- Lowering hit-rate or ROI thresholds solely to increase activity.
- Enabling disabled domains without independent validation.
- Enabling real-money wallet execution as part of this change.
- Treating backtest turnover upper bounds as forecasts.

## Verification

Before completion:
- run targeted unit tests for every new module;
- run the full repository test suite;
- build the project;
- deploy the five active Railway services;
- inspect fresh runtime logs;
- verify production strategy diagnostics;
- confirm no duplicate shadow entries;
- confirm live upstream Polymarket self-tests remain healthy;
- confirm the system still abstains when no validated opportunity exists.
