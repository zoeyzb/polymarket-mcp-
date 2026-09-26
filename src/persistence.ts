import pg from "pg";
import type { ScanResult } from "./types.js";
import type { RealtimeQuote } from "./realtime.js";
import type { SportsFeedEvent } from "./sports.js";
import type { HistoricalCalibrationSample } from "./historical-calibration.js";
import { isPoliticalCandidate } from "./domain-policy.js";
import type { WalletIntelligenceProfile } from "./wallet-intelligence.js";
import { compactCandidatePersistencePayload, compactScanPersistencePayload } from "./persistence-payload.js";

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
        JSON.stringify(compactScanPersistencePayload(scan)),
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
          JSON.stringify(compactCandidatePersistencePayload(candidate))
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

  const fiveMinute = await pool.query(
    `with bucketed as (
       select
         token_id,
         to_timestamp(floor(extract(epoch from minute) / 300) * 300) as bucket,
         minute,
         open_mid,
         high_mid,
         low_mid,
         close_mid,
         avg_spread,
         min_spread,
         max_spread,
         sample_count,
         first_observed_at,
         last_observed_at
       from polymarket_brain.quote_bars_1m
       where minute >= now() - ($1 || ' minutes')::interval
     ),
     grouped as (
       select
         token_id,
         bucket,
         (array_agg(open_mid order by minute asc) filter (where open_mid is not null))[1] as open_mid,
         max(high_mid) as high_mid,
         min(low_mid) as low_mid,
         (array_agg(close_mid order by minute desc) filter (where close_mid is not null))[1] as close_mid,
         sum(avg_spread * sample_count) / nullif(sum(sample_count),0) as avg_spread,
         min(min_spread) as min_spread,
         max(max_spread) as max_spread,
         sum(sample_count)::int as sample_count,
         min(first_observed_at) as first_observed_at,
         max(last_observed_at) as last_observed_at
       from bucketed
       group by token_id, bucket
     )
     insert into polymarket_brain.quote_bars_5m (
       token_id, bucket, open_mid, high_mid, low_mid, close_mid,
       avg_spread, min_spread, max_spread, sample_count,
       first_observed_at, last_observed_at, updated_at
     )
     select
       token_id, bucket, open_mid, high_mid, low_mid, close_mid,
       avg_spread, min_spread, max_spread, sample_count,
       first_observed_at, last_observed_at, now()
     from grouped
     on conflict (token_id, bucket) do update set
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
    barsUpserted: rowCount ?? 0,
    bars5mUpserted: fiveMinute.rowCount ?? 0
  };
}

export async function cleanupRawStreams(
  quoteRetentionHours = 72,
  sportsRetentionDays = 30,
  options?: {
    candidateRetentionDays?: number;
    scanRetentionDays?: number;
    packetRetentionDays?: number;
    oneMinuteBarRetentionDays?: number;
    crossVenueRetentionDays?: number;
    snapshotKeepCount?: number;
  }
) {
  if (!pool) return { configured: false, reason: "not_configured" };

  const quoteHours = Math.max(24, Math.min(720, quoteRetentionHours));
  const sportDays = Math.max(7, Math.min(365, sportsRetentionDays));
  const candidateDays = Math.max(3, Math.min(90, Number(options?.candidateRetentionDays ?? 14)));
  const scanDays = Math.max(3, Math.min(90, Number(options?.scanRetentionDays ?? 14)));
  const packetDays = Math.max(7, Math.min(180, Number(options?.packetRetentionDays ?? 30)));
  const oneMinuteDays = Math.max(3, Math.min(90, Number(options?.oneMinuteBarRetentionDays ?? 21)));
  const crossVenueDays = Math.max(7, Math.min(180, Number(options?.crossVenueRetentionDays ?? 30)));
  const snapshotKeepCount = Math.max(2, Math.min(50, Number(options?.snapshotKeepCount ?? 10)));
  const startedAt = new Date().toISOString();

  try {
    // Delete disposable/high-volume rows first. Logging the maintenance run after
    // reclamation prevents a full database from blocking the cleanup itself.
    const quoteDelete = await pool.query(
      `delete from polymarket_brain.realtime_quotes
       where observed_at < now() - ($1 || ' hours')::interval`,
      [quoteHours]
    );

    const sportsDelete = await pool.query(
      `delete from polymarket_brain.sports_events
       where received_at < now() - ($1 || ' days')::interval`,
      [sportDays]
    );

    const candidateDelete = await pool.query(
      `delete from polymarket_brain.candidates
       where generated_at < now() - ($1 || ' days')::interval`,
      [candidateDays]
    );

    // Event baskets share scan_id references and need to be removed before scans
    // in deployments where the FK is not configured with ON DELETE CASCADE.
    const basketDelete = await pool.query(
      `delete from polymarket_brain.event_baskets
       where generated_at < now() - ($1 || ' days')::interval`,
      [scanDays]
    );

    const scanDelete = await pool.query(
      `delete from polymarket_brain.scans
       where generated_at < now() - ($1 || ' days')::interval`,
      [scanDays]
    );

    const packetDelete = await pool.query(
      `delete from polymarket_brain.opportunity_packets
       where generated_at < now() - ($1 || ' days')::interval`,
      [packetDays]
    );

    const crossVenueDelete = await pool.query(
      `delete from polymarket_brain.cross_venue_matches
       where observed_at < now() - ($1 || ' days')::interval`,
      [crossVenueDays]
    );

    const oneMinuteDelete = await pool.query(
      `delete from polymarket_brain.quote_bars_1m
       where minute < now() - ($1 || ' days')::interval`,
      [oneMinuteDays]
    );

    const snapshotDelete = await pool.query(
      `delete from polymarket_brain.multi_horizon_snapshots
       where generated_at < (
         select generated_at
         from polymarket_brain.multi_horizon_snapshots
         order by generated_at desc
         offset $1 limit 1
       )`,
      [snapshotKeepCount - 1]
    );

    const result = {
      configured: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      quoteRetentionHours: quoteHours,
      sportsRetentionDays: sportDays,
      candidateRetentionDays: candidateDays,
      scanRetentionDays: scanDays,
      packetRetentionDays: packetDays,
      oneMinuteBarRetentionDays: oneMinuteDays,
      crossVenueRetentionDays: crossVenueDays,
      snapshotKeepCount,
      deletedRealtimeQuotes: quoteDelete.rowCount ?? 0,
      deletedSportsEvents: sportsDelete.rowCount ?? 0,
      deletedCandidates: candidateDelete.rowCount ?? 0,
      deletedEventBaskets: basketDelete.rowCount ?? 0,
      deletedScans: scanDelete.rowCount ?? 0,
      deletedOpportunityPackets: packetDelete.rowCount ?? 0,
      deletedCrossVenueMatches: crossVenueDelete.rowCount ?? 0,
      deletedQuoteBars1m: oneMinuteDelete.rowCount ?? 0,
      deletedSnapshots: snapshotDelete.rowCount ?? 0
    };

    // Best-effort maintenance logging. Failure to write the log must never make
    // a successful reclamation run look failed.
    await pool.query(
      `insert into polymarket_brain.maintenance_runs (job, started_at, finished_at, details)
       values ('raw_stream_cleanup', $1::timestamptz, now(), $2::jsonb)`,
      [startedAt, JSON.stringify(result)]
    ).catch(() => {});

    return result;
  } catch (error) {
    await pool.query(
      `insert into polymarket_brain.maintenance_runs (job, started_at, finished_at, details)
       values ('raw_stream_cleanup', $1::timestamptz, now(), $2::jsonb)`,
      [startedAt, JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      })]
    ).catch(() => {});
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
      (select max(minute) from polymarket_brain.quote_bars_1m) as "lastQuoteBarMinute",
      (select count(*)::int from polymarket_brain.quote_bars_5m) as "quoteBar5mRows",
      (select max(bucket) from polymarket_brain.quote_bars_5m) as "lastQuoteBar5mBucket"
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
      : null,
    quoteBar5mRows: Number(row.quoteBar5mRows || 0),
    lastQuoteBar5mBucket: row.lastQuoteBar5mBucket
      ? new Date(row.lastQuoteBar5mBucket).toISOString()
      : null
  };
}

export async function getQuoteBars(
  tokenId: string,
  interval: "1m" | "5m" = "5m",
  hours = 24,
  limit = 500
) {
  if (!pool) return [];
  const boundedHours = Math.max(1, Math.min(24 * 30, hours));
  const boundedLimit = Math.max(1, Math.min(5000, limit));
  const table = interval === "1m"
    ? "polymarket_brain.quote_bars_1m"
    : "polymarket_brain.quote_bars_5m";
  const timeColumn = interval === "1m" ? "minute" : "bucket";

  const { rows } = await pool.query(
    `select
       token_id as "tokenId",
       ${timeColumn} as "time",
       open_mid::float8 as "open",
       high_mid::float8 as "high",
       low_mid::float8 as "low",
       close_mid::float8 as "close",
       avg_spread::float8 as "avgSpread",
       min_spread::float8 as "minSpread",
       max_spread::float8 as "maxSpread",
       sample_count as "sampleCount",
       first_observed_at as "firstObservedAt",
       last_observed_at as "lastObservedAt"
     from ${table}
     where token_id = $1
       and ${timeColumn} >= now() - ($2 || ' hours')::interval
     order by ${timeColumn} desc
     limit $3`,
    [tokenId, boundedHours, boundedLimit]
  );

  return rows.reverse().map(row => ({
    ...row,
    time: row.time ? new Date(row.time).toISOString() : null,
    firstObservedAt: row.firstObservedAt ? new Date(row.firstObservedAt).toISOString() : null,
    lastObservedAt: row.lastObservedAt ? new Date(row.lastObservedAt).toISOString() : null
  }));
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

export async function getStaleHistoricalCalibrationRefs(
  limit = 500,
  calibrationVersion = "v2-causal-price"
) {
  if (!pool) return [];
  const bounded = Math.max(1, Math.min(5000, limit));
  const { rows } = await pool.query(
    `select
       condition_id as "conditionId",
       slug,
       domain,
       resolved_at as "resolvedAt",
       updated_at as "updatedAt"
     from polymarket_brain.historical_calibration
     where coalesce(source_payload->>'calibrationVersion','') <> $1
       and slug is not null
       and slug <> ''
     order by updated_at asc, resolved_at desc
     limit $2`,
    [calibrationVersion, bounded]
  );
  return rows.map(row => ({
    ...row,
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null
  }));
}

export async function getKnownHistoricalCalibrationIds(
  conditionIds: string[],
  calibrationVersion = "v2-causal-price"
) {
  const known = new Set<string>();
  if (!pool || conditionIds.length === 0) return known;

  const unique = [...new Set(conditionIds.filter(Boolean))].slice(0, 2000);
  const { rows } = await pool.query(
    `select condition_id
     from polymarket_brain.historical_calibration
     where condition_id = any($1::text[])
       and source_payload->>'calibrationVersion' = $2`,
    [unique, calibrationVersion]
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

export async function getPriceBucketCalibration(options?: {
  bucketSize?: number;
  minSamples?: number;
}) {
  if (!pool) return { configured: false, reason: "not_configured" };

  const bucketSize = Math.max(0.01, Math.min(0.25, options?.bucketSize ?? 0.05));
  const minSamples = Math.max(1, Math.min(1000, options?.minSamples ?? 5));

  const { rows } = await pool.query(
    `with expanded as (
       select
         h.domain,
         kv.key as horizon,
         (pv.value #>> '{}')::float8 as probability,
         h.actual_outcome0::float8 as outcome
       from polymarket_brain.historical_calibration h
       cross join lateral jsonb_each(h.prices) pv
       cross join lateral jsonb_each(h.brier) kv
       where kv.key = pv.key
         and (pv.value #>> '{}')::float8 between 0 and 1
     ),
     bucketed as (
       select
         domain,
         horizon,
         least(1.0, floor(probability / $1) * $1) as bucket_low,
         probability,
         outcome
       from expanded
     )
     select
       domain,
       horizon,
       round(bucket_low::numeric,4)::float8 as "bucketLow",
       round(least(1.0,bucket_low + $1)::numeric,4)::float8 as "bucketHigh",
       count(*)::int as samples,
       round(avg(probability)::numeric,6)::float8 as "avgImpliedProbability",
       round(avg(outcome)::numeric,6)::float8 as "observedWinRate",
       round((avg(outcome)-avg(probability))::numeric,6)::float8 as "calibrationGap",
       round(avg(power(outcome-probability,2))::numeric,6)::float8 as "meanBrier"
     from bucketed
     group by domain, horizon, bucket_low
     having count(*) >= $2
     order by domain, horizon, bucket_low`,
    [bucketSize, minSamples]
  );

  return {
    configured: true,
    generatedAt: new Date().toISOString(),
    bucketSize,
    minSamples,
    buckets: rows,
    note:
      "Empirical Polymarket calibration from this system's resolved non-political samples. Positive calibrationGap means outcomes occurred more often than implied in that bucket; negative means less often. Small samples should not be treated as stable edge."
  };
}

export async function getHistoricalCalibrationSummary() {
  if (!pool) return { configured: false, reason: "not_configured" };

  const totals = await pool.query(`
    select
      count(*)::int as "sampleCount",
      count(*) filter (where domain='sports')::int as "sportsSamples",
      count(*) filter (where domain='crypto')::int as "cryptoSamples",
      count(*) filter (where domain='weather')::int as "weatherSamples",
      count(*) filter (where domain='other')::int as "otherSamples",
      count(*) filter (
        where source_payload->>'calibrationVersion' = 'v2-causal-price'
      )::int as "causalV2Samples",
      count(*) filter (
        where domain='sports' and source_payload->>'calibrationVersion' = 'v2-causal-price'
      )::int as "causalV2SportsSamples",
      count(*) filter (
        where domain='crypto' and source_payload->>'calibrationVersion' = 'v2-causal-price'
      )::int as "causalV2CryptoSamples",
      count(*) filter (
        where domain='weather' and source_payload->>'calibrationVersion' = 'v2-causal-price'
      )::int as "causalV2WeatherSamples",
      count(*) filter (
        where domain='other' and source_payload->>'calibrationVersion' = 'v2-causal-price'
      )::int as "causalV2OtherSamples",
      max(updated_at) filter (
        where source_payload->>'calibrationVersion' = 'v2-causal-price'
      ) as "lastCausalV2UpdatedAt",
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

  const total = Number(totals.rows[0]?.sampleCount || 0);
  const causal = Number(totals.rows[0]?.causalV2Samples || 0);
  return {
    configured: true,
    ...totals.rows[0],
    causalV2Remaining: Math.max(0, total - causal),
    causalV2ProgressPct: total > 0 ? Number(((causal / total) * 100).toFixed(2)) : 0,
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
  const tradePayload: Array<Record<string, unknown>> = [];

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
        const size = Number(trade.size);
        const price = Number(trade.price);
        const title = String(trade.title || "");
        const slug = String(trade.slug || "");
        const category =
          String(trade.intelligencePrimaryCategory || "") ||
          profile.dominantCategory ||
          "other";

        tradePayload.push({
          transaction_hash: tx,
          observed_at: Number.isFinite(timestamp)
            ? new Date(timestamp * 1000).toISOString()
            : new Date().toISOString(),
          wallet_address: profile.walletAddress,
          condition_id: trade.condition_id ? String(trade.condition_id) : null,
          token_id: trade.token_id ? String(trade.token_id) : null,
          side: trade.side ? String(trade.side) : null,
          outcome: trade.outcome ? String(trade.outcome) : null,
          title: title || null,
          slug: slug || null,
          price: Number.isFinite(price) ? price : null,
          size: Number.isFinite(size) ? size : null,
          notional_usdc:
            Number.isFinite(size) && Number.isFinite(price)
              ? size * price
              : null,
          wallet_score: profile.smartScore,
          primary_category: category,
          payload: trade
        });
      }
    }

    let tradeRows = 0;
    if (tradePayload.length) {
      const inserted = await client.query(
        `insert into polymarket_brain.wallet_trade_signals (
           transaction_hash, observed_at, wallet_address, condition_id,
           token_id, side, outcome, title, slug, price, size,
           notional_usdc, wallet_score, primary_category, payload
         )
         select
           x.transaction_hash,
           x.observed_at::timestamptz,
           x.wallet_address,
           x.condition_id,
           x.token_id,
           x.side,
           x.outcome,
           x.title,
           x.slug,
           x.price,
           x.size,
           x.notional_usdc,
           x.wallet_score,
           x.primary_category,
           x.payload
         from jsonb_to_recordset($1::jsonb) as x(
           transaction_hash text,
           observed_at text,
           wallet_address text,
           condition_id text,
           token_id text,
           side text,
           outcome text,
           title text,
           slug text,
           price numeric,
           size numeric,
           notional_usdc numeric,
           wallet_score numeric,
           primary_category text,
           payload jsonb
         )
         on conflict (transaction_hash) do nothing`,
        [JSON.stringify(tradePayload)]
      );
      tradeRows = inserted.rowCount ?? 0;
    }

    await client.query("commit");
    return {
      configured: true,
      profiles: profileRows,
      trades: tradeRows,
      attemptedTrades: tradePayload.length
    };
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
        logicalRelations: candidate.logicalRelations ?? [],
        sportsStructure: candidate.sportsStructure ?? null,
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

export async function getBehavioralShockBacktest(options?: {
  lookbackDays?: number;
  shockThresholdPct?: number;
  minSamples?: number;
}) {
  if (!pool) return { configured: false, reason: "not_configured" };

  const lookbackDays = Math.max(1, Math.min(90, options?.lookbackDays ?? 14));
  const shockThreshold = Math.max(0.5, Math.min(50, options?.shockThresholdPct ?? 10)) / 100;
  const minSamples = Math.max(1, Math.min(1000, options?.minSamples ?? 5));

  const { rows } = await pool.query(
    `with token_map as (
       select distinct on (tok.token_id)
         tok.token_id,
         c.condition_id,
         c.question,
         coalesce(c.payload->>'primaryCategory','other') as primary_category
       from polymarket_brain.candidates c
       cross join lateral jsonb_array_elements_text(
         coalesce(c.payload->'tokenIds','[]'::jsonb)
       ) tok(token_id)
       where c.generated_at >= now() - ($1 || ' days')::interval
       order by tok.token_id, c.generated_at desc
     ),
     series as (
       select
         b.token_id,
         b.minute,
         b.close_mid::float8 as close_mid,
         tm.condition_id,
         tm.question,
         tm.primary_category,
         lag(b.close_mid::float8, 5) over (
           partition by b.token_id order by b.minute
         ) as close_5m_ago
       from polymarket_brain.quote_bars_1m b
       join token_map tm on tm.token_id = b.token_id
       where b.minute >= now() - ($1 || ' days')::interval
         and b.close_mid is not null
     ),
     shocks as (
       select
         *,
         (close_mid / nullif(close_5m_ago,0) - 1.0) as shock_return
       from series
       where close_5m_ago is not null
         and close_mid > 0
         and close_5m_ago > 0
         and abs(close_mid / nullif(close_5m_ago,0) - 1.0) >= $2
     ),
     forward as (
       select
         s.*,
         f15.close_mid as close_15m,
         f30.close_mid as close_30m,
         f60.close_mid as close_60m
       from shocks s
       left join lateral (
         select b.close_mid::float8 as close_mid
         from polymarket_brain.quote_bars_1m b
         where b.token_id = s.token_id
           and b.minute >= s.minute + interval '15 minutes'
           and b.minute <= s.minute + interval '18 minutes'
           and b.close_mid is not null
         order by b.minute asc
         limit 1
       ) f15 on true
       left join lateral (
         select b.close_mid::float8 as close_mid
         from polymarket_brain.quote_bars_1m b
         where b.token_id = s.token_id
           and b.minute >= s.minute + interval '30 minutes'
           and b.minute <= s.minute + interval '33 minutes'
           and b.close_mid is not null
         order by b.minute asc
         limit 1
       ) f30 on true
       left join lateral (
         select b.close_mid::float8 as close_mid
         from polymarket_brain.quote_bars_1m b
         where b.token_id = s.token_id
           and b.minute >= s.minute + interval '60 minutes'
           and b.minute <= s.minute + interval '63 minutes'
           and b.close_mid is not null
         order by b.minute asc
         limit 1
       ) f60 on true
     ),
     expanded as (
       select
         primary_category,
         shock_return,
         horizon,
         future_close,
         (future_close / nullif(close_mid,0) - 1.0) as forward_return
       from forward
       cross join lateral (
         values
           ('15m'::text, close_15m),
           ('30m'::text, close_30m),
           ('60m'::text, close_60m)
       ) h(horizon, future_close)
       where future_close is not null
     )
     select
       primary_category as "primaryCategory",
       horizon,
       count(*)::int as samples,
       round(avg(abs(shock_return))::numeric,6)::float8 as "avgShockAbsReturn",
       round(avg(forward_return)::numeric,6)::float8 as "avgForwardReturn",
       round(avg(abs(forward_return))::numeric,6)::float8 as "avgForwardAbsReturn",
       round(avg(
         case when sign(shock_return) = sign(forward_return) and forward_return <> 0
              then 1.0 else 0.0 end
       )::numeric,4)::float8 as "continuationRate",
       round(avg(
         case when sign(shock_return) <> sign(forward_return) and forward_return <> 0
              then 1.0 else 0.0 end
       )::numeric,4)::float8 as "reversionRate"
     from expanded
     group by primary_category, horizon
     having count(*) >= $3
     order by primary_category, horizon`,
    [lookbackDays, shockThreshold, minSamples]
  );

  const total = rows.reduce((sum, row) => sum + Number(row.samples || 0), 0);
  return {
    configured: true,
    generatedAt: new Date().toISOString(),
    lookbackDays,
    shockThresholdPct: shockThreshold * 100,
    minSamples,
    aggregatedSampleRows: total,
    categories: rows
  };
}

export async function getHistoricalReplaySamples(options?: {
  years?: number;
  domains?: string[];
  limit?: number;
  calibrationVersion?: string;
}) {
  if (!pool) return [];
  const years = Math.max(0.25, Math.min(10, Number(options?.years ?? 3)));
  const limit = Math.max(1, Math.min(100000, Number(options?.limit ?? 50000)));
  const domains = (options?.domains || []).filter(Boolean);
  const calibrationVersion = String(options?.calibrationVersion || "").trim();

  const { rows } = await pool.query(
    `select
       condition_id as "conditionId",
       resolved_at as "resolvedAt",
       domain,
       actual_outcome0 as "actualOutcome0",
       prices
     from polymarket_brain.historical_calibration
     where resolved_at >= now() - ($1 || ' years')::interval
       and ($2::text[] = '{}'::text[] or domain = any($2::text[]))
       and ($4 = '' or source_payload->>'calibrationVersion' = $4)
     order by resolved_at asc
     limit $3`,
    [years, domains, limit, calibrationVersion]
  );

  return rows.map(row => ({
    conditionId: String(row.conditionId),
    resolvedAt: new Date(row.resolvedAt).toISOString(),
    domain: String(row.domain),
    actualOutcome0: Number(row.actualOutcome0) === 1 ? 1 as const : 0 as const,
    prices: row.prices && typeof row.prices === "object" ? row.prices as Record<string, number> : {}
  }));
}

export async function upsertWalletProfileAddress(
  walletAddress: string,
  id = "primary"
) {
  if (!pool) throw new Error("persistence_not_configured");
  const address = walletAddress.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("invalid_evm_wallet_address");

  const { rows } = await pool.query(
    `insert into polymarket_brain.wallet_profiles (
       id, wallet_address, chain_id, enabled, metadata, updated_at
     ) values ($1,$2,137,false,'{}'::jsonb,now())
     on conflict (id) do update set
       enabled = case
         when lower(coalesce(polymarket_brain.wallet_profiles.wallet_address,'')) = lower(excluded.wallet_address)
         then polymarket_brain.wallet_profiles.enabled
         else false
       end,
       wallet_address = excluded.wallet_address,
       updated_at = now()
     returning
       id,
       wallet_address as "walletAddress",
       funder_address as "funderAddress",
       proxy_wallet as "proxyWallet",
       signature_type as "signatureType",
       wallet_type as "walletType",
       chain_id as "chainId",
       enabled,
       metadata,
       created_at as "createdAt",
       updated_at as "updatedAt"`,
    [id, address]
  );

  return {
    ...rows[0],
    configured: true,
    privateKeyStored: false,
    signingMode: "user_wallet_signature"
  };
}

export async function getWalletProfile(id = "primary") {
  if (!pool) return null;
  const { rows } = await pool.query(
    `select
       id,
       wallet_address as "walletAddress",
       funder_address as "funderAddress",
       proxy_wallet as "proxyWallet",
       signature_type as "signatureType",
       wallet_type as "walletType",
       chain_id as "chainId",
       enabled,
       metadata,
       created_at as "createdAt",
       updated_at as "updatedAt"
     from polymarket_brain.wallet_profiles
     where id = $1
     limit 1`,
    [id]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    configured: Boolean(rows[0].walletAddress)
  };
}

export async function getWalletControlStatus(id = "primary") {
  const profile = await getWalletProfile(id);
  return {
    configured: Boolean(profile?.configured),
    enabled: Boolean(profile?.enabled),
    profile: profile
      ? {
          id: profile.id,
          walletAddress: profile.walletAddress,
          funderAddress: profile.funderAddress,
          proxyWallet: profile.proxyWallet,
          signatureType: profile.signatureType,
          walletType: profile.walletType,
          chainId: profile.chainId,
          enabled: profile.enabled,
          metadata: profile.metadata
        }
      : null,
    intentCreationEnabled:
      String(process.env.TRADING_INTENTS_ENABLED || "false").toLowerCase() === "true",
    submissionEnabled:
      String(process.env.TRADING_ENABLED || "false").toLowerCase() === "true",
    custodyMode: "non_custodial_user_signature",
    privateKeyStored: false,
    note:
      "This service is designed not to store a wallet seed phrase or raw private key. Final order signing remains with the user's wallet."
  };
}

export async function createTradeIntent(input: {
  walletProfileId?: string;
  conditionId?: string | null;
  tokenId: string;
  marketSlug?: string | null;
  question?: string | null;
  outcome?: string | null;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  tif?: string | null;
  price?: number | null;
  size?: number | null;
  amountUsdc?: number | null;
  maxSlippageBps?: number | null;
  preview: Record<string, unknown>;
  clientRequestId?: string | null;
}) {
  if (!pool) throw new Error("persistence_not_configured");
  const intentCreationEnabled =
    String(process.env.TRADING_INTENTS_ENABLED || "false").toLowerCase() === "true";
  if (!intentCreationEnabled) throw new Error("trade_intent_creation_disabled");

  const walletProfileId = input.walletProfileId || "primary";
  const profile = await getWalletProfile(walletProfileId);
  if (!profile?.configured) throw new Error("wallet_profile_not_configured");
  if (!profile.enabled) throw new Error("wallet_profile_not_enabled");

  const { rows } = await pool.query(
    `insert into polymarket_brain.trade_intents (
       wallet_profile_id, condition_id, token_id, market_slug, question,
       outcome, side, order_type, tif, price, size, amount_usdc,
       max_slippage_bps, status, preview, client_request_id, created_by
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       'AWAITING_SIGNATURE',$14::jsonb,$15,'chatgpt'
     )
     returning
       id,
       created_at as "createdAt",
       updated_at as "updatedAt",
       wallet_profile_id as "walletProfileId",
       condition_id as "conditionId",
       token_id as "tokenId",
       market_slug as "marketSlug",
       question,
       outcome,
       side,
       order_type as "orderType",
       tif,
       price::float8 as price,
       size::float8 as size,
       amount_usdc::float8 as "amountUsdc",
       max_slippage_bps as "maxSlippageBps",
       status,
       preview,
       client_request_id as "clientRequestId"`,
    [
      walletProfileId,
      input.conditionId ?? null,
      input.tokenId,
      input.marketSlug ?? null,
      input.question ?? null,
      input.outcome ?? null,
      input.side,
      input.orderType,
      input.tif ?? null,
      input.price ?? null,
      input.size ?? null,
      input.amountUsdc ?? null,
      input.maxSlippageBps ?? null,
      JSON.stringify(input.preview),
      input.clientRequestId ?? null
    ]
  );

  const intent = rows[0];
  if (intent?.id) {
    await pool.query(
      `insert into polymarket_brain.trade_audit_log (
         trade_intent_id, action, actor, details
       ) values ($1,'INTENT_CREATED','chatgpt',$2::jsonb)`,
      [intent.id, JSON.stringify({
        tokenId: input.tokenId,
        side: input.side,
        orderType: input.orderType,
        signingRequired: true
      })]
    );
  }

  return intent;
}

export async function listTradeIntents(limit = 50) {
  if (!pool) return [];
  const bounded = Math.max(1, Math.min(500, limit));
  const { rows } = await pool.query(
    `select
       id,
       created_at as "createdAt",
       updated_at as "updatedAt",
       wallet_profile_id as "walletProfileId",
       condition_id as "conditionId",
       token_id as "tokenId",
       market_slug as "marketSlug",
       question,
       outcome,
       side,
       order_type as "orderType",
       tif,
       price::float8 as price,
       size::float8 as size,
       amount_usdc::float8 as "amountUsdc",
       max_slippage_bps as "maxSlippageBps",
       status,
       preview,
       signing_payload as "signingPayload",
       submission_response as "submissionResponse",
       client_request_id as "clientRequestId",
       failure_reason as "failureReason"
     from polymarket_brain.trade_intents
     order by created_at desc
     limit $1`,
    [bounded]
  );
  return rows;
}

export async function getTradeControlStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(`
    select
      (select count(*)::int from polymarket_brain.wallet_profiles) as "walletProfiles",
      (select count(*)::int from polymarket_brain.wallet_profiles where enabled) as "enabledWalletProfiles",
      (select count(*)::int from polymarket_brain.trade_intents) as "tradeIntents",
      (select count(*)::int from polymarket_brain.trade_intents where status='AWAITING_SIGNATURE') as "awaitingSignature",
      (select max(created_at) from polymarket_brain.trade_intents) as "lastIntentAt",
      (select count(*)::int from polymarket_brain.trading_control_requests) as "controlRequests",
      (select count(*)::int from polymarket_brain.trading_control_requests where status='AWAITING_SIGNATURE') as "controlAwaitingSignature",
      (select max(created_at) from polymarket_brain.trading_control_requests) as "lastControlRequestAt"
  `);
  return {
    configured: true,
    ...rows[0],
    intentCreationEnabled:
      String(process.env.TRADING_INTENTS_ENABLED || "false").toLowerCase() === "true",
    submissionEnabled:
      String(process.env.TRADING_ENABLED || "false").toLowerCase() === "true"
  };
}

export async function createTradingControlRequest(input: {
  walletProfileId?: string;
  action: "CANCEL_ALL" | "CANCEL_ORDER" | "CANCEL_MARKET";
  orderId?: string | null;
  marketId?: string | null;
}) {
  if (!pool) throw new Error("persistence_not_configured");
  const walletProfileId = input.walletProfileId || "primary";
  const profile = await getWalletProfile(walletProfileId);
  if (!profile?.configured) throw new Error("wallet_profile_not_configured");
  if (!profile.enabled) throw new Error("wallet_profile_not_enabled");

  const intentCreationEnabled =
    String(process.env.TRADING_INTENTS_ENABLED || "false").toLowerCase() === "true";
  if (!intentCreationEnabled) throw new Error("trading_control_requests_disabled");

  const { rows } = await pool.query(
    `insert into polymarket_brain.trading_control_requests (
       wallet_profile_id, action, order_id, market_id, status, created_by
     ) values ($1,$2,$3,$4,'AWAITING_SIGNATURE','chatgpt')
     returning
       id,
       created_at as "createdAt",
       updated_at as "updatedAt",
       wallet_profile_id as "walletProfileId",
       action,
       order_id as "orderId",
       market_id as "marketId",
       status`,
    [
      walletProfileId,
      input.action,
      input.orderId ?? null,
      input.marketId ?? null
    ]
  );

  const request = rows[0];
  if (request?.id) {
    await pool.query(
      `insert into polymarket_brain.trade_audit_log (
         trade_intent_id, action, actor, details
       ) values (null,$1,'chatgpt',$2::jsonb)`,
      [
        input.action,
        JSON.stringify({
          tradingControlRequestId: request.id,
          orderId: input.orderId ?? null,
          marketId: input.marketId ?? null,
          signingRequired: true
        })
      ]
    );
  }
  return request;
}

export async function listTradingControlRequests(limit = 50) {
  if (!pool) return [];
  const bounded = Math.max(1, Math.min(500, limit));
  const { rows } = await pool.query(
    `select
       id,
       created_at as "createdAt",
       updated_at as "updatedAt",
       wallet_profile_id as "walletProfileId",
       action,
       order_id as "orderId",
       market_id as "marketId",
       status,
       signing_payload as "signingPayload",
       submission_response as "submissionResponse",
       failure_reason as "failureReason"
     from polymarket_brain.trading_control_requests
     order by created_at desc
     limit $1`,
    [bounded]
  );
  return rows;
}

export async function persistMultiHorizonSnapshot(
  result: import("./types.js").MultiHorizonScanResult
) {
  if (!pool) return { configured: false, reason: "not_configured" };

  const generatedAt = result.generatedAt || new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("begin");
    // This table is current-state only. TRUNCATE releases prior large JSON/TOAST
    // pages instead of accumulating dead tuples from repeated insert+delete cycles.
    await client.query(`truncate table polymarket_brain.multi_horizon_snapshots`);
    const inserted = await client.query(
      `insert into polymarket_brain.multi_horizon_snapshots (
         generated_at, total_active_markets, eligible_markets,
         retained_candidates, scan_duration_ms, payload
       ) values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        generatedAt,
        result.totalActiveMarketsScanned ?? null,
        result.eligibleMarketsScanned ?? null,
        result.retainedCandidateCount ?? null,
        result.scanDurationMs ?? null,
        JSON.stringify(result)
      ]
    );
    await client.query("commit");
    return { configured: true, written: inserted.rowCount ?? 0, generatedAt, retention:"current_state_only" };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getLatestMultiHorizonSnapshot() {
  if (!pool) return null;
  const { rows } = await pool.query(
    `select
       generated_at as "generatedAt",
       recorded_at as "recordedAt",
       total_active_markets as "totalActiveMarketsScanned",
       eligible_markets as "eligibleMarketsScanned",
       retained_candidates as "retainedCandidateCount",
       scan_duration_ms as "scanDurationMs",
       payload
     from polymarket_brain.multi_horizon_snapshots
     order by generated_at desc
     limit 1`
  );
  if (!rows[0]) return null;

  const generatedAt = new Date(rows[0].generatedAt).toISOString();
  const recordedAt = new Date(rows[0].recordedAt).toISOString();
  return {
    ...rows[0].payload,
    generatedAt,
    recordedAt,
    ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(generatedAt)) / 1000)),
    persisted: true
  };
}

export async function getMultiHorizonSnapshotStats() {
  if (!pool) return { configured: false, reason: "not_configured" };
  const { rows } = await pool.query(
    `select
       count(*)::int as "snapshotCount",
       max(generated_at) as "latestGeneratedAt",
       max(recorded_at) as "latestRecordedAt",
       max(total_active_markets)::int as "maxActiveMarketsSeen"
     from polymarket_brain.multi_horizon_snapshots`
  );
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


export async function getStorageHealth() {
  if (!pool) return { configured:false, reason:"not_configured" };

  const { rows } = await pool.query(`
    select
      n.nspname as schema_name,
      c.relname as relation_name,
      pg_total_relation_size(c.oid)::bigint as total_bytes,
      pg_relation_size(c.oid)::bigint as table_bytes,
      pg_indexes_size(c.oid)::bigint as index_bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'polymarket_brain'
      and c.relkind in ('r','m')
    order by pg_total_relation_size(c.oid) desc
  `);

  const tables = rows.map(row => ({
    schema: String(row.schema_name),
    relation: String(row.relation_name),
    totalBytes: Number(row.total_bytes || 0),
    tableBytes: Number(row.table_bytes || 0),
    indexBytes: Number(row.index_bytes || 0)
  }));
  const totalBytes = tables.reduce((sum, row) => sum + row.totalBytes, 0);

  return {
    configured:true,
    totalBytes,
    totalMiB: Math.round((totalBytes / 1024 / 1024) * 100) / 100,
    tables
  };
}


async function ensurePaperTradingSchema() {
  if (!pool) return;
  await pool.query(`
    create table if not exists polymarket_brain.paper_trades (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      strategy_id text not null,
      calibration_version text,
      condition_id text,
      market_id text,
      slug text,
      question text,
      domain text,
      outcome text,
      token_id text,
      entry_at timestamptz not null,
      expected_resolution_at timestamptz,
      entry_price numeric,
      stake_usd numeric not null,
      expected_edge_bps numeric,
      expected_roi_pct numeric,
      fee_rate numeric,
      status text not null default 'OPEN',
      resolved_at timestamptz,
      winning_outcome text,
      gross_pnl_usd numeric,
      fee_usd numeric,
      net_pnl_usd numeric,
      realized_roi_pct numeric,
      policy_snapshot jsonb not null default '{}'::jsonb,
      market_snapshot jsonb not null default '{}'::jsonb
    )
  `);
  await pool.query(`
    create unique index if not exists paper_trades_strategy_condition_token_idx
      on polymarket_brain.paper_trades(strategy_id, condition_id, token_id)
  `);
  await pool.query(`
    create index if not exists paper_trades_status_idx
      on polymarket_brain.paper_trades(status, entry_at)
  `);
}

export async function createPaperTrade(input: {
  strategyId: string;
  calibrationVersion?: string | null;
  conditionId?: string | null;
  marketId?: string | null;
  slug?: string | null;
  question?: string | null;
  domain?: string | null;
  outcome?: string | null;
  tokenId?: string | null;
  entryAt?: string;
  expectedResolutionAt?: string | null;
  entryPrice: number;
  stakeUsd: number;
  expectedEdgeBps?: number | null;
  expectedRoiPct?: number | null;
  feeRate?: number | null;
  policySnapshot?: Record<string,unknown>;
  marketSnapshot?: Record<string,unknown>;
}) {
  if (!pool) return { configured:false,reason:"not_configured",inserted:false };
  await ensurePaperTradingSchema();
  const { rows } = await pool.query(
    `insert into polymarket_brain.paper_trades (
       strategy_id, calibration_version, condition_id, market_id, slug, question,
       domain, outcome, token_id, entry_at, expected_resolution_at,
       entry_price, stake_usd, expected_edge_bps, expected_roi_pct, fee_rate,
       policy_snapshot, market_snapshot
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,
       $12,$13,$14,$15,$16,$17::jsonb,$18::jsonb
     )
     on conflict (strategy_id, condition_id, token_id) do nothing
     returning id, created_at as "createdAt"`,
    [
      input.strategyId,
      input.calibrationVersion ?? null,
      input.conditionId ?? null,
      input.marketId ?? null,
      input.slug ?? null,
      input.question ?? null,
      input.domain ?? null,
      input.outcome ?? null,
      input.tokenId ?? null,
      input.entryAt || new Date().toISOString(),
      input.expectedResolutionAt ?? null,
      input.entryPrice,
      input.stakeUsd,
      input.expectedEdgeBps ?? null,
      input.expectedRoiPct ?? null,
      input.feeRate ?? null,
      JSON.stringify(input.policySnapshot || {}),
      JSON.stringify(input.marketSnapshot || {})
    ]
  );
  return { configured:true,inserted:rows.length > 0,id:rows[0]?.id ?? null };
}

export async function getOpenPaperTrades(limit = 500) {
  if (!pool) return [];
  await ensurePaperTradingSchema();
  const bounded=Math.max(1,Math.min(5000,limit));
  const {rows}=await pool.query(
    `select
       id, strategy_id as "strategyId", calibration_version as "calibrationVersion",
       condition_id as "conditionId", market_id as "marketId", slug, question, domain,
       outcome, token_id as "tokenId", entry_at as "entryAt",
       expected_resolution_at as "expectedResolutionAt",
       entry_price::float8 as "entryPrice", stake_usd::float8 as "stakeUsd",
       expected_edge_bps::float8 as "expectedEdgeBps",
       expected_roi_pct::float8 as "expectedRoiPct", fee_rate::float8 as "feeRate",
       status, policy_snapshot as "policySnapshot", market_snapshot as "marketSnapshot"
     from polymarket_brain.paper_trades
     where status='OPEN'
     order by entry_at asc
     limit $1`,
    [bounded]
  );
  return rows;
}

export async function settlePaperTrade(input:{
  id:string|number;
  winningOutcome:string|null;
  resolvedAt?:string;
  won:boolean;
}) {
  if(!pool) return {configured:false,reason:"not_configured"};
  await ensurePaperTradingSchema();
  const {rows}=await pool.query(
    `select entry_price::float8 as "entryPrice",
            stake_usd::float8 as "stakeUsd",
            fee_rate::float8 as "feeRate"
       from polymarket_brain.paper_trades
       where id=$1 and status='OPEN'
       limit 1`,
    [input.id]
  );
  const row=rows[0];
  if(!row) return {configured:true,updated:false};
  const price=Number(row.entryPrice);
  const stake=Number(row.stakeUsd);
  const feeRate=Math.max(0,Number(row.feeRate||0));
  const shares=price>0 ? stake/price : 0;
  const gross=input.won ? shares-stake : -stake;
  const fee=Math.max(0,shares*feeRate*price*(1-price));
  const net=gross-fee;
  const roi=stake>0 ? (net/stake)*100 : null;
  await pool.query(
    `update polymarket_brain.paper_trades
       set status=$2,
           resolved_at=$3::timestamptz,
           winning_outcome=$4,
           gross_pnl_usd=$5,
           fee_usd=$6,
           net_pnl_usd=$7,
           realized_roi_pct=$8,
           updated_at=now()
       where id=$1`,
    [
      input.id,
      input.won ? "WIN" : "LOSS",
      input.resolvedAt || new Date().toISOString(),
      input.winningOutcome,
      gross,
      fee,
      net,
      roi
    ]
  );
  return {configured:true,updated:true,netPnlUsd:net,realizedRoiPct:roi};
}

export async function getPaperTradingStats() {
  if(!pool) return {configured:false,reason:"not_configured"};
  await ensurePaperTradingSchema();
  const {rows}=await pool.query(`
    select
      count(*)::int as "trades",
      count(*) filter (where status='OPEN')::int as "openTrades",
      count(*) filter (where status='WIN')::int as wins,
      count(*) filter (where status='LOSS')::int as losses,
      coalesce(sum(net_pnl_usd) filter (where status in ('WIN','LOSS')),0)::float8 as "netPnlUsd",
      coalesce(sum(stake_usd) filter (where status in ('WIN','LOSS')),0)::float8 as "resolvedStakeUsd",
      avg(realized_roi_pct) filter (where status in ('WIN','LOSS'))::float8 as "avgTradeRoiPct",
      min(realized_roi_pct) filter (where status in ('WIN','LOSS'))::float8 as "worstTradeRoiPct",
      max(realized_roi_pct) filter (where status in ('WIN','LOSS'))::float8 as "bestTradeRoiPct",
      min(entry_at) as "firstEntryAt",
      max(entry_at) as "lastEntryAt",
      max(resolved_at) as "lastResolvedAt"
    from polymarket_brain.paper_trades
  `);
  const row=rows[0]||{};
  const resolved=Number(row.wins||0)+Number(row.losses||0);
  const resolvedStake=Number(row.resolvedStakeUsd||0);
  const net=Number(row.netPnlUsd||0);
  return {
    configured:true,
    ...row,
    resolvedTrades:resolved,
    winRatePct:resolved ? Number(((Number(row.wins||0)/resolved)*100).toFixed(3)) : null,
    aggregateRoiPct:resolvedStake>0 ? Number(((net/resolvedStake)*100).toFixed(3)) : null
  };
}

export async function listPaperTrades(limit=100) {
  if(!pool) return [];
  await ensurePaperTradingSchema();
  const bounded=Math.max(1,Math.min(1000,limit));
  const {rows}=await pool.query(
    `select
       id, created_at as "createdAt", updated_at as "updatedAt",
       strategy_id as "strategyId", calibration_version as "calibrationVersion",
       condition_id as "conditionId", market_id as "marketId", slug, question, domain,
       outcome, token_id as "tokenId", entry_at as "entryAt",
       expected_resolution_at as "expectedResolutionAt",
       entry_price::float8 as "entryPrice", stake_usd::float8 as "stakeUsd",
       expected_edge_bps::float8 as "expectedEdgeBps",
       expected_roi_pct::float8 as "expectedRoiPct", status,
       resolved_at as "resolvedAt", winning_outcome as "winningOutcome",
       gross_pnl_usd::float8 as "grossPnlUsd", fee_usd::float8 as "feeUsd",
       net_pnl_usd::float8 as "netPnlUsd", realized_roi_pct::float8 as "realizedRoiPct"
     from polymarket_brain.paper_trades
     order by entry_at desc
     limit $1`,
    [bounded]
  );
  return rows;
}
