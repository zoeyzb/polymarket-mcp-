# Market Family Paper Lab

Goal: maximize evidence-backed daily paper performance from a small bankroll by validating market families independently instead of treating every sports/crypto/weather/other market as interchangeable.

Families:
- sports_moneyline
- sports_spread
- sports_total
- sports_team_total
- sports_player_prop
- sports_threshold
- sports_score_band
- sports_period
- sports_other
- crypto_threshold
- weather_threshold
- other_threshold
- binary_other
- multi_outcome

Rules:
- Production-shadow trades require family-specific validation plus all existing causal/calendar/live-edge/liquidity gates.
- Research-shadow may paper-test unvalidated families but is permanently non-executable and reported separately.
- Multi-outcome markets are research-only until outcome-specific causal calibration exists.
- A resolved condition may contribute at most one portfolio trade per strategy lane per day.
- Daily paper portfolio starts at $100, never borrows, never martingales, recycles settled cash, enforces per-trade and concurrent exposure caps, and reports end balance/drawdown/win rate.
- Policy scoring continues to require >=95% holdout hit rate; ranking rewards higher hit rate after the hard floor.
- No target such as $100->$500/$1000 is guaranteed. Report whether historical/paper paths actually reached those levels and at what drawdown.
