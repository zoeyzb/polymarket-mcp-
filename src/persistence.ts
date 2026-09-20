import pg from "pg";
import type { ScanResult } from "./types.js";
import type { RealtimeQuote } from "./realtime.js";
import type { SportsFeedEvent } from "./sports.js";
import type { HistoricalCalibrationSample } from "./historical-calibration.js";
import { isPoliticalCandidate } from "./domain-policy.js";
import type { WalletIntelligenceProfile } from "./wallet-intelligence.js";

const { Pool } = pg;

const DATABASE_URL = process.env.POLYMARKET_DATABASE_URL || "";
const QUERY_TIMEOUT_MS = Math.max(1000, Number(process.env.PERSISTENCE_TIMEOUT_MS || 8000));
const WRITER_ID =
  process.env.POLYMARKET_WRITER_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  "polymarket-writer";
const WRITER_LEASE_SECONDS = Math.max(35, Number(process.env.POLYMARKET_WRITER_LEASE_SECONDS || 45));

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: Math.max(1, Math.min(10, Number(process.env.PERSISTENCE_POOL_MAX || 3))),
      connectionTimeoutMillis: QUERY_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: false,
      ssl: { rejectUnauthorized: false }
    })
  : null;

function configured() {
  return Boolean(pool);
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function claimWriterLease(client: pg.PoolClient) {
  const { rows } = await client.query<{ holder: string }>(
    `insert into polymarket_brain.writer_lease (
       lease_name, holder, lease_until, updated_at
     ) values ('scan-writer', $1, now() + ($2 || ' seconds')::interval, now())
     on conflict (lease_name) do update set
       holder = excluded.holder,
       lease_until = excluded.lease_until,
       updated_at = now()
     where polymarket_brain.writer_lease.lease_until < now()
        or polymarket_brain.writer_lease.holder = excluded.holder
     returning holder`,
    [WRITER_ID, WRITER_LEASE_SECONDS]
  );
  return rows[0]?.holder === WRITER_ID;
}

export async function persistScan(scan: ScanResult) {
  if (!pool) return { ok: false, configured: false, reason: "not_configured" };

  const client = await pool.connect();
  try {
    await client.query(`set statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
    await client.query("begin");

    const hasWriterLease = await claimWriterLease(client);
    if (!hasWriterLease) {
      await client.query("rollback");
      return {
        ok: false,
        configured: true,
        skipped: true,
        reason: "writer_lease_held_elsewhere",
        writerId: WRITER_ID
      };
    }

    const executableCount =
      scan.candidates.filter(candidate => candidate.opportunityClass === "executable_structural").length +
      (scan.eventBaskets || []).filter(basket => basket.bestNetProfitUsd > 0).length;

    const topOpportunityScore = scan.candidates.reduce<number | null>(
      (best, candidate) => best === null ? candidate.opportunityScore : Math.max(best, candidate.opportunityScore),
      null
    );

    const scanInsert = await client.query<{ id: string }>(
      `insert into polymarket_brain.scans (
        generated_at, max_minutes, active_markets, in_window, returned,
        scan_duration_ms, executable_count, top_opportunity_score, payload, writer_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      returning id`,
      [
        scan.generatedAt,
        scan.maxMinutes,
        scan.totalActiveMarketsScanned,
        scan.totalInWindowBeforeFilters,
        scan.returned,
        scan.scanDurationMs ?? null,
        executableCount,
        topOpportunityScore,
        JSON.stringify(scan),
        WRITER_ID
      ]
    );

    const scanId = scanInsert.rows[0].id;

    for (const candidate of scan.candidates) {
      await client.query(
        `insert into polymarket_brain.candidates (
          scan_id, generated_at, market_id, condition_id, slug, question, end_date,
          minutes_remaining, opportunity_class, opportunity_score, attention_score,
          rapid_review_score, liquidity_usd, volume_24h_usd, best_net_profit_usd,
          best_net_roi_pct, flags, price_regime, trade_flow, payload
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
          $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb
        )`,
        [
          scanId,
          scan.generatedAt,
          candidate.id,
          candidate.conditionId,
          candidate.slug,
          candidate.question,
          candidate.endDate,
          candidate.minutesRemaining,
          candidate.opportunityClass,
          candidate.opportunityScore,
          candidate.attentionScore ?? null,
          candidate.rapidReviewScore,
          candidate.liquidityUsd,
          candidate.volume24hUsd,
          candidate.binaryArbitrage?.bestNetProfitUsd ?? null,
          candidate.binaryArbitrage?.bestNetRoiPct ?? null,
          JSON.stringify(candidate.flags || []),
          JSON.stringify(candidate.marketSignals?.priceRegime ?? null),
          JSON.stringify(candidate.marketSignals?.tradeFlow ?? null),
          JSON.stringify(candidate)
        ]
      );
    }

    for (const basket of scan.eventBaskets || []) {
      await client.query(
        `insert into polymarket_brain.event_baskets (
          scan_id, generated_at, event_id, event_title, market_count,
          best_net_profit_usd, best_net_roi_pct, best_budget_usd, payload
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          scanId,
          scan.generatedAt,
          basket.eventId,
          basket.eventTitle,
          basket.marketCount,
          basket.bestNetProfitUsd,
          basket.bestNetRoiPct,
          basket.bestBudgetUsd,
          JSON.stringify(basket)
        ]
      );
    }

    await client.query("commit");
    return {
      ok: true,
      configured: true,
      scanId,
      candidates: scan.candidates.length,
      eventBaskets: scan.eventBaskets?.length ?? 0,
      writerId: WRITER_ID
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function persistRealtimeQuotes(quotes: RealtimeQuote[]) {
  if (!pool) return { configured: false, reason: "not_configured", inserted: 0 };
  if (!quotes.length) return { configured: true, inserted: 0 };

  const payload = quotes.slice(0, 2000).map(quote => ({
    observed_at: quote.updatedAt,
    token_id: quote.tokenId,
    best_bid: quote.bestBid,
    best_ask: quote.bestAsk,
    spread: quote.spread,
    last_trade_price: quote.lastTradePrice,
    last_trade_side: quote.lastTradeSide,
    event_type: quote.eventType,
    payload: quote
  }));

  const { rowCount } = await pool.query(
    `insert into polymarket_brain.realtime_quotes (
       observed_at, token_id, best_bid, best_ask, spread,
       last_trade_price, last_trade_side, event_type, payload
     )
     select
       x.observed_at::timestamptz,
       x.token_id,
       x.best_bid,
       x.best_ask,
       x.spread,
       x.last_trade_price,
       x.last_trade_side,
       x.event_type,
       x.payload
     from jsonb_to_recordset($1::jsonb) as x(
       observed_at text,
       token_id text,
       best_bid numeric,
       best_ask numeric,
       spread numeric,
       last_trade_price numeric,
       last_trade_side text,
       event_type text,
       payload jsonb
     )
     on conflict (token_id, observed_at) do nothing`,
    [JSON.stringify(payload)]
  );

  return { configured: true, inserted: rowCount ?? 0 };
}

export async function persistSportsEvents(events: SportsFeedEvent[]) {
  if (!pool) return { configured: false, reason: "not_configured", inserted: 0 };
  if (!events.length) return { configured: true, inserted: 0 };

  const payload = events.slice(0, 2000).map(event => ({
    received_at: event.receivedAt,
    payload: event.payload
  }));

  const { rowCount } = await pool.query(
    `insert into polymarket_brain.sports_events (received_at, payload)
     select x.received_at::timestamptz, x.payload
     from jsonb_to_recordset($1::jsonb) as x(
       received_at text,
       payload jsonb
     )`,
    [JSON.stringify(payload)]
  );

  return { configured: true, inserted: rowCount ?? 0 };
}

export async function compactRealtimeQuotes(minutesBack = 180) {
  if (!pool) return { configured: false, reason: "not_configured", barsUpserted: 0 };

  const boundedMinutes = Math.max(2, Math.min(1440, minutesBack));
  const { rowCount } = await pool.query(
    `with raw as (
       select
         token_id,
         date_trunc('minute', observed_at) as minute,
         observed_at,
         case
           when best_bid is not null and best_ask is not null
           then (best_bid + best_ask) / 2.0
           else coalesce(last_trade_price, best_bid, best_ask)
         end as mid,
         spread
       from polymarket_brain.realtime_quotes
       where observed_at >= now() - ($1 || ' minutes')::interval
     ),
     grouped as (
       select
         token_id,
         minute,
         (array_agg(mid order by observed_at asc) filter (where mid is not null))[1] as open_mid,
         max(mid) as high_mid,
         min(mid) as low_mid,
         (array_agg(mid order by observed_at desc) filter (where mid is not null))[1] as close_mid,
         avg(spread) filter (where spread is not null) as avg_spread,
         min(spread) filter (where spread is not null) as min_spread,
         max(spread) filter (where spread is not null) as max_spread,
         count(*)::int as sample_count,
         min(observed_at) as first_observed_at,
         max(observed_at) as last_observed_at
       from raw
       group by token_id, minute
     )
     insert into polymarket_brain.quote_bars_1m (
       token_id, minute, open_mid, high_mid, low_mid, close_mid,
       avg_spread, min_spread, max_spread, sample_count,
       first_observed_at, last_observed_at, updated_at
     )
     select
       token_id, minute, open_mid, high_mid, low_mid, close_mid,
       avg_spread, min_spread, max_spread, sample_count,
       first_observed_at, last_observed_at, now()
     from grouped
     on conflict (token_id, minute) do update set
       open_mid = excluded.open_mid,
       high_mid = excluded.high_mid,
       low_mid = excluded.low_mid,
       close_mid = excluded.close_mid,
       avg_spread = excluded.avg_spread,
       min_spread = excluded.min_spread,
       max_spread = excluded.max_spread,
       sample_count = excluded.sample_count,
       first_observed_at = excluded.first_observed_at,
       last_observed_at = excluded.last_observed_at,
       updated_at = now()`,
    [boundedMinutes]
  );

  return {
    configured: true,
    minutesBack: boundedMinutes,
    barsUpserted: rowCount ?? 0
  };
}

export async function cleanupRawStreams(
  quoteRetentionHours = 72,
  sportsRetentionDays = 30
) {
  if (!pool) return { configured: false, reason: "not_configured" };

  const quoteHours = Math.max(24, Math.min(720, quoteRetentionHours));
  const sportDays = Math.max(7, Math.min(365, sportsRetentionDays));
  const startedAt = new Date().toISOString();

  const run = await pool.query<{ id: string }>(
    `insert into polymarket_brain.maintenance_runs (job, started_at, details)
     values ('raw_stream_cleanup', now(), $1::jsonb)
     returning id`,
    [JSON.stringify({ quoteRetentionHours: quoteHours, sportsRetentionDays: sportDays })]
  );
  const runId = run.rows[0]?.id ?? null;

  try {
    const quoteDelete = await pool.query(
      `delete from polymarket_brain.realtime_quotes rq
       using polymarket_brain.quote_bars_1m bar
       where rq.token_id = bar.token_id
         and date_trunc('minute', rq.observed_at) = bar.minute
         and rq.observed_at < now() - ($1 || ' hours')::interval`,
      [quoteHours]
    );

    const sportsDelete = await pool.query(
      `delete from polymarket_brain.sports_events
       where received_at < now() - ($1 || ' days')::interval`,
      [sportDays]
    );

    const result = {
      configured: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      quoteRetentionHours: quoteHours,
      sportsRetentionDays: sportDays,
      deletedRealtimeQuotes: quoteDelete.rowCount ?? 0,
      deletedSportsEvents: sportsDelete.rowCount ?? 0
    };

    if (runId) {
      await pool.query(
        `update polymarket_brain.maintenance_runs
         set finished_at = now(), details = details || $2::jsonb
         where id = $1`,
        [runId, JSON.stringify(result)]
      );
    }

    return result;
  } catch (error) {
    if (runId) {
      await pool.query(
        `update polymarket_brain.maintenance_runs
         set finished_at = now(), details = details || $2::jsonb
         where id = $1`,
        [runId, JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })]
      ).catch(() => {});
    }
    throw error;
  }
}

export async function getMaintenanceStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(`
    select
      count(*)::int as "runs",
      max(finished_at) as "lastFinishedAt",
      coalesce(sum((details->>'deletedRealtimeQuotes')::int)
        filter (where details ? 'deletedRealtimeQuotes'), 0)::int as "deletedRealtimeQuotes",
      coalesce(sum((details->>'deletedSportsEvents')::int)
        filter (where details ? 'deletedSportsEvents'), 0)::int as "deletedSportsEvents"
    from polymarket_brain.maintenance_runs
    where job = 'raw_stream_cleanup'
  `);
  return { configured: true, ...rows[0] };
}

export async function replaceRealtimeTargets(
  tokenIds: string[],
  source = "multi_horizon_scanner",
  ttlSeconds = 180
) {
  if (!pool) return { configured: false, reason: "not_configured", targets: 0 };

  const unique = [...new Set(tokenIds.filter(Boolean))].slice(0, 10000);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from polymarket_brain.realtime_targets where source = $1`,
      [source]
    );

    if (unique.length) {
      const payload = unique.map(tokenId => ({
        token_id: tokenId,
        source,
        desired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + Math.max(60, ttlSeconds) * 1000).toISOString(),
        metadata: {}
      }));
      await client.query(
        `insert into polymarket_brain.realtime_targets (
           token_id, source, desired_at, expires_at, metadata
         )
         select
           x.token_id,
           x.source,
           x.desired_at::timestamptz,
           x.expires_at::timestamptz,
           x.metadata
         from jsonb_to_recordset($1::jsonb) as x(
           token_id text,
           source text,
           desired_at text,
           expires_at text,
           metadata jsonb
         )
         on conflict (token_id) do update set
           source = excluded.source,
           desired_at = excluded.desired_at,
           expires_at = excluded.expires_at,
           metadata = excluded.metadata`,
        [JSON.stringify(payload)]
      );
    }

    await client.query("commit");
    return { configured: true, targets: unique.length, source };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getRealtimeTargets() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `select token_id
     from polymarket_brain.realtime_targets
     where expires_at > now()
     order by token_id`
  );
  return rows.map(row => String(row.token_id));
}

export async function getRealtimeTargetStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(`
    select
      count(*) filter (where expires_at > now())::int as "activeTargets",
      count(*)::int as "storedTargets",
      min(desired_at) filter (where expires_at > now()) as "oldestDesiredAt",
      max(desired_at) filter (where expires_at > now()) as "newestDesiredAt",
      max(expires_at) filter (where expires_at > now()) as "latestExpiry"
    from polymarket_brain.realtime_targets
  `);
  return { configured: true, ...rows[0] };
}

export async function getStreamPersistenceStats() {
  if (!pool) return { configured: false, reason: "not_configured" };

  const { rows } = await pool.query(`
    select
      (select count(*)::int from polymarket_brain.realtime_quotes) as "realtimeQuoteRows",
      (select max(observed_at) from polymarket_brain.realtime_quotes) as "lastRealtimeQuoteAt",
      (select count(*)::int from polymarket_brain.sports_events) as "sportsEventRows",
      (select max(received_at) from polymarket_brain.sports_events) as "lastSportsEventAt",
      (select count(*)::int from polymarket_brain.quote_bars_1m) as "quoteBarRows",
      (select max(minute) from polymarket_brain.quote_bars_1m) as "lastQuoteBarMinute"
  `);

  const row = rows[0] || {};
  return {
    configured: true,
    realtimeQuoteRows: Number(row.realtimeQuoteRows || 0),
    lastRealtimeQuoteAt: row.lastRealtimeQuoteAt
      ? new Date(row.lastRealtimeQuoteAt).toISOString()
      : null,
    sportsEventRows: Number(row.sportsEventRows || 0),
    lastSportsEventAt: row.lastSportsEventAt
      ? new Date(row.lastSportsEventAt).toISOString()
      : null,
    quoteBarRows: Number(row.quoteBarRows || 0),
    lastQuoteBarMinute: row.lastQuoteBarMinute
      ? new Date(row.lastQuoteBarMinute).toISOString()
      : null
  };
}

type AlertSpec = {
  alertType: string;
  severity: "high" | "medium" | "low";
  details: Record<string, unknown>;
};

function alertsForCandidate(candidate: ScanResult["candidates"][number]): AlertSpec[] {
  const alerts: AlertSpec[] = [];
  const politicalStructuralOnly = isPoliticalCandidate(candidate);

  if (candidate.opportunityClass === "executable_structural") {
    alerts.push({
      alertType: "executable_structural",
      severity: "high",
      details: {
        bestNetProfitUsd: candidate.binaryArbitrage?.bestNetProfitUsd ?? null,
        bestNetRoiPct: candidate.binaryArbitrage?.bestNetRoiPct ?? null
      }
    });
  } else if (candidate.opportunityClass === "top_book_structural_only") {
    alerts.push({
      alertType: "top_book_structural_only",
      severity: "medium",
      details: {
        note: "Top-book structural edge is not depth-verified."
      }
    });
  }

  const flagMap: Record<string, { alertType: string; severity: "high" | "medium" | "low" }> = {
    price_shock: { alertType: "price_shock", severity: "high" },
    high_price_volatility: { alertType: "high_price_volatility", severity: "medium" },
    near_external_resolution_threshold: { alertType: "near_external_resolution_threshold", severity: "high" },
    strong_recent_trade_imbalance: { alertType: "strong_recent_trade_imbalance", severity: "medium" },
    large_recent_trade: { alertType: "large_recent_trade", severity: "medium" },
    external_source_divergence: { alertType: "external_source_divergence", severity: "low" }
  };

  if (politicalStructuralOnly) return alerts;

  for (const flag of candidate.flags || []) {
    const mapped = flagMap[flag];
    if (!mapped) continue;
    alerts.push({
      ...mapped,
      details: {
        flag,
        priceRegime: candidate.marketSignals?.priceRegime ?? null,
        tradeFlow: candidate.marketSignals?.tradeFlow ?? null,
        externalEvidence: candidate.externalEvidence ?? null,
        historicalEvidence: candidate.historicalEvidence ?? null
      }
    });
  }

  return alerts;
}

export async function persistAlertsFromScan(scan: ScanResult) {
  if (!pool) return { configured: false, reason: "not_configured", upserted: 0 };

  let upserted = 0;
  for (const candidate of scan.candidates) {
    const specs = alertsForCandidate(candidate);
    const marketKey = candidate.conditionId || candidate.id || candidate.slug;
    if (!marketKey) continue;

    for (const spec of specs) {
      const fingerprint = `${marketKey}:${spec.alertType}`;
      const result = await pool.query(
        `insert into polymarket_brain.signal_alerts (
           fingerprint, first_seen_at, last_seen_at, market_id, condition_id,
           slug, question, alert_type, severity, opportunity_class,
           opportunity_score, discovery_score, minutes_remaining, details
         ) values (
           $1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
         )
         on conflict (fingerprint) do update set
           last_seen_at = excluded.last_seen_at,
           severity = excluded.severity,
           opportunity_class = excluded.opportunity_class,
           opportunity_score = excluded.opportunity_score,
           discovery_score = excluded.discovery_score,
           minutes_remaining = excluded.minutes_remaining,
           details = excluded.details,
           occurrences = polymarket_brain.signal_alerts.occurrences + 1,
           updated_at = now()`,
        [
          fingerprint,
          scan.generatedAt,
          candidate.id,
          candidate.conditionId,
          candidate.slug,
          candidate.question,
          spec.alertType,
          spec.severity,
          candidate.opportunityClass,
          candidate.opportunityScore,
          candidate.discoveryScore ?? candidate.opportunityScore,
          candidate.minutesRemaining,
          JSON.stringify(spec.details)
        ]
      );
      upserted += result.rowCount ?? 0;
    }
  }

  return { configured: true, upserted };
}

export async function getRecentAlerts(limit = 100) {
  if (!pool) return [];
  const bounded = Math.max(1, Math.min(500, limit));
  const { rows } = await pool.query(
    `select
       id, fingerprint, first_seen_at as "firstSeenAt", last_seen_at as "lastSeenAt",
       market_id as "marketId", condition_id as "conditionId", slug, question,
       alert_type as "alertType", severity, opportunity_class as "opportunityClass",
       opportunity_score::float8 as "opportunityScore",
       discovery_score::float8 as "discoveryScore",
       minutes_remaining::float8 as "minutesRemaining",
       details, occurrences
     from polymarket_brain.signal_alerts
     order by last_seen_at desc
     limit $1`,
    [bounded]
  );
  return rows;
}

export async function getAlertStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(`
    select
      count(*)::int as "uniqueAlerts",
      count(*) filter (where last_seen_at > now() - interval '10 minutes')::int as "activeLast10m",
      coalesce(sum(occurrences),0)::int as "totalOccurrences",
      max(last_seen_at) as "lastAlertAt"
    from polymarket_brain.signal_alerts
  `);
  return { configured: true, ...rows[0] };
}

export async function getKnownHistoricalCalibrationIds(conditionIds: string[]) {
  const known = new Set<string>();
  if (!pool || conditionIds.length === 0) return known;

  const unique = [...new Set(conditionIds.filter(Boolean))].slice(0, 2000);
  const { rows } = await pool.query(
    `select condition_id
     from polymarket_brain.historical_calibration
     where condition_id = any($1::text[])`,
    [unique]
  );

  for (const row of rows) known.add(String(row.condition_id));
  return known;
}

export async function upsertHistoricalCalibrationSample(sample: HistoricalCalibrationSample) {
  if (!pool) return { configured: false, reason: "not_configured", upserted: 0 };

  const result = await pool.query(
    `insert into polymarket_brain.historical_calibration (
       condition_id, market_id, slug, question, domain, resolved_at,
       outcome0, outcome1, actual_outcome0, winning_outcome, token0_id,
       prices, brier, source_payload, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,now()
     )
     on conflict (condition_id) do update set
       market_id = excluded.market_id,
       slug = excluded.slug,
       question = excluded.question,
       domain = excluded.domain,
       resolved_at = excluded.resolved_at,
       outcome0 = excluded.outcome0,
       outcome1 = excluded.outcome1,
       actual_outcome0 = excluded.actual_outcome0,
       winning_outcome = excluded.winning_outcome,
       token0_id = excluded.token0_id,
       prices = excluded.prices,
       brier = excluded.brier,
       source_payload = excluded.source_payload,
       updated_at = now()`,
    [
      sample.conditionId,
      sample.marketId,
      sample.slug,
      sample.question,
      sample.domain,
      sample.resolvedAt,
      sample.outcome0,
      sample.outcome1,
      sample.actualOutcome0,
      sample.winningOutcome,
      sample.token0Id,
      JSON.stringify(sample.prices),
      JSON.stringify(sample.brier),
      JSON.stringify(sample.sourcePayload)
    ]
  );

  return { configured: true, upserted: result.rowCount ?? 0 };
}

export async function getHistoricalCalibrationSummary() {
  if (!pool) return { configured: false, reason: "not_configured" };

  const totals = await pool.query(`
    select
      count(*)::int as "sampleCount",
      count(*) filter (where domain='sports')::int as "sportsSamples",
      count(*) filter (where domain='crypto')::int as "cryptoSamples",
      count(*) filter (where domain='weather')::int as "weatherSamples",
      min(resolved_at) as "firstResolvedAt",
      max(resolved_at) as "lastResolvedAt"
    from polymarket_brain.historical_calibration
  `);

  const horizons = await pool.query(`
    with expanded as (
      select
        domain,
        kv.key as horizon,
        (kv.value #>> '{}')::numeric as brier
      from polymarket_brain.historical_calibration h
      cross join lateral jsonb_each(h.brier) kv
    )
    select
      domain,
      horizon,
      count(*)::int as samples,
      round(avg(brier), 6)::float8 as "meanBrier",
      round(percentile_cont(0.5) within group (order by brier)::numeric, 6)::float8 as "medianBrier"
    from expanded
    group by domain, horizon
    order by domain, horizon
  `);

  return {
    configured: true,
    ...totals.rows[0],
    horizons: horizons.rows
  };
}

export async function upsertWorkerHeartbeat(
  role: string,
  details: Record<string, unknown> = {}
) {
  if (!pool) return { configured: false, reason: "not_configured" };
  const serviceId = process.env.RAILWAY_SERVICE_ID || null;
  await pool.query(
    `insert into polymarket_brain.worker_heartbeats (role, service_id, updated_at, details)
     values ($1,$2,now(),$3::jsonb)
     on conflict (role) do update set
       service_id = excluded.service_id,
       updated_at = excluded.updated_at,
       details = excluded.details`,
    [role, serviceId, JSON.stringify(details)]
  );
  return { configured: true, role, serviceId };
}

export async function getWorkerHeartbeats() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `select role, service_id as "serviceId", updated_at as "updatedAt", details
     from polymarket_brain.worker_heartbeats
     order by role`
  );
  return rows.map(row => ({
    ...row,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null
  }));
}

export async function persistWalletIntelligenceProfiles(
  profiles: WalletIntelligenceProfile[]
) {
  if (!pool) return { configured: false, reason: "not_configured", profiles: 0, trades: 0 };
  let profileRows = 0;
  let tradeRows = 0;

  const client = await pool.connect();
  try {
    await client.query("begin");

    for (const profile of profiles) {
      const allTime = {
        allTimeEconomicPnl: profile.allTimeEconomicPnl,
        realizedMarketPnl: profile.realizedMarketPnl,
        sampledWinRate: profile.sampledWinRate,
        sampledProfitFactor: profile.sampledProfitFactor,
        scoreBreakdown: profile.scoreBreakdown,
        flags: profile.flags
      };

      const result = await client.query(
        `insert into polymarket_brain.wallet_intelligence (
           wallet_address, user_name, leaderboard_rank, leaderboard_pnl,
           leaderboard_volume, all_time_pnl, realized_market_pnl,
           maker_rebate, taker_rebate, reward_income, volume_usdc,
           trade_count, distinct_markets, biggest_win, smart_score,
           category_stats, stats, updated_at
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           $16::jsonb,$17::jsonb,now()
         )
         on conflict (wallet_address) do update set
           user_name = excluded.user_name,
           leaderboard_rank = excluded.leaderboard_rank,
           leaderboard_pnl = excluded.leaderboard_pnl,
           leaderboard_volume = excluded.leaderboard_volume,
           all_time_pnl = excluded.all_time_pnl,
           realized_market_pnl = excluded.realized_market_pnl,
           maker_rebate = excluded.maker_rebate,
           taker_rebate = excluded.taker_rebate,
           reward_income = excluded.reward_income,
           volume_usdc = excluded.volume_usdc,
           trade_count = excluded.trade_count,
           distinct_markets = excluded.distinct_markets,
           biggest_win = excluded.biggest_win,
           smart_score = excluded.smart_score,
           category_stats = excluded.category_stats,
           stats = excluded.stats,
           updated_at = now()`,
        [
          profile.walletAddress,
          profile.userName,
          profile.leaderboardRank,
          profile.leaderboardPnl,
          profile.leaderboardVolume,
          profile.allTimeEconomicPnl,
          profile.realizedMarketPnl,
          profile.makerRebate,
          profile.takerRebate,
          profile.rewardIncome,
          profile.volumeUsdc,
          profile.tradeCount,
          profile.distinctMarkets,
          profile.biggestWin,
          profile.smartScore,
          JSON.stringify(profile.categoryStats),
          JSON.stringify(allTime)
        ]
      );
      profileRows += result.rowCount ?? 0;

      for (const trade of profile.recentTrades) {
        const tx = String(trade.transaction_hash || "");
        if (!tx) continue;
        const timestamp = Number(trade.timestamp);
        const observedAt = Number.isFinite(timestamp)
          ? new Date(timestamp * 1000).toISOString()
          : new Date().toISOString();
        const size = Number(trade.size);
        const price = Number(trade.price);
        const title = String(trade.title || "");
        const slug = String(trade.slug || "");
        const category = profile.categoryStats.find(stat =>
          title.toLowerCase().includes(stat.category.replace("_", " "))
        )?.category ?? profile.dominantCategory ?? "other";

        const inserted = await client.query(
          `insert into polymarket_brain.wallet_trade_signals (
             transaction_hash, observed_at, wallet_address, condition_id,
             token_id, side, outcome, title, slug, price, size,
             notional_usdc, wallet_score, primary_category, payload
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
           )
           on conflict (transaction_hash) do nothing`,
          [
            tx,
            observedAt,
            profile.walletAddress,
            trade.condition_id ? String(trade.condition_id) : null,
            trade.token_id ? String(trade.token_id) : null,
            trade.side ? String(trade.side) : null,
            trade.outcome ? String(trade.outcome) : null,
            title || null,
            slug || null,
            Number.isFinite(price) ? price : null,
            Number.isFinite(size) ? size : null,
            Number.isFinite(size) && Number.isFinite(price) ? size * price : null,
            profile.smartScore,
            category,
            JSON.stringify(trade)
          ]
        );
        tradeRows += inserted.rowCount ?? 0;
      }
    }

    await client.query("commit");
    return { configured: true, profiles: profileRows, trades: tradeRows };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getTopWalletIntelligence(limit = 50) {
  if (!pool) return [];
  const bounded = Math.max(1, Math.min(500, limit));
  const { rows } = await pool.query(
    `select
       wallet_address as "walletAddress",
       user_name as "userName",
       leaderboard_rank as "leaderboardRank",
       leaderboard_pnl::float8 as "leaderboardPnl",
       leaderboard_volume::float8 as "leaderboardVolume",
       all_time_pnl::float8 as "allTimePnl",
       realized_market_pnl::float8 as "realizedMarketPnl",
       maker_rebate::float8 as "makerRebate",
       taker_rebate::float8 as "takerRebate",
       reward_income::float8 as "rewardIncome",
       volume_usdc::float8 as "volumeUsdc",
       trade_count::bigint as "tradeCount",
       distinct_markets as "distinctMarkets",
       biggest_win::float8 as "biggestWin",
       smart_score::float8 as "smartScore",
       category_stats as "categoryStats",
       stats,
       updated_at as "updatedAt"
     from polymarket_brain.wallet_intelligence
     order by smart_score desc, leaderboard_pnl desc
     limit $1`,
    [bounded]
  );
  return rows;
}

export async function getConditionSmartMoneySignals(
  conditionIds: string[],
  lookbackMinutes = 60
) {
  if (!pool || conditionIds.length === 0) return {};
  const unique = [...new Set(conditionIds.filter(Boolean))].slice(0, 500);
  const bounded = Math.max(5, Math.min(1440, lookbackMinutes));

  const { rows } = await pool.query(
    `select
       s.condition_id as "conditionId",
       s.wallet_address as "walletAddress",
       s.side,
       s.outcome,
       s.price::float8 as price,
       s.size::float8 as size,
       s.notional_usdc::float8 as "notionalUsd",
       s.wallet_score::float8 as "walletScore",
       s.primary_category as "primaryCategory",
       s.observed_at as "observedAt",
       w.user_name as "userName",
       w.category_stats as "categoryStats"
     from polymarket_brain.wallet_trade_signals s
     left join polymarket_brain.wallet_intelligence w
       on w.wallet_address = s.wallet_address
     where s.condition_id = any($1::text[])
       and s.observed_at >= now() - ($2 || ' minutes')::interval
     order by s.condition_id, s.observed_at desc`,
    [unique, bounded]
  );

  const grouped: Record<string, unknown[]> = {};
  for (const row of rows) {
    const key = String(row.conditionId || "");
    if (!key) continue;
    (grouped[key] ||= []).push(row);
  }
  return grouped;
}

export async function getWalletIntelligenceStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(`
    select
      count(*)::int as "wallets",
      count(*) filter (where smart_score >= 70)::int as "highScoreWallets",
      max(updated_at) as "lastProfileRefresh",
      (select count(*)::int from polymarket_brain.wallet_trade_signals) as "tradeSignals",
      (select max(observed_at) from polymarket_brain.wallet_trade_signals) as "lastTradeSignalAt"
    from polymarket_brain.wallet_intelligence
  `);
  return { configured: true, ...rows[0] };
}

export async function persistOpportunityPackets(
  generatedAt: string,
  candidates: import("./types.js").ScanCandidate[]
) {
  if (!pool) return { configured: false, reason: "not_configured", packets: 0, crossVenue: 0 };
  let packets = 0;
  let crossVenue = 0;

  const client = await pool.connect();
  try {
    await client.query("begin");

    for (const candidate of candidates) {
      if (!candidate.conditionId) continue;
      const payload = {
        structural: {
          opportunityClass: candidate.opportunityClass,
          opportunityScore: candidate.opportunityScore,
          binaryArbitrage: candidate.binaryArbitrage ?? null
        },
        makerEdge: candidate.makerEdge ?? null,
        smartMoney: candidate.smartMoney ?? null,
        crossVenue: candidate.crossVenue ?? [],
        behavior: candidate.marketSignals ?? null,
        externalEvidence: candidate.externalEvidence ?? null,
        resolutionIntelligence: candidate.resolutionIntelligence ?? null,
        historicalEvidence: candidate.historicalEvidence ?? null,
        categories: candidate.categories,
        flags: candidate.flags
      };

      const result = await client.query(
        `insert into polymarket_brain.opportunity_packets (
           generated_at, condition_id, question, primary_category,
           packet_score, payload
         ) values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (condition_id, generated_at) do update set
           packet_score = excluded.packet_score,
           payload = excluded.payload`,
        [
          generatedAt,
          candidate.conditionId,
          candidate.question,
          candidate.primaryCategory,
          candidate.opportunityPacketScore ?? candidate.discoveryScore ?? candidate.opportunityScore,
          JSON.stringify(payload)
        ]
      );
      packets += result.rowCount ?? 0;

      for (const match of candidate.crossVenue || []) {
        if (match.matchScore < 0.68) continue;
        const inserted = await client.query(
          `insert into polymarket_brain.cross_venue_matches (
             observed_at, polymarket_condition_id, polymarket_question,
             kalshi_ticker, kalshi_title, match_score, resolution_match_score,
             polymarket_yes, polymarket_no, kalshi_yes, kalshi_no,
             best_complement_cost, gross_edge, classification, details
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
           )
           on conflict (polymarket_condition_id, kalshi_ticker, observed_at) do nothing`,
          [
            generatedAt,
            candidate.conditionId,
            candidate.question,
            match.kalshiTicker,
            match.kalshiTitle,
            match.matchScore,
            match.resolutionMatchScore,
            match.polymarketYesAsk,
            match.polymarketNoAsk,
            match.kalshiYesAsk,
            match.kalshiNoAsk,
            match.bestComplementCost,
            match.grossEdge,
            match.classification,
            JSON.stringify(match)
          ]
        );
        crossVenue += inserted.rowCount ?? 0;
      }
    }

    await client.query("commit");
    return { configured: true, packets, crossVenue };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getRecentOpportunityPackets(limit = 100) {
  if (!pool) return [];
  const bounded = Math.max(1, Math.min(500, limit));
  const { rows } = await pool.query(
    `select
       generated_at as "generatedAt",
       condition_id as "conditionId",
       question,
       primary_category as "primaryCategory",
       packet_score::float8 as "packetScore",
       payload
     from polymarket_brain.opportunity_packets
     order by generated_at desc, packet_score desc
     limit $1`,
    [bounded]
  );
  return rows;
}

export async function getRecentCrossVenueMatches(limit = 100) {
  if (!pool) return [];
  const bounded = Math.max(1, Math.min(500, limit));
  const { rows } = await pool.query(
    `select
       observed_at as "observedAt",
       polymarket_condition_id as "polymarketConditionId",
       polymarket_question as "polymarketQuestion",
       kalshi_ticker as "kalshiTicker",
       kalshi_title as "kalshiTitle",
       match_score::float8 as "matchScore",
       resolution_match_score::float8 as "resolutionMatchScore",
       polymarket_yes::float8 as "polymarketYes",
       polymarket_no::float8 as "polymarketNo",
       kalshi_yes::float8 as "kalshiYes",
       kalshi_no::float8 as "kalshiNo",
       best_complement_cost::float8 as "bestComplementCost",
       gross_edge::float8 as "grossEdge",
       classification,
       details
     from polymarket_brain.cross_venue_matches
     order by observed_at desc,
       case when classification='cross_venue_arb_candidate' then 0 else 1 end,
       gross_edge desc nulls last
     limit $1`,
    [bounded]
  );
  return rows;
}

export async function getOpportunityIntelligenceStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(`
    select
      (select count(*)::int from polymarket_brain.opportunity_packets) as "packets",
      (select max(generated_at) from polymarket_brain.opportunity_packets) as "lastPacketAt",
      (select count(*)::int from polymarket_brain.cross_venue_matches) as "crossVenueMatches",
      (select count(*)::int from polymarket_brain.cross_venue_matches where classification='cross_venue_arb_candidate') as "crossVenueArbCandidates",
      (select max(observed_at) from polymarket_brain.cross_venue_matches) as "lastCrossVenueAt"
  `);
  return { configured: true, ...rows[0] };
}

export async function getPersistentStats() {
  if (!pool) return { configured: false, reason: "not_configured" };

  const { rows } = await pool.query(`
    select
      count(*)::int as "scanCount",
      min(generated_at) as "firstScanAt",
      max(generated_at) as "lastScanAt",
      round(avg(scan_duration_ms)::numeric,2) as "avgScanDurationMs",
      round(avg(in_window)::numeric,2) as "avgInWindow",
      coalesce(sum(executable_count),0)::int as "executableDiscoveries"
    from polymarket_brain.scans
  `);

  return { configured: true, ...rows[0] };
}

export async function getCalibrationStats() {
  if (!pool) return { configured: false, reason: "not_configured" };

  const summary = await pool.query(`
    with market_rollup as (
      select
        coalesce(condition_id, market_id, slug) as market_key,
        count(*)::int as observations,
        count(*) filter (where opportunity_class = 'executable_structural')::int as executable_observations,
        max(opportunity_score) as max_opportunity_score,
        avg(opportunity_score) as avg_opportunity_score,
        max(attention_score) as max_attention_score,
        min(generated_at) as first_seen,
        max(generated_at) as last_seen
      from polymarket_brain.candidates
      where coalesce(condition_id, market_id, slug) is not null
      group by 1
    )
    select
      (select count(*)::int from polymarket_brain.scans) as scans,
      (select count(*)::int from polymarket_brain.candidates) as "candidateObservations",
      (select count(*)::int from market_rollup) as "uniqueMarkets",
      (select count(*)::int from market_rollup where observations >= 2) as "marketsSeenMultipleTimes",
      (select count(*)::int from market_rollup where executable_observations >= 2) as "persistentExecutableMarkets",
      (select count(*)::int from market_rollup where executable_observations = 1) as "oneScanExecutableMarkets",
      (select round(avg(observations)::numeric,2) from market_rollup) as "avgObservationsPerMarket",
      (select min(generated_at) from polymarket_brain.scans) as "firstScanAt",
      (select max(generated_at) from polymarket_brain.scans) as "lastScanAt"
  `);

  const classes = await pool.query(`
    select
      opportunity_class as class,
      count(*)::int as observations,
      count(distinct coalesce(condition_id, market_id, slug))::int as unique_markets,
      round(avg(opportunity_score)::numeric,2) as avg_score,
      round(max(opportunity_score)::numeric,2) as max_score,
      round(avg(attention_score)::numeric,2) as avg_attention_score
    from polymarket_brain.candidates
    group by opportunity_class
    order by opportunity_class
  `);

  const top = await pool.query(`
    select
      coalesce(condition_id, market_id, slug) as market_key,
      max(question) as question,
      count(*)::int as observations,
      count(*) filter (where opportunity_class = 'executable_structural')::int as executable_observations,
      round(max(opportunity_score)::numeric,2) as max_opportunity_score,
      round(avg(opportunity_score)::numeric,2) as avg_opportunity_score,
      round(max(attention_score)::numeric,2) as max_attention_score,
      min(generated_at) as first_seen,
      max(generated_at) as last_seen
    from polymarket_brain.candidates
    where coalesce(condition_id, market_id, slug) is not null
    group by 1
    order by executable_observations desc, observations desc, max_opportunity_score desc
    limit 20
  `);

  const row = summary.rows[0] || {};
  const first = row.firstScanAt ? new Date(row.firstScanAt).getTime() : null;
  const last = row.lastScanAt ? new Date(row.lastScanAt).getTime() : null;

  return {
    configured: true,
    generatedAt: new Date().toISOString(),
    ...row,
    coverageHours: first !== null && last !== null ? numberOrNull(((last - first) / 3_600_000).toFixed(3)) : null,
    classes: classes.rows,
    topPersistentMarkets: top.rows,
    resolvedMarkets: Number((await pool.query("select count(*)::int as count from polymarket_brain.resolutions")).rows[0]?.count || 0)
  };
}

export interface HistoricalCandidateStats {
  observations: number;
  executableObservations: number;
  avgOpportunityScore: number | null;
  maxOpportunityScore: number | null;
  avgAttentionScore: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

export async function getHistoricalCandidateStats(conditionIds: string[]) {
  const result = new Map<string, HistoricalCandidateStats>();
  if (!pool || conditionIds.length === 0) return result;

  const unique = [...new Set(conditionIds.filter(Boolean))].slice(0, 500);
  if (!unique.length) return result;

  const { rows } = await pool.query(
    `select
       condition_id,
       count(*)::int as observations,
       count(*) filter (where opportunity_class = 'executable_structural')::int as executable_observations,
       avg(opportunity_score)::float8 as avg_opportunity_score,
       max(opportunity_score)::float8 as max_opportunity_score,
       avg(attention_score)::float8 as avg_attention_score,
       min(generated_at) as first_seen,
       max(generated_at) as last_seen
     from polymarket_brain.candidates
     where condition_id = any($1::text[])
     group by condition_id`,
    [unique]
  );

  for (const row of rows) {
    result.set(String(row.condition_id), {
      observations: Number(row.observations || 0),
      executableObservations: Number(row.executable_observations || 0),
      avgOpportunityScore: numberOrNull(row.avg_opportunity_score),
      maxOpportunityScore: numberOrNull(row.max_opportunity_score),
      avgAttentionScore: numberOrNull(row.avg_attention_score),
      firstSeen: row.first_seen ? new Date(row.first_seen).toISOString() : null,
      lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : null
    });
  }

  return result;
}

export async function getUnresolvedObservedMarkets(limit = 100) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `select distinct on (c.condition_id)
       c.condition_id as "conditionId",
       c.market_id as "marketId",
       c.slug,
       c.question,
       c.end_date as "endDate"
     from polymarket_brain.candidates c
     left join polymarket_brain.resolutions r on r.condition_id = c.condition_id
     where c.condition_id is not null
       and c.slug is not null
       and c.end_date is not null
       and c.end_date <= now()
       and r.condition_id is null
     order by c.condition_id, c.generated_at desc
     limit $1`,
    [Math.max(1, Math.min(500, limit))]
  );
  return rows as Array<{
    conditionId: string;
    marketId: string | null;
    slug: string;
    question: string;
    endDate: string;
  }>;
}

export async function recordResolution(input: {
  conditionId: string;
  marketId?: string | null;
  resolvedAt?: string | null;
  winningOutcome: string;
  winningTokenId?: string | null;
  source: string;
  payload: unknown;
}) {
  if (!pool) return { configured: false, reason: "not_configured" };
  await pool.query(
    `insert into polymarket_brain.resolutions (
       condition_id, market_id, resolved_at, winning_outcome,
       winning_token_id, source, payload, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,now())
     on conflict (condition_id) do update set
       market_id = excluded.market_id,
       resolved_at = excluded.resolved_at,
       winning_outcome = excluded.winning_outcome,
       winning_token_id = excluded.winning_token_id,
       source = excluded.source,
       payload = excluded.payload,
       updated_at = now()`,
    [
      input.conditionId,
      input.marketId ?? null,
      input.resolvedAt ?? new Date().toISOString(),
      input.winningOutcome,
      input.winningTokenId ?? null,
      input.source,
      JSON.stringify(input.payload)
    ]
  );
  return { configured: true, ok: true };
}

export async function getResolutionStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(`
    select
      count(*)::int as "resolvedMarkets",
      min(resolved_at) as "firstResolvedAt",
      max(resolved_at) as "lastResolvedAt"
    from polymarket_brain.resolutions
  `);
  return { configured: true, ...rows[0] };
}

export async function getPersistenceIntegrity() {
  if (!pool) return { configured: false, reason: "not_configured" };

  const { rows } = await pool.query(`
    with ordered as (
      select generated_at,
             lag(generated_at) over (order by generated_at) as previous_at
      from polymarket_brain.scans
    ),
    recent as (
      select generated_at,
             lag(generated_at) over (order by generated_at) as previous_at
      from (
        select generated_at
        from polymarket_brain.scans
        where writer_id = $1
        order by generated_at desc
        limit 20
      ) x
    ),
    duplicate_groups as (
      select generated_at, count(*) as copies
      from polymarket_brain.scans
      group by generated_at
      having count(*) > 1
    ),
    active_writers as (
      select distinct writer_id
      from polymarket_brain.scans
      where generated_at > now() - interval '3 minutes'
        and writer_id is not null
    )
    select
      (select count(*)::int from polymarket_brain.scans) as "scanCount",
      (select count(*)::int from duplicate_groups) as "duplicateTimestamps",
      (select max(generated_at) from polymarket_brain.scans) as "lastScanAt",
      (select round(avg(extract(epoch from (generated_at - previous_at)))::numeric,2)
       from ordered where previous_at is not null) as "avgIntervalSeconds",
      (select round(avg(extract(epoch from (generated_at - previous_at)))::numeric,2)
       from recent where previous_at is not null) as "recentAvgIntervalSeconds",
      (select count(*)::int from active_writers) as "activeWriterCount",
      (select holder from polymarket_brain.writer_lease where lease_name='scan-writer') as "leaseHolder",
      (select lease_until from polymarket_brain.writer_lease where lease_name='scan-writer') as "leaseUntil"
  `, [WRITER_ID]);

  const row = rows[0] || {};
  const lastScanAt = row.lastScanAt ? new Date(row.lastScanAt).toISOString() : null;
  const ageSeconds = lastScanAt
    ? Math.max(0, (Date.now() - Date.parse(lastScanAt)) / 1000)
    : null;

  return {
    configured: true,
    scanCount: Number(row.scanCount || 0),
    duplicateTimestamps: Number(row.duplicateTimestamps || 0),
    lastScanAt,
    ageSeconds: ageSeconds === null ? null : Number(ageSeconds.toFixed(2)),
    avgIntervalSeconds: numberOrNull(row.avgIntervalSeconds),
    recentAvgIntervalSeconds: numberOrNull(row.recentAvgIntervalSeconds),
    activeWriterCount: Number(row.activeWriterCount || 0),
    leaseHolder: row.leaseHolder ?? null,
    leaseUntil: row.leaseUntil ? new Date(row.leaseUntil).toISOString() : null
  };
}

export async function testPersistenceConnection() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const started = Date.now();
  const { rows } = await pool.query("select now() as now, current_database() as database");
  return {
    configured: true,
    ok: true,
    latencyMs: Date.now() - started,
    database: rows[0]?.database ?? null,
    now: rows[0]?.now ?? null
  };
}

export function persistenceConfig() {
  return {
    configured: configured(),
    backend: configured() ? "neon_postgres" : "disabled",
    writerId: WRITER_ID,
    writerLeaseSeconds: WRITER_LEASE_SECONDS
  };
}
