#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  getMarketBySlug,
  getOrderBook,
  getOrderBooks,
  getPriceHistory,
  getRecentTrades,
  listClosedMarketsEndingBetween,
  parseNumberArray,
  parseStringArray,
  searchActiveMarkets,
  upstreamCheck
} from "./polymarket.js";
import { scanBinaryArbitrage, scanClosingSoon, scanMultiHorizon, scanOpportunities } from "./scanner.js";
import { analyzePriceHistoryPayload, analyzeTradeFlowPayload, calculateCompleteOutcomeBasket } from "./intelligence.js";
import { getSnapshotHealth, getSnapshots } from "./snapshots.js";
import { realtimeTracker } from "./realtime.js";
import {
  cleanupRawStreams,
  compactRealtimeQuotes,
  getAlertStats,
  getBehavioralShockBacktest,
  getCalibrationStats,
  getHistoricalCalibrationSummary,
  getHistoricalCandidateStats,
  getHistoricalReplaySamples,
  getLatestMultiHorizonSnapshot,
  getMultiHorizonSnapshotStats,
  getOpportunityIntelligenceStats,
  getPriceBucketCalibration,
  getQuoteBars,
  getMaintenanceStats,
  getKnownHistoricalCalibrationIds,
  getStaleHistoricalCalibrationRefs,
  recordHistoricalCalibrationRebuildFailure,
  getPersistenceIntegrity,
  getStorageHealth,
  getPersistentStats,
  getRecentAlerts,
  getRecentCrossVenueMatches,
  getRecentOpportunityPackets,
  getResolutionStats,
  getRealtimeTargets,
  getRealtimeTargetStats,
  getStreamPersistenceStats,
  getUnresolvedObservedMarkets,
  getWorkerHeartbeats,
  getTopWalletIntelligence,
  getWalletIntelligenceStats,
  getWalletControlStatus,
  getWalletProfile,
  getTradeControlStats,
  getPaperTradingStats,
  getOpenPaperTrades,
  listPaperTrades,
  createPaperTrade,
  settlePaperTrade,
  listTradeIntents,
  createTradeIntent,
  createTradingControlRequest,
  listTradingControlRequests,
  persistAlertsFromScan,
  persistOpportunityPackets,
  persistMultiHorizonSnapshot,
  persistRealtimeQuotes,
  persistScan,
  persistSportsEvents,
  persistWalletIntelligenceProfiles,
  replaceRealtimeTargets,
  persistenceConfig,
  recordResolution,
  testPersistenceConnection,
  upsertHistoricalCalibrationSample,
  upsertWalletProfileAddress,
  upsertWorkerHeartbeat
} from "./persistence.js";
import { inferFinalResolution } from "./resolutions.js";
import { getExternalCryptoEvidence } from "./external-evidence.js";
import { auditScanResult, summarizeAudit, type AuditFinding } from "./audit.js";
import { sportsTracker } from "./sports.js";
import { buildSportsBoard } from "./sports-board.js";
import { buildHistoricalCalibrationSample, rebuildHistoricalCalibrationSampleFromStored, classifyHistoricalDomain, HISTORICAL_CALIBRATION_VERSION, type StoredHistoricalCalibrationRef } from "./historical-calibration.js";
import { priceCashOrNothingDigital } from "./digital-fair-value.js";
import { fetchTopWalletProfiles } from "./wallet-intelligence.js";
import { getWalletPortfolio, previewTrade } from "./wallet-trading.js";
import { runCalendarWalkForwardEdgeBacktest, runCalibratedEdgeBacktest, runProbabilityThresholdBacktest, runWalkForwardEdgeBacktest, sweepProbabilityThresholds } from "./backtest.js";
import { buildUnifiedOpportunity, type OpportunityLane } from "./opportunity-object.js";
import { renderDashboardHtml } from "./dashboard.js";
import type { NormalizedBook, ScanCandidate } from "./types.js";

const PORT = Number(process.env.PORT || 3000);
const VERSION = "0.5.0";
type ServiceRole = "all" | "api" | "scanner" | "streams" | "history" | "maintenance";
const SERVICE_ROLE: ServiceRole = (
  ["all", "api", "scanner", "streams", "history", "maintenance"].includes(
    String(process.env.SERVICE_ROLE || "all").toLowerCase()
  )
    ? String(process.env.SERVICE_ROLE || "all").toLowerCase()
    : "all"
) as ServiceRole;

const ROLE_API = SERVICE_ROLE === "all" || SERVICE_ROLE === "api";
const ROLE_SCANNER = SERVICE_ROLE === "all" || SERVICE_ROLE === "scanner";
const ROLE_STREAMS = SERVICE_ROLE === "all" || SERVICE_ROLE === "streams";
const ROLE_HISTORY = SERVICE_ROLE === "all" || SERVICE_ROLE === "history";
const ROLE_MAINTENANCE = SERVICE_ROLE === "all" || SERVICE_ROLE === "maintenance";


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

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  });
  res.end(body);
}

function normalizeOpportunityLane(value: string | null): OpportunityLane {
  return value === "developing_6h" || value === "broader_24h" || value === "structural"
    ? value
    : "urgent_2h";
}

let strategyPolicyCache: { at:number; value:any } | null = null;
const STRATEGY_POLICY_CACHE_MS = Math.max(30_000, Number(process.env.STRATEGY_POLICY_CACHE_MS || 300_000));

function strategyDomainForCategory(category: string) {
  const value = String(category || "other").toLowerCase();
  if (["politics","elections"].includes(value)) return "political";
  if (["sports","nba","basketball","soccer","games_esports"].includes(value)) return "sports";
  if (value === "crypto") return "crypto";
  if (value === "weather") return "weather";
  return "other";
}

async function getProductionStrategyPolicy(force = false) {
  if (!force && strategyPolicyCache && Date.now() - strategyPolicyCache.at < STRATEGY_POLICY_CACHE_MS) {
    return strategyPolicyCache.value;
  }

  const calibrationSummary = await getHistoricalCalibrationSummary().catch(() => null) as any;
  const minUsableCoveragePct = Math.max(
    50,
    Math.min(100, Number(process.env.CAUSAL_V2_MIN_USABLE_COVERAGE_PCT || 80))
  );
  const usableCoveragePct = Number(calibrationSummary?.causalV2UsableCoveragePct || 0);
  const calibrationComplete =
    Number(calibrationSummary?.sampleCount || 0) > 0 &&
    Number(calibrationSummary?.causalV2Remaining || 0) === 0 &&
    usableCoveragePct >= minUsableCoveragePct;

  const domains = ["sports","crypto","weather","other"] as const;

  if (!calibrationComplete) {
    const causalByDomain: Record<string, number> = {
      sports:Number(calibrationSummary?.causalV2SportsSamples || 0),
      crypto:Number(calibrationSummary?.causalV2CryptoSamples || 0),
      weather:Number(calibrationSummary?.causalV2WeatherSamples || 0),
      other:Number(calibrationSummary?.causalV2OtherSamples || 0)
    };
    const perDomain = Object.fromEntries(domains.map(domain => [domain,{
      enabled:false,
      sampleCount:causalByDomain[domain] || 0,
      reason:"causal_v2_rebuild_incomplete",
      calendarWalkForward:null,
      sampleWalkForward:null,
      calibratedResearch:null
    }]));

    const policy = {
      generatedAt:new Date().toISOString(),
      sampleCount:Object.values(causalByDomain).reduce((sum,value)=>sum+value,0),
      calibration:{
        version:HISTORICAL_CALIBRATION_VERSION,
        complete:false,
        progressPct:Number(calibrationSummary?.causalV2ProgressPct || 0),
        remaining:Number(calibrationSummary?.causalV2Remaining || 0),
        totalRows:Number(calibrationSummary?.sampleCount || 0),
        causalRows:Number(calibrationSummary?.causalV2Samples || 0),
        excludedRows:Number(calibrationSummary?.causalV2Excluded || 0),
        usableCoveragePct,
        minUsableCoveragePct,
        rebuildProgressPct:Number(calibrationSummary?.causalRebuildProgressPct || 0)
      },
      structuralStrategiesEnabled:true,
      directionalProbabilityModelEnabled:false,
      directionalProbabilityModelScope:"domain_specific",
      enabledDomains:[],
      blockedDomains:[...domains],
      perDomain,
      political:{
        directionalProbabilityModelEnabled:false,
        reason:"political_directional_execution_disabled"
      },
      enforcement:{
        liveStructuralExecution:"allowed_when_depth_and_buffer_checks_pass",
        directionalProbabilityExecution:"blocked",
        gptMayOverrideGate:false
      }
    };
    strategyPolicyCache={at:Date.now(),value:policy};
    return policy;
  }

  const replays = await Promise.all(domains.map(async domain => {
    const replay = await runHistoricalReplay({
      years:3,
      horizon:"tMinus60m",
      threshold:0.9,
      bufferBps:Number(process.env.OPPORTUNITY_BUFFER_BPS || 50),
      domains:[domain]
    });
    return [domain,replay] as const;
  }));

  const perDomain: Record<string, any> = {};
  let totalSamples = 0;

  for (const [domain,replay] of replays) {
    totalSamples += Number(replay.sampleCount || 0);
    const walk = replay.walkForward as any;
    const calendarWalk = replay.calendarWalkForward as any;
    const calibrated = replay.calibrated as any;
    const enabled = calibrationComplete && calendarWalk?.deployable === true;
    perDomain[domain] = {
      enabled,
      sampleCount:replay.sampleCount,
      reason:!calibrationComplete
        ? "causal_v2_rebuild_incomplete"
        : calendarWalk?.reason || "calendar_walk_forward_unavailable",
      calendarWalkForward:{
        deployable:enabled,
        selectedPolicy:calendarWalk?.selectedPolicy ?? null,
        foldSummary:calendarWalk?.foldSummary ?? null,
        holdout:calendarWalk?.holdout ?? null,
        holdoutDaily:calendarWalk?.holdoutDaily ?? null,
        diagnostics:calendarWalk?.diagnostics ?? null,
        requirements:calendarWalk?.requirements ?? null
      },
      sampleWalkForward:{
        deployable:walk?.deployable === true,
        selectedPolicy:walk?.selectedPolicy ?? null,
        foldSummary:walk?.foldSummary ?? null,
        holdout:walk?.holdout ?? null,
        holdoutDaily:walk?.holdoutDaily ?? null,
        requirements:walk?.requirements ?? null
      },
      calibratedResearch:{
        deployable:calibrated?.deployable === true,
        validation:calibrated?.validation ?? null,
        holdout:calibrated?.holdout ?? null,
        reason:calibrated?.reason ?? null
      }
    };
  }

  const enabledDomains = domains.filter(domain => perDomain[domain]?.enabled === true);
  const policy = {
    generatedAt:new Date().toISOString(),
    sampleCount:totalSamples,
    calibration:{
      version:HISTORICAL_CALIBRATION_VERSION,
      complete:calibrationComplete,
      progressPct:Number(calibrationSummary?.causalV2ProgressPct || 0),
      remaining:Number(calibrationSummary?.causalV2Remaining || 0),
      totalRows:Number(calibrationSummary?.sampleCount || 0),
      causalRows:Number(calibrationSummary?.causalV2Samples || 0),
      excludedRows:Number(calibrationSummary?.causalV2Excluded || 0),
      usableCoveragePct,
      minUsableCoveragePct,
      rebuildProgressPct:Number(calibrationSummary?.causalRebuildProgressPct || 0)
    },
    structuralStrategiesEnabled:true,
    directionalProbabilityModelEnabled:enabledDomains.length > 0,
    directionalProbabilityModelScope:"domain_specific",
    enabledDomains,
    blockedDomains:domains.filter(domain => !enabledDomains.includes(domain)),
    perDomain,
    political:{
      directionalProbabilityModelEnabled:false,
      reason:"political_directional_execution_disabled"
    },
    enforcement:{
      liveStructuralExecution:"allowed_when_depth_and_buffer_checks_pass",
      directionalProbabilityExecution:enabledDomains.length
        ? "allowed_only_for_enabled_domains"
        : "blocked",
      gptMayOverrideGate:false
    }
  };

  strategyPolicyCache = {at:Date.now(),value:policy};
  return policy;
}

function candidateLiquidityCapacity(candidate: ScanCandidate) {
  const books = Array.isArray(candidate.books) ? candidate.books : [];
  const outcomes = books.map(book => {
    const executions = Array.isArray(book.executions) ? book.executions : [];
    const full = executions
      .filter(execution => Number(execution.fillPct || 0) >= 99.9 && Number(execution.spendableUsd || 0) > 0)
      .sort((a,b)=>Number(a.budgetUsd)-Number(b.budgetUsd));
    const bestFull = full[full.length-1] || null;
    const bestAsk = Number(book.bestAsk);
    const avgFill = bestFull?.avgFillPrice == null ? null : Number(bestFull.avgFillPrice);
    const slippageBps =
      Number.isFinite(bestAsk) && bestAsk > 0 && avgFill !== null && Number.isFinite(avgFill)
        ? Math.max(0, ((avgFill - bestAsk) / bestAsk) * 10_000)
        : null;
    return {
      outcome:book.outcome,
      tokenId:book.tokenId,
      bestAsk:Number.isFinite(bestAsk) ? bestAsk : null,
      askDepthUsdTop5:Number(book.askDepthUsdTop5 || 0),
      maxTestedFullFillUsd:bestFull ? Number(bestFull.spendableUsd || bestFull.budgetUsd || 0) : 0,
      avgFillPrice:avgFill,
      slippageBps:slippageBps === null ? null : Number(slippageBps.toFixed(2)),
      executionCurve:executions.map(execution => ({
        budgetUsd:Number(execution.budgetUsd || 0),
        spendableUsd:Number(execution.spendableUsd || 0),
        fillPct:Number(execution.fillPct || 0),
        avgFillPrice:execution.avgFillPrice == null ? null : Number(execution.avgFillPrice)
      }))
    };
  });

  const conservative = outcomes
    .filter(outcome => outcome.bestAsk !== null)
    .sort((a,b)=>b.maxTestedFullFillUsd-a.maxTestedFullFillUsd)[0] || null;

  return {
    conditionId:candidate.conditionId,
    slug:candidate.slug,
    question:candidate.question,
    category:candidate.primaryCategory,
    minutesRemaining:candidate.minutesRemaining,
    liquidityUsd:candidate.liquidityUsd,
    conservativeOutcome:conservative?.outcome ?? null,
    conservativeTokenId:conservative?.tokenId ?? null,
    maxTestedFullFillUsd:conservative?.maxTestedFullFillUsd ?? 0,
    top5AskDepthUsd:conservative?.askDepthUsdTop5 ?? 0,
    testedSlippageBps:conservative?.slippageBps ?? null,
    outcomes
  };
}

async function getLiquidityCapacity(lane: OpportunityLane, limit = 100) {
  const latest = await getLatestMultiHorizonSnapshot();
  if (!latest) {
    return { generatedAt:null,lane,researchOnly:true,error:"no_scanner_snapshot_yet",markets:[] };
  }

  let candidates:ScanCandidate[] = [];
  if (lane === "urgent_2h") candidates = latest.lanes?.urgent2h?.candidates || [];
  else if (lane === "developing_6h") candidates = latest.lanes?.developing6h?.candidates || [];
  else if (lane === "broader_24h") candidates = latest.lanes?.broader24h?.candidates || [];
  else candidates = latest.structuralUniverse?.binary || [];

  const policy = await getProductionStrategyPolicy().catch(() => null) as any;
  const markets = candidates
    .slice(0,Math.max(1,Math.min(500,limit)))
    .map(candidateLiquidityCapacity)
    .sort((a,b)=>b.maxTestedFullFillUsd-a.maxTestedFullFillUsd);

  const totalMaxTestedFullFillUsd = markets.reduce((sum,row)=>sum+Number(row.maxTestedFullFillUsd||0),0);
  const totalTop5AskDepthUsd = markets.reduce((sum,row)=>sum+Number(row.top5AskDepthUsd||0),0);
  const laneWindowHours =
    lane === "urgent_2h" ? 2 :
    lane === "developing_6h" ? 6 :
    lane === "broader_24h" ? 24 :
    null;

  const byDomainBase:Record<string,{markets:number;maxTestedFullFillUsd:number;top5AskDepthUsd:number}> = {};
  for(const row of markets){
    const domain = strategyDomainForCategory(row.category);
    const item = byDomainBase[domain] || {markets:0,maxTestedFullFillUsd:0,top5AskDepthUsd:0};
    item.markets += 1;
    item.maxTestedFullFillUsd += Number(row.maxTestedFullFillUsd||0);
    item.top5AskDepthUsd += Number(row.top5AskDepthUsd||0);
    byDomainBase[domain]=item;
  }

  const targetProfits = [100,500,1000];
  const byDomain = Object.fromEntries(
    Object.entries(byDomainBase).map(([domain,item]) => {
      const stationaryDailyTurnoverUpperBoundUsd = laneWindowHours
        ? Number((item.maxTestedFullFillUsd * (24 / laneWindowHours)).toFixed(2))
        : null;
      const domainPolicy = policy?.perDomain?.[domain];
      const productionEnabled = domain !== "political" && domainPolicy?.enabled === true;
      const validatedRoiPct = productionEnabled
        ? Number(domainPolicy?.calendarWalkForward?.holdout?.roiPct || 0)
        : null;
      const targetPnlScenarios = Object.fromEntries(targetProfits.map(targetUsd => {
        if (!productionEnabled || !(validatedRoiPct && validatedRoiPct > 0)) {
          return [`target${targetUsd}`,{
            targetNetPnlUsd:targetUsd,
            available:false,
            reason:productionEnabled
              ? "validated_positive_roi_unavailable"
              : "production_directional_gate_blocked"
          }];
        }
        const requiredTurnoverUsd = targetUsd / (validatedRoiPct / 100);
        return [`target${targetUsd}`,{
          targetNetPnlUsd:targetUsd,
          available:true,
          validatedRoiPct,
          requiredTurnoverUsd:Number(requiredTurnoverUsd.toFixed(2)),
          stationaryCapacityUpperBoundUsd:stationaryDailyTurnoverUpperBoundUsd,
          upperBoundCoversRequiredTurnover:
            stationaryDailyTurnoverUpperBoundUsd !== null &&
            stationaryDailyTurnoverUpperBoundUsd >= requiredTurnoverUsd
        }];
      }));

      return [domain,{
        ...item,
        stationaryDailyTurnoverUpperBoundUsd,
        productionEnabled,
        validatedRoiPct,
        targetPnlScenarios
      }];
    })
  );

  return {
    generatedAt:latest.generatedAt,
    ageSeconds:latest.ageSeconds ?? null,
    lane,
    researchOnly:policy?.directionalProbabilityModelEnabled !== true,
    policyGate:{
      directionalProbabilityModelEnabled:policy?.directionalProbabilityModelEnabled === true,
      enabledDomains:policy?.enabledDomains || [],
      calibration:policy?.calibration || null
    },
    totals:{
      markets:markets.length,
      totalMaxTestedFullFillUsd:Number(totalMaxTestedFullFillUsd.toFixed(2)),
      totalTop5AskDepthUsd:Number(totalTop5AskDepthUsd.toFixed(2)),
      laneWindowHours,
      stationaryDailyTurnoverUpperBoundUsd:laneWindowHours
        ? Number((totalMaxTestedFullFillUsd * (24 / laneWindowHours)).toFixed(2))
        : null
    },
    capacityInterpretation:{
      type:"upper_bound_not_forecast",
      note:"Daily turnover upper bound scales the current window's tested full-fill capacity by 24/windowHours. It assumes replacement of observed markets and does not assume every market produces a valid strategy signal. Profit-target scenarios are withheld until the domain passes the production calendar gate."
    },
    byDomain,
    markets
  };
}

async function findSnapshotCandidateForTrade(input:{
  conditionId?:string;
  tokenId:string;
  marketSlug?:string;
}) {
  const latest=await getLatestMultiHorizonSnapshot();
  if(!latest) return null;
  const pools:ScanCandidate[][]=[
    latest.lanes?.urgent2h?.candidates || [],
    latest.lanes?.developing6h?.candidates || [],
    latest.lanes?.broader24h?.candidates || [],
    latest.structuralUniverse?.binary || []
  ];
  const seen=new Set<string>();
  for(const candidates of pools){
    for(const candidate of candidates){
      const key=candidate.conditionId || candidate.id || candidate.slug || candidate.question;
      if(seen.has(key)) continue;
      seen.add(key);
      if(
        (input.conditionId && candidate.conditionId===input.conditionId) ||
        (input.marketSlug && candidate.slug===input.marketSlug) ||
        candidate.tokenIds.includes(input.tokenId)
      ) return candidate;
    }
  }
  return null;
}

async function validateTradeIntentPolicy(input:{
  conditionId?:string;
  tokenId:string;
  marketSlug?:string;
  strategyType:"directional"|"structural";
}) {
  const candidate=await findSnapshotCandidateForTrade(input);
  if(!candidate) {
    return {ok:false as const,reason:"market_not_in_fresh_scanner_snapshot"};
  }
  const domain=strategyDomainForCategory(candidate.primaryCategory);
  if(domain==="political") {
    return {ok:false as const,reason:"political_directional_execution_disabled",domain};
  }

  if(input.strategyType==="structural"){
    const verified=candidate.opportunityClass==="executable_structural";
    return verified
      ? {ok:true as const,domain,candidate,policyType:"structural" as const}
      : {ok:false as const,reason:"structural_edge_not_depth_verified",domain,candidate};
  }

  const policy=await getProductionStrategyPolicy(true) as any;
  const domainPolicy=policy?.perDomain?.[domain];
  if(policy?.calibration?.complete!==true) {
    return {ok:false as const,reason:"causal_v2_rebuild_incomplete",domain,policy};
  }
  if(domainPolicy?.enabled!==true) {
    return {ok:false as const,reason:domainPolicy?.reason || "directional_domain_gate_failed",domain,policy};
  }
  return {ok:true as const,domain,candidate,policyType:"directional" as const,policy};
}

async function loadUnifiedOpportunities(lane: OpportunityLane, limit = 50) {
  const latest = await getLatestMultiHorizonSnapshot();
  if (!latest) return { generatedAt: null, lane, opportunities: [] };

  let candidates: ScanCandidate[] = [];
  if (lane === "urgent_2h") candidates = latest.lanes?.urgent2h?.candidates || [];
  else if (lane === "developing_6h") candidates = latest.lanes?.developing6h?.candidates || [];
  else if (lane === "broader_24h") candidates = latest.lanes?.broader24h?.candidates || [];
  else candidates = latest.structuralUniverse?.binary || [];

  const policy = await getProductionStrategyPolicy().catch(error => ({
    generatedAt:new Date().toISOString(),
    structuralStrategiesEnabled:true,
    directionalProbabilityModelEnabled:false,
    directionalReason:"policy_evaluation_failed",
    error:errorMessage(error),
    enforcement:{
      liveStructuralExecution:"allowed_when_depth_and_buffer_checks_pass",
      directionalProbabilityExecution:"blocked",
      gptMayOverrideGate:false
    }
  }));

  return {
    generatedAt: latest.generatedAt,
    ageSeconds: latest.ageSeconds ?? null,
    lane,
    strategyPolicy:policy,
    opportunities: candidates
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(candidate => buildUnifiedOpportunity(candidate, lane, latest.generatedAt))
      .map(opportunity => {
        const domain = strategyDomainForCategory(opportunity.market.category);
        const enabled = domain !== "political" && policy?.perDomain?.[domain]?.enabled === true;
        return {
          ...opportunity,
          strategyGate:{
            domain,
            directionalProbabilityEnabled:enabled,
            reason:domain === "political"
              ? "political_directional_execution_disabled"
              : policy?.perDomain?.[domain]?.reason || "domain_policy_unavailable"
          }
        };
      })
  };
}

async function runHistoricalReplay(options: {
  years?: number;
  horizon?: string;
  threshold?: number;
  trainFraction?: number;
  bufferBps?: number;
  domains?: string[];
}) {
  const years = Math.max(0.25, Math.min(10, Number(options.years ?? 3)));
  const horizon = options.horizon || "tMinus60m";
  const threshold = Math.max(0.5, Math.min(0.999, Number(options.threshold ?? 0.75)));
  const samples = await getHistoricalReplaySamples({
    years,
    domains: options.domains,
    limit: 100000,
    calibrationVersion: HISTORICAL_CALIBRATION_VERSION
  });
  return {
    years,
    calibrationVersion: HISTORICAL_CALIBRATION_VERSION,
    sampleCount: samples.length,
    backtest: runProbabilityThresholdBacktest(samples, {
      horizon,
      threshold,
      trainFraction: options.trainFraction ?? 0.7,
      bufferBps: options.bufferBps ?? 50,
      domains: options.domains
    }),
    sweep: sweepProbabilityThresholds(samples, {
      horizon,
      thresholds: [0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95],
      trainFraction: options.trainFraction ?? 0.7,
      bufferBps: options.bufferBps ?? 50,
      domains: options.domains
    }),
    calibrated: runCalibratedEdgeBacktest(samples, {
      horizon,
      trainFraction: 0.6,
      validationFraction: 0.2,
      bufferBps: options.bufferBps ?? 50,
      domains: options.domains,
      thresholds: [0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95],
      minEdgesBps: [0,25,50,100,150,200,300],
      minBinSamples: 20,
      minValidationTrades: 40,
      minValidationHitRatePct: 95,
      minHoldoutTrades: 50
    }),
    walkForward: runWalkForwardEdgeBacktest(samples, {
      horizon,
      bufferBps: options.bufferBps ?? 50,
      domains: options.domains,
      thresholds: [0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95],
      minEdgesBps: [0,25,50,100,150,200,300],
      minBinSamples: 20,
      walkForwardFolds: 4,
      minFoldTrades: 30,
      minFoldRoiPct: 0.25,
      minFoldHitRatePct: 95,
      minHoldoutTrades: 100,
      minHoldoutRoiPct: 0.25
    }),
    calendarWalkForward: runCalendarWalkForwardEdgeBacktest(samples, {
      horizon,
      bufferBps: options.bufferBps ?? 50,
      domains: options.domains,
      thresholds: [0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95],
      minEdgesBps: [0,25,50,100,150,200,300],
      minBinSamples: 20,
      calendarLookbackDays: 180,
      calendarFoldDays: 30,
      calendarHoldoutDays: 30,
      minFoldTrades: 30,
      minFoldRoiPct: 0.25,
      minFoldHitRatePct: 95,
      minFoldActiveDays: 5,
      minFoldProfitableDayPct: 80,
      minHoldoutTrades: 100,
      minHoldoutRoiPct: 0.25,
      minValidationHitRatePct: 95,
      minHoldoutActiveDays: 10,
      minHoldoutProfitableDayPct: 90
    })
  };
}

function extractOpenAIText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const parts = Array.isArray(payload?.output)
    ? payload.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    : [];
  return parts.map((part: any) => part?.text || part?.output_text || "").filter(Boolean).join("\n");
}

async function askOpenAI(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY_not_configured");
  const latest = await loadUnifiedOpportunities("urgent_2h", 20);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.6",
      input: [
        {
          role: "system",
          content:
            "You are the analysis layer for a Polymarket research dashboard. Use only the supplied market data and production strategy policy. Structural execution edges may be discussed when depth and buffer checks pass. Directional probability/calibration signals are domain-gated: only treat them as executable when that opportunity's strategyGate.directionalProbabilityEnabled is true. Never override a blocked domain gate, never generalize a passing sports/crypto/weather/other model to another domain, and never present a blocked model as executable. Distinguish structural execution edge from directional speculation, mention uncertainty, and do not claim guaranteed returns. For political or election markets, remain strictly descriptive and structural-only: do not predict winners, rank candidates or parties, recommend positions, assess electability, or provide directional trading advice."
        },
        {
          role: "user",
          content: `${prompt}\n\nProduction strategy policy:\n${JSON.stringify(latest.strategyPolicy)}\n\nCurrent unified opportunities:\n${JSON.stringify(latest.opportunities)}`
        }
      ]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`openai_${response.status}: ${JSON.stringify(payload)}`);
  return { text: extractOpenAIText(payload), responseId: payload?.id ?? null };
}

async function runOpenAISelfTest() {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) return { ok: false as const, configured: false, reason: "OPENAI_API_KEY_not_configured" };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.6",
      input: "Reply with exactly OK."
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`openai_self_test_${response.status}: ${JSON.stringify(payload)}`);
  }

  return {
    ok: true as const,
    configured: true,
    model: process.env.OPENAI_MODEL || "gpt-5.6",
    responseId: payload?.id ?? null
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function controlTokenAuthorized(req: IncomingMessage) {
  const configured = String(process.env.DASHBOARD_CONTROL_TOKEN || "").trim();
  if (!configured) return { ok: false as const, reason: "dashboard_control_token_not_configured" };
  const auth = String(req.headers.authorization || "");
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!supplied || supplied !== configured) return { ok: false as const, reason: "unauthorized" };
  return { ok: true as const };
}

function requireControlToken(req: IncomingMessage, res: ServerResponse) {
  const result = controlTokenAuthorized(req);
  if (result.ok) return true;
  json(res, result.reason === "dashboard_control_token_not_configured" ? 503 : 401, {
    error: result.reason
  });
  return false;
}

async function runMcpSelfTest() {
  const endpoint = new URL(`http://127.0.0.1:${PORT}/mcp`);
  const client = new Client({
    name: "zoey-polymarket-self-test",
    version: VERSION
  });
  const transport = new StreamableHTTPClientTransport(endpoint);
  const started = Date.now();
  const timeoutMs = Math.max(1000, Number(process.env.MCP_SELF_TEST_TIMEOUT_MS || 8000));

  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const result = await client.listTools();
        const names = result.tools.map(tool => tool.name).sort();
        return {
          ok: true as const,
          endpoint: "/mcp",
          transport: "streamable-http",
          toolCount: names.length,
          tools: names,
          latencyMs: Date.now() - started
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mcp_self_test_timeout")), timeoutMs);
      })
    ]);
  } catch (error) {
    return {
      ok: false,
      endpoint: "/mcp",
      transport: "streamable-http",
      latencyMs: Date.now() - started,
      error: errorMessage(error)
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

async function runSystemAudit() {
  const findings: AuditFinding[] = [];

  const started = Date.now();
  const scan = await scanClosingSoon({
    maxMinutes: 120,
    minLiquidity: 0,
    includeOrderBooks: true,
    limit: 500,
    sort: "opportunity",
    bufferBps: Number(process.env.OPPORTUNITY_BUFFER_BPS || 50)
  });
  findings.push(...auditScanResult(scan));

  const maxScanMs = Math.max(1000, Number(process.env.AUDIT_MAX_SCAN_MS || 15000));
  findings.push({
    id: "scan_latency",
    ok: (scan.scanDurationMs ?? Date.now() - started) <= maxScanMs,
    severity: "warning",
    detail: `scanDurationMs=${scan.scanDurationMs ?? Date.now() - started}, max=${maxScanMs}`
  });

  const persistenceConnection = await testPersistenceConnection().catch(error => ({
    configured: true,
    ok: false,
    error: errorMessage(error)
  }));
  findings.push({
    id: "persistence_connection",
    ok: (persistenceConnection as any).ok === true,
    severity: "critical",
    detail: JSON.stringify(persistenceConnection)
  });

  const integrity = await getPersistenceIntegrity().catch(error => ({
    configured: true,
    error: errorMessage(error)
  })) as any;
  const maxHistoryAge = Math.max(60, Number(process.env.AUDIT_MAX_HISTORY_AGE_SECONDS || 180));
  findings.push({
    id: "history_freshness",
    ok: typeof integrity.ageSeconds === "number" && integrity.ageSeconds <= maxHistoryAge,
    severity: "critical",
    detail: `ageSeconds=${integrity.ageSeconds ?? "unknown"}, max=${maxHistoryAge}`
  });
  findings.push({
    id: "history_duplicate_timestamps",
    ok: Number(integrity.duplicateTimestamps || 0) === 0,
    severity: "warning",
    detail: `duplicateTimestamps=${integrity.duplicateTimestamps ?? "unknown"}`
  });

  findings.push({
    id: "single_persistence_writer",
    ok: Number(integrity.activeWriterCount || 0) <= 1,
    severity: "critical",
    detail: `activeWriterCount=${integrity.activeWriterCount ?? "unknown"}, leaseHolder=${integrity.leaseHolder ?? "none"}`
  });

  const recentInterval = Number(integrity.recentAvgIntervalSeconds);
  const expectedScanSeconds = Math.max(30, Number(process.env.BACKGROUND_SCAN_SECONDS || 60));
  const cadenceMin = expectedScanSeconds * 0.5;
  const cadenceMax = expectedScanSeconds * 1.75;
  findings.push({
    id: "recent_scan_cadence",
    ok: !Number.isFinite(recentInterval) || (recentInterval >= cadenceMin && recentInterval <= cadenceMax),
    severity: "warning",
    detail: `recentAvgIntervalSeconds=${integrity.recentAvgIntervalSeconds ?? "unknown"}, expectedSeconds=${expectedScanSeconds}`
  });

  const mcpSelfTest = await runMcpSelfTest();
  findings.push({
    id: "mcp_transport_handshake",
    ok: mcpSelfTest.ok === true && Number((mcpSelfTest as any).toolCount || 0) > 0,
    severity: "critical",
    detail: JSON.stringify(mcpSelfTest)
  });

  const workerHeartbeats = await getWorkerHeartbeats().catch(() => []);
  if (SERVICE_ROLE === "api") {
    const requiredRoles = ["scanner", "streams", "history", "maintenance"];
    const freshnessMs = Math.max(30_000, Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS || 60_000));
    const staleRoles = requiredRoles.filter(role => {
      const heartbeat = workerHeartbeats.find(item => item.role === role);
      if (!heartbeat?.updatedAt) return true;
      return Date.now() - Date.parse(heartbeat.updatedAt) > freshnessMs;
    });
    findings.push({
      id: "distributed_worker_heartbeats",
      ok: staleRoles.length === 0,
      severity: "critical",
      detail: `staleOrMissing=${staleRoles.join(",") || "none"}, maxAgeMs=${freshnessMs}`
    });
  }

  const streamPersistence = await getStreamPersistenceStats().catch(error => ({
    configured: true,
    error: errorMessage(error),
    realtimeQuoteRows: 0,
    lastRealtimeQuoteAt: null,
    sportsEventRows: 0,
    lastSportsEventAt: null
  })) as any;
  const targetStats = await getRealtimeTargetStats().catch(() => ({
    activeTargets: 0,
    storedTargets: 0
  })) as any;

  let realtime: any = null;
  let sports: any = null;

  if (ROLE_STREAMS) {
    sports = sportsTracker.getHealth();
    findings.push({
      id: "sports_feed_connection",
      ok: sports.state === "streaming" || sports.state === "connecting",
      severity: "warning",
      detail: `state=${sports.state}, cachedEvents=${sports.cachedEvents}, lastError=${sports.lastError ?? "none"}`
    });

    if (sports.sportResultCount > 0) {
      const sportsAgeSeconds = streamPersistence.lastSportsEventAt
        ? Math.max(0, (Date.now() - Date.parse(streamPersistence.lastSportsEventAt)) / 1000)
        : Infinity;
      findings.push({
        id: "sports_event_persistence",
        ok: sportsAgeSeconds <= 120,
        severity: "warning",
        detail: `rows=${streamPersistence.sportsEventRows}, ageSeconds=${Number.isFinite(sportsAgeSeconds) ? sportsAgeSeconds.toFixed(2) : "missing"}`
      });
    }

    realtime = realtimeTracker.getHealth();
    if (realtime.subscribedTokens > 0 && realtime.cachedQuotes > 0) {
      const quoteAgeSeconds = streamPersistence.lastRealtimeQuoteAt
        ? Math.max(0, (Date.now() - Date.parse(streamPersistence.lastRealtimeQuoteAt)) / 1000)
        : Infinity;
      findings.push({
        id: "realtime_quote_persistence",
        ok: quoteAgeSeconds <= 30,
        severity: "critical",
        detail: `rows=${streamPersistence.realtimeQuoteRows}, ageSeconds=${Number.isFinite(quoteAgeSeconds) ? quoteAgeSeconds.toFixed(2) : "missing"}`
      });
    }
  } else if (SERVICE_ROLE === "api") {
    const streamsHeartbeat = workerHeartbeats.find(item => item.role === "streams");
    const streamDetails = (streamsHeartbeat?.details || {}) as any;
    sports = streamDetails.sports ?? null;
    realtime = streamDetails.realtime ?? null;

    if (sports) {
      findings.push({
        id: "sports_feed_connection",
        ok: sports.state === "streaming" || sports.state === "connecting",
        severity: "warning",
        detail: `distributedState=${sports.state}, cachedEvents=${sports.cachedEvents ?? 0}`
      });
    }

    if (Number(targetStats.activeTargets || 0) > 0) {
      const quoteAgeSeconds = streamPersistence.lastRealtimeQuoteAt
        ? Math.max(0, (Date.now() - Date.parse(streamPersistence.lastRealtimeQuoteAt)) / 1000)
        : Infinity;
      findings.push({
        id: "realtime_quote_persistence",
        ok: quoteAgeSeconds <= 45,
        severity: "critical",
        detail: `targets=${targetStats.activeTargets}, rows=${streamPersistence.realtimeQuoteRows}, ageSeconds=${Number.isFinite(quoteAgeSeconds) ? quoteAgeSeconds.toFixed(2) : "missing"}`
      });

      if (realtime) {
        findings.push({
          id: "realtime_subscription_consistency",
          ok: Number(realtime.subscribedTokens || 0) >= Number(targetStats.activeTargets || 0) || realtime.state === "connecting",
          severity: "warning",
          detail: `targets=${targetStats.activeTargets}, subscribed=${realtime.subscribedTokens ?? 0}, state=${realtime.state ?? "unknown"}`
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: summarizeAudit(findings),
    findings,
    scan: {
      totalActiveMarketsScanned: scan.totalActiveMarketsScanned,
      totalInWindow: scan.totalInWindowBeforeFilters,
      returned: scan.returned,
      scanDurationMs: scan.scanDurationMs
    },
    persistence: integrity,
    streamPersistence,
    realtimeTargets: targetStats,
    workerHeartbeats,
    realtime,
    sports
  };
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
    "markets.scan_multi_horizon",
    {
      description: "Return the latest persisted exhaustive multi-horizon scan produced by the dedicated scanner worker. This is intentionally served from Neon so the API stays responsive instead of rescanning the full universe synchronously.",
      inputSchema: {
        maxAgeSeconds: z.number().int().min(1).max(3600).default(300)
      }
    },
    async input => {
      const latest = await getLatestMultiHorizonSnapshot();
      if (!latest) {
        return textResult({
          ok: false,
          reason: "no_scanner_snapshot_yet",
          stats: await getMultiHorizonSnapshotStats()
        });
      }
      return textResult({
        ok: true,
        stale: Number(latest.ageSeconds || 0) > input.maxAgeSeconds,
        maxAgeSeconds: input.maxAgeSeconds,
        snapshot: latest
      });
    }
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
    "markets.external_evidence",
    {
      description: "For supported short-dated crypto threshold questions, cross-check independent Coinbase and Kraken public spot data and report threshold distance/source divergence. Descriptive only; no win probability or outcome recommendation.",
      inputSchema: {
        question: z.string().min(1)
      }
    },
    async input => textResult({
      question: input.question,
      evidence: await getExternalCryptoEvidence(input.question)
    })
  );

  server.registerTool(
    "markets.research_packet",
    {
      description: "Build one read-only research packet for a Polymarket market: resolution rules/source, live CLOB books, price regimes, recent trade flow, and durable prior observations. Descriptive only; it does not choose or recommend an outcome.",
      inputSchema: {
        slug: z.string().min(1),
        historyHours: z.number().int().min(1).max(168).default(6),
        fidelityMinutes: z.number().int().min(1).max(60).default(5)
      }
    },
    async input => {
      const market = await getMarketBySlug(input.slug);
      if (!market) return textResult({ ok: false, reason: "market_not_found", slug: input.slug });

      const tokenIds = parseStringArray(market.clobTokenIds);
      const outcomes = parseStringArray(market.outcomes);
      const books = tokenIds.length ? await getOrderBooks(tokenIds) : new Map();
      const history = await Promise.all(tokenIds.map(async tokenId => {
        const payload = await getPriceHistory(tokenId, input.historyHours, input.fidelityMinutes).catch(() => null);
        return {
          tokenId,
          analysis: payload ? analyzePriceHistoryPayload(payload) : null
        };
      }));

      const conditionId = market.conditionId ? String(market.conditionId) : null;
      const trades = conditionId
        ? await getRecentTrades(conditionId, 200).catch(() => [])
        : [];
      const historical = conditionId
        ? (await getHistoricalCandidateStats([conditionId]).catch(() => new Map())).get(conditionId) ?? null
        : null;

      return textResult({
        ok: true,
        market: {
          id: market.id ?? null,
          slug: market.slug ?? input.slug,
          question: market.question ?? null,
          conditionId,
          endDate: market.endDateIso ?? market.endDate ?? null,
          active: market.active ?? null,
          closed: market.closed ?? null,
          acceptingOrders: market.acceptingOrders ?? null,
          resolutionSource: market.resolutionSource ?? null,
          resolutionRules: market.description ?? null,
          outcomes,
          displayedOutcomePrices: parseNumberArray(market.outcomePrices),
          tokenIds
        },
        books: tokenIds.map((tokenId, index) => {
          const book = books.get(tokenId);
          return {
            outcome: outcomes[index] ?? `Outcome ${index + 1}`,
            tokenId,
            bestBid: book?.bestBid ?? null,
            bestAsk: book?.bestAsk ?? null,
            spread: book?.spread ?? null,
            bidDepthUsdTop5: book?.bidDepthUsdTop5 ?? 0,
            askDepthUsdTop5: book?.askDepthUsdTop5 ?? 0
          };
        }),
        priceRegimes: history,
        tradeFlow: analyzeTradeFlowPayload(trades),
        historicalEvidence: historical,
        independentExternalEvidence: await getExternalCryptoEvidence(String(market.question || "")).catch(() => null),
        liveSportsEvidence: sportsTracker.matchQuestion(String(market.question || ""), 10),
        externalEvidenceNeeded: [
          "Verify the event state using current primary or authoritative sources.",
          "Check the exact resolution wording and source before interpreting evidence.",
          "Compare fresh event evidence with current market pricing; do not infer certainty from market price alone."
        ]
      });
    }
  );

  server.registerTool(
    "sports.board",
    {
      description: "Return the latest grouped sports board from the exhaustive scanner snapshot: live score/period plus moneyline, spread ladders, game totals, team totals, player props, exact-score and score-band markets.",
      inputSchema: {
        sport: z.string().optional(),
        liveOnly: z.boolean().default(false)
      }
    },
    async input => {
      const snapshot = await getLatestMultiHorizonSnapshot();
      const board = buildSportsBoard(snapshot as any);
      const sportNeedle = input.sport?.trim().toUpperCase();
      const games = (board.games || []).filter((game: any) =>
        (!sportNeedle || String(game.sport || "").toUpperCase().includes(sportNeedle)) &&
        (!input.liveOnly || game.liveState?.live === true)
      );
      return textResult({
        ...board,
        games,
        filteredGameCount: games.length
      });
    }
  );

  server.registerTool(
    "sports.live_results",
    {
      description: "Return recent public Polymarket sports feed sport_result events containing live scores, periods, and status. Descriptive event state only.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50)
      }
    },
    async input => textResult({
      health: sportsTracker.getHealth(),
      events: sportsTracker.recent(input.limit)
    })
  );

  server.registerTool(
    "sports.match_question",
    {
      description: "Conservatively match a sports-market question against recent live sports feed events by significant keyword overlap. Returns raw event state and match metadata, not an outcome prediction.",
      inputSchema: {
        question: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async input => textResult({
      question: input.question,
      matches: sportsTracker.matchQuestion(input.question, input.limit),
      health: sportsTracker.getHealth()
    })
  );

  server.registerTool(
    "system.sports_health",
    {
      description: "Return public Polymarket sports WebSocket connection, live-result count, reconnect, and cache health."
    },
    async () => textResult(sportsTracker.getHealth())
  );

  server.registerTool(
    "markets.trade_flow",
    {
      description: "Analyze recent public Data API trades for one market condition ID: notional flow, imbalance, largest trade, recent activity, and a flow-attention score. This is descriptive market behavior, not a winner prediction.",
      inputSchema: {
        conditionId: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async input => {
      const trades = await getRecentTrades(input.conditionId, input.limit);
      return textResult({
        conditionId: input.conditionId,
        analysis: analyzeTradeFlowPayload(trades)
      });
    }
  );

  server.registerTool(
    "markets.price_regime",
    {
      description: "Analyze a token's recent Polymarket price path for trend, volatility, shock behavior, and anomaly score. This describes market behavior only; it is not a directional recommendation.",
      inputSchema: {
        tokenId: z.string().min(1),
        hours: z.number().int().min(1).max(168).default(6),
        fidelityMinutes: z.number().int().min(1).max(60).default(1)
      }
    },
    async input => {
      const history = await getPriceHistory(input.tokenId, input.hours, input.fidelityMinutes);
      return textResult({
        tokenId: input.tokenId,
        hours: input.hours,
        fidelityMinutes: input.fidelityMinutes,
        analysis: analyzePriceHistoryPayload(history)
      });
    }
  );

  server.registerTool(
    "markets.complete_outcome_basket",
    {
      description: "Depth-test a caller-supplied mutually-exclusive and collectively-exhaustive outcome-token basket. Only use token IDs that truly form one complete outcome set. Returns executable equal-share package economics after an execution buffer.",
      inputSchema: {
        tokenIds: z.array(z.string().min(1)).min(2).max(100),
        budgetUsd: z.number().positive().max(100000).default(100),
        bufferBps: z.number().min(0).max(1000).default(50)
      }
    },
    async input => {
      const books = await getOrderBooks(input.tokenIds);
      const ordered = input.tokenIds
        .map(tokenId => books.get(tokenId))
        .filter((book): book is NormalizedBook => Boolean(book));
      if (ordered.length !== input.tokenIds.length) {
        return textResult({
          ok: false,
          reason: "missing_order_book",
          requested: input.tokenIds.length,
          loaded: ordered.length
        });
      }
      return textResult({
        ok: true,
        assumption: "tokenIds are mutually exclusive and collectively exhaustive",
        execution: calculateCompleteOutcomeBasket(ordered, input.budgetUsd, input.bufferBps)
      });
    }
  );

  server.registerTool(
    "markets.realtime_quote",
    {
      description: "Return the latest public Polymarket WebSocket quote cached for a subscribed short-dated outcome token.",
      inputSchema: {
        tokenId: z.string().min(1)
      }
    },
    async input => textResult({
      tokenId: input.tokenId,
      quote: realtimeTracker.getQuote(input.tokenId),
      realtime: realtimeTracker.getHealth()
    })
  );

  server.registerTool(
    "system.realtime_health",
    {
      description: "Return public Polymarket market-WebSocket connection, subscription, message, and reconnect health."
    },
    async () => textResult(realtimeTracker.getHealth())
  );

  server.registerTool(
    "system.resolution_history",
    {
      description: "Return durable finalized-outcome history counts for previously observed markets. This reports completed market outcomes only and does not predict future winners."
    },
    async () => textResult(await getResolutionStats())
  );

  server.registerTool(
    "system.alerts",
    {
      description: "Return durable deduplicated market-structure and behavior alerts such as depth-verified structural edges, price shocks, abnormal flow, and supported external-threshold proximity. Descriptive only; no outcome recommendation.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async input => textResult({
      stats: await getAlertStats(),
      alerts: await getRecentAlerts(input.limit)
    })
  );

  server.registerTool(
    "system.historical_calibration",
    {
      description: "Return historical non-political calibration statistics from resolved sports, crypto, and weather markets at fixed pre-close horizons. Reports empirical Brier error only; no future outcome recommendation."
    },
    async () => textResult(await getHistoricalCalibrationSummary())
  );

  server.registerTool(
    "markets.behavior_backtest",
    {
      description: "Measure empirical continuation versus reversion after large 5-minute Polymarket price shocks using this system's persisted 1-minute quote bars, split by category and 15/30/60-minute horizon.",
      inputSchema: {
        lookbackDays: z.number().int().min(1).max(90).default(14),
        shockThresholdPct: z.number().min(0.5).max(50).default(10),
        minSamples: z.number().int().min(1).max(1000).default(5)
      }
    },
    async input => textResult(await getBehavioralShockBacktest(input))
  );

  server.registerTool(
    "markets.digital_option_fair_value",
    {
      description: "Black-Scholes cash-or-nothing digital comparator for threshold markets. Returns a risk-neutral probability/value from user-supplied spot, strike, implied volatility, time, rates and dividends; it is not a real-world probability forecast.",
      inputSchema: {
        spot: z.number().positive(),
        strike: z.number().positive(),
        volatility: z.number().positive(),
        timeYears: z.number().positive(),
        riskFreeRate: z.number().default(0),
        dividendYield: z.number().default(0),
        direction: z.enum(["above", "below"]).default("above")
      }
    },
    async input => textResult(priceCashOrNothingDigital(input))
  );

  server.registerTool(
    "markets.strategy_policy",
    {
      description: "Return the enforced production strategy policy. Structural strategies remain independently executable when depth/buffer checks pass; directional probability/calibration strategies are blocked unless the walk-forward and untouched holdout gates pass."
    },
    async () => textResult(await getProductionStrategyPolicy())
  );

  server.registerTool(
    "markets.unified_opportunities",
    {
      description: "Return one normalized opportunity schema across urgent, developing, 24-hour, or structural lanes. Includes strategy tags, executable economics, evidence, scores, and risk flags.",
      inputSchema: {
        lane: z.enum(["urgent_2h","developing_6h","broader_24h","structural"]).default("urgent_2h"),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    async input => textResult(await loadUnifiedOpportunities(input.lane, input.limit))
  );

  server.registerTool(
    "markets.historical_replay",
    {
      description: "Run chronological train/holdout replay on resolved non-political historical calibration samples. Reports hit rate, ROI, drawdown and sample counts; it is not a guarantee of future performance.",
      inputSchema: {
        years: z.number().min(0.25).max(10).default(3),
        horizon: z.enum(["tMinus120m","tMinus60m","tMinus30m","tMinus15m","tMinus5m"]).default("tMinus60m"),
        threshold: z.number().min(0.5).max(0.999).default(0.75),
        trainFraction: z.number().min(0.1).max(0.9).default(0.7),
        bufferBps: z.number().min(0).max(5000).default(50),
        domains: z.array(z.enum(["sports","crypto","weather","other"])).optional()
      }
    },
    async input => textResult(await runHistoricalReplay(input))
  );

  server.registerTool(
    "wallet.status",
    {
      description: "Return the configured non-custodial trading wallet profile, control flags, and public Polymarket portfolio. No seed phrase or private key is stored."
    },
    async () => {
      const status = await getWalletControlStatus("primary");
      const profile = await getWalletProfile("primary");
      return textResult({
        ...status,
        portfolio: await getWalletPortfolio(profile)
      });
    }
  );

  server.registerTool(
    "trading.preview_order",
    {
      description: "Preview a Polymarket limit or market order against the live CLOB without submitting it. Calculates visible-depth VWAP, slippage and pre-trade checks. Non-custodial and safe to use before wallet onboarding.",
      inputSchema: {
        tokenId: z.string().min(1),
        side: z.enum(["BUY", "SELL"]),
        orderType: z.enum(["LIMIT", "MARKET"]),
        price: z.number().min(0.0001).max(0.9999).optional(),
        size: z.number().positive().optional(),
        amountUsdc: z.number().positive().optional(),
        maxSlippageBps: z.number().int().min(0).max(5000).default(100)
      }
    },
    async input => textResult(await previewTrade(input))
  );

  server.registerTool(
    "trading.create_intent",
    {
      description: "Stage a validated Polymarket trade intent for the configured wallet. This does NOT submit an order. It remains AWAITING_SIGNATURE and requires the user's wallet signature. Disabled until wallet onboarding is explicitly enabled.",
      inputSchema: {
        conditionId: z.string().optional(),
        tokenId: z.string().min(1),
        marketSlug: z.string().optional(),
        question: z.string().optional(),
        outcome: z.string().optional(),
        strategyType: z.enum(["directional","structural"]).default("directional"),
        side: z.enum(["BUY", "SELL"]),
        orderType: z.enum(["LIMIT", "MARKET"]),
        tif: z.string().optional(),
        price: z.number().min(0.0001).max(0.9999).optional(),
        size: z.number().positive().optional(),
        amountUsdc: z.number().positive().optional(),
        maxSlippageBps: z.number().int().min(0).max(5000).default(100),
        clientRequestId: z.string().optional()
      }
    },
    async input => {
      const strategyGate=await validateTradeIntentPolicy({
        conditionId:input.conditionId,
        tokenId:input.tokenId,
        marketSlug:input.marketSlug,
        strategyType:input.strategyType
      });
      if(!strategyGate.ok){
        return textResult({
          ok:false,
          reason:"production_strategy_gate_failed",
          strategyGate,
          submitted:false,
          signingRequired:false
        });
      }

      const preview = await previewTrade(input);
      const criticalFailures = preview.checks.filter(
        check => check.severity === "critical" && !check.ok
      );
      if (criticalFailures.length) {
        return textResult({
          ok: false,
          reason: "pretrade_checks_failed",
          preview,
          criticalFailures
        });
      }

      const intent = await createTradeIntent({
        walletProfileId: "primary",
        conditionId: input.conditionId ?? null,
        tokenId: input.tokenId,
        marketSlug: input.marketSlug ?? null,
        question: input.question ?? null,
        outcome: input.outcome ?? null,
        side: input.side,
        orderType: input.orderType,
        tif: input.tif ?? null,
        price: input.price ?? null,
        size: input.size ?? null,
        amountUsdc: input.amountUsdc ?? null,
        maxSlippageBps: input.maxSlippageBps,
        preview: {
          ...(preview as unknown as Record<string, unknown>),
          strategyGate:{
            strategyType:input.strategyType,
            domain:strategyGate.domain,
            policyType:strategyGate.policyType
          }
        },
        clientRequestId: input.clientRequestId ?? null
      });

      return textResult({
        ok: true,
        intent,
        signingRequired: true,
        submitted: false
      });
    }
  );

  server.registerTool(
    "trading.stop_all",
    {
      description: "Create a CANCEL_ALL control request for the configured Polymarket wallet. This is the kill-switch path. It does not bypass wallet authorization; the request remains AWAITING_SIGNATURE until the connected signer authorizes Polymarket cancelAll()."
    },
    async () => textResult({
      ok: true,
      request: await createTradingControlRequest({
        walletProfileId: "primary",
        action: "CANCEL_ALL"
      }),
      signingRequired: true,
      submitted: false
    })
  );

  server.registerTool(
    "trading.cancel_order",
    {
      description: "Create an authenticated cancellation request for one Polymarket order. Requires the connected wallet signer before submission.",
      inputSchema: {
        orderId: z.string().min(1)
      }
    },
    async input => textResult({
      ok: true,
      request: await createTradingControlRequest({
        walletProfileId: "primary",
        action: "CANCEL_ORDER",
        orderId: input.orderId
      }),
      signingRequired: true,
      submitted: false
    })
  );

  server.registerTool(
    "trading.cancel_market",
    {
      description: "Create an authenticated request to cancel all open orders for one Polymarket market/condition. Requires the connected wallet signer before submission.",
      inputSchema: {
        marketId: z.string().min(1)
      }
    },
    async input => textResult({
      ok: true,
      request: await createTradingControlRequest({
        walletProfileId: "primary",
        action: "CANCEL_MARKET",
        marketId: input.marketId
      }),
      signingRequired: true,
      submitted: false
    })
  );

  server.registerTool(
    "trading.control_requests",
    {
      description: "List cancel-all, cancel-order and cancel-market control requests and their signing/submission state.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    async input => textResult({
      stats: await getTradeControlStats(),
      requests: await listTradingControlRequests(input.limit)
    })
  );

  server.registerTool(
    "trading.intents",
    {
      description: "List staged non-custodial trade intents and their signing/submission status.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    async input => textResult({
      stats: await getTradeControlStats(),
      intents: await listTradeIntents(input.limit)
    })
  );

  server.registerTool(
    "wallets.top",
    {
      description: "Return persisted high-sample Polymarket wallet intelligence ranked by conservative smart-money score. This is a research signal, not a copy-trading recommendation.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50)
      }
    },
    async input => textResult({
      stats: await getWalletIntelligenceStats(),
      wallets: await getTopWalletIntelligence(input.limit)
    })
  );

  server.registerTool(
    "markets.cross_venue",
    {
      description: "Return recent Polymarket-Kalshi semantic/rules matches. Only rows clearing strict matching and a conservative fee buffer are labeled cross-venue arb candidates.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async input => textResult({
      stats: await getOpportunityIntelligenceStats(),
      matches: await getRecentCrossVenueMatches(input.limit)
    })
  );

  server.registerTool(
    "markets.opportunity_packets",
    {
      description: "Return unified opportunity packets combining structural edge, maker economics, wallet flow, cross-venue evidence, behavior, external evidence, resolution risk and historical calibration.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async input => textResult({
      stats: await getOpportunityIntelligenceStats(),
      packets: await getRecentOpportunityPackets(input.limit)
    })
  );

  server.registerTool(
    "system.price_bucket_calibration",
    {
      description: "Return this system's empirical Polymarket calibration curve from resolved non-political markets, grouped by domain, horizon and implied-probability bucket. Useful for testing longshot/favorite bias without importing another venue's coefficients.",
      inputSchema: {
        bucketSize: z.number().min(0.01).max(0.25).default(0.05),
        minSamples: z.number().int().min(1).max(1000).default(5)
      }
    },
    async input => textResult(await getPriceBucketCalibration(input))
  );

  server.registerTool(
    "system.calibration",
    {
      description: "Return empirical persistence/calibration statistics from durable historical scans, including repeated-market observations and structural-edge persistence."
    },
    async () => textResult(await getCalibrationStats())
  );

  server.registerTool(
    "system.audit",
    {
      description: "Run a live end-to-end self-audit: full-universe scan invariants, execution-score bounds, persistence freshness/duplicates, latency, and realtime subscription consistency."
    },
    async () => textResult(await runSystemAudit())
  );

  server.registerTool(
    "system.mcp_self_test",
    {
      description: "Perform an actual local Streamable HTTP MCP initialize + tools/list handshake against this service's /mcp endpoint."
    },
    async () => textResult(await runMcpSelfTest())
  );

  server.registerTool(
    "system.persistence_health",
    {
      description: "Return durable Polymarket history backend status and aggregate stored scan statistics."
    },
    async () => textResult({
      config: persistenceConfig(),
      connection: await testPersistenceConnection().catch(error => ({ error: errorMessage(error) })),
      stats: await getPersistentStats().catch(error => ({
        error: errorMessage(error)
      })),
      streams: await getStreamPersistenceStats().catch(error => ({
        error: errorMessage(error)
      })),
      realtimeTargets: await getRealtimeTargetStats().catch(error => ({
        error: errorMessage(error)
      })),
      maintenance: await getMaintenanceStats().catch(error => ({
        error: errorMessage(error)
      }))
    })
  );

  server.registerTool(
    "system.snapshot_health",
    {
      description: "Return rolling in-process scanner health and deltas across recent scans."
    },
    async () => textResult(getSnapshotHealth())
  );

  server.registerTool(
    "system.snapshots",
    {
      description: "Return recent in-process opportunity scanner snapshots.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async input => textResult(getSnapshots(input.limit))
  );

  server.registerTool(
    "markets.chart_5m",
    {
      description: "Return a 5-minute price chart for any Polymarket outcome token. Uses durable local OHLC/spread bars when available and falls back to official CLOB 5-minute price history for untracked tokens.",
      inputSchema: {
        tokenId: z.string().min(1),
        hours: z.number().int().min(1).max(720).default(24),
        limit: z.number().int().min(1).max(5000).default(500)
      }
    },
    async input => {
      const bars = await getQuoteBars(input.tokenId, "5m", input.hours, input.limit);
      if (bars.length) {
        return textResult({
          tokenId: input.tokenId,
          interval: "5m",
          source: "local_realtime_ohlc",
          bars
        });
      }
      return textResult({
        tokenId: input.tokenId,
        interval: "5m",
        source: "polymarket_clob_prices_history",
        history: await getPriceHistory(input.tokenId, input.hours, 5)
      });
    }
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
  if (req.method === "POST" && url.pathname === "/api/wallet/connect") {
    if (!requireControlToken(req, res)) return true;
    const body = await parseBody(req) as any;
    const address = String(body?.address || "");
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      json(res, 400, { error: "invalid_evm_wallet_address" });
    } else {
      json(res, 200, await upsertWalletProfileAddress(address));
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/gpt") {
    if (!requireControlToken(req, res)) return true;
    const body = await parseBody(req) as any;
    const prompt = String(body?.prompt || "").trim();
    if (!prompt) json(res, 400, { error: "prompt_required" });
    else json(res, 200, await askOpenAI(prompt));
    return true;
  }

  if (req.method !== "GET") return false;

  if (url.pathname === "/health") {
    json(res, 200, {
      status: "ok",
      service: "zoey-polymarket-mcp",
      version: VERSION,
      mode: "non-custodial-control-plane",
      tradingEnabled: String(process.env.TRADING_ENABLED || "false").toLowerCase() === "true",
      tradeIntentsEnabled: String(process.env.TRADING_INTENTS_ENABLED || "false").toLowerCase() === "true",
    serviceRole: SERVICE_ROLE,
      maxScannerWindowMinutes: 120,
      now: new Date().toISOString()
    });
    return true;
  }

  if (url.pathname === "/dashboard") {
    html(res, 200, renderDashboardHtml());
    return true;
  }

  if (url.pathname === "/health/deep") {
    const [heartbeats, persistence, snapshotStats] = await Promise.all([
      getWorkerHeartbeats().catch(() => []),
      getPersistenceIntegrity().catch(() => null),
      getMultiHorizonSnapshotStats().catch(() => null)
    ]);
    const maxAgeMs = Math.max(30_000, Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS || 60_000));
    const snapshotMaxAgeMs = Math.max(60_000, Number(process.env.SNAPSHOT_MAX_AGE_MS || 300_000));
    const latestSnapshotAt = (snapshotStats as any)?.latestGeneratedAt
      ? Date.parse((snapshotStats as any).latestGeneratedAt)
      : NaN;
    const snapshotAgeMs = Number.isFinite(latestSnapshotAt) ? Date.now() - latestSnapshotAt : Infinity;

    const workers: Record<string, unknown> = {};
    for (const role of ["scanner","streams","history","maintenance"]) {
      const hb = (heartbeats as any[]).find(item => item.role === role);
      const ageMs = hb?.updatedAt ? Date.now() - Date.parse(hb.updatedAt) : Infinity;
      let status = ageMs <= maxAgeMs ? "healthy" : "stale";
      if (role === "scanner" && snapshotAgeMs > snapshotMaxAgeMs) status = "stale";
      workers[role] = {
        status,
        ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
        updatedAt: hb?.updatedAt ?? null,
        ...(role === "scanner" ? {
          snapshotAgeSeconds: Number.isFinite(snapshotAgeMs) ? Math.round(snapshotAgeMs / 1000) : null,
          snapshotMaxAgeSeconds: Math.round(snapshotMaxAgeMs / 1000)
        } : {})
      };
    }
    const ok = Object.values(workers).every((worker: any) => worker.status === "healthy") &&
      Boolean((persistence as any)?.configured) &&
      Boolean((snapshotStats as any)?.configured) &&
      snapshotAgeMs <= snapshotMaxAgeMs;
    json(res, ok ? 200 : 503, {
      ok,
      version: VERSION,
      serviceRole: SERVICE_ROLE,
      workers,
      persistence,
      snapshotStats,
      realtime: realtimeTracker.getHealth()
    });
    return true;
  }

  if (url.pathname === "/api/storage-health") {
    json(res, 200, await getStorageHealth());
    return true;
  }

  if (url.pathname === "/api/upstream-check") {
    json(res, 200, await upstreamCheck());
    return true;
  }

  if (url.pathname === "/api/external-evidence") {
    const question = url.searchParams.get("question") || "";
    if (!question.trim()) {
      json(res, 400, { error: "question_required" });
    } else {
      json(res, 200, {
        question,
        evidence: await getExternalCryptoEvidence(question).catch(error => ({
          error: errorMessage(error)
        }))
      });
    }
    return true;
  }

  if (url.pathname === "/api/snapshot-health") {
    json(res, 200, getSnapshotHealth());
    return true;
  }

  if (url.pathname === "/api/realtime-health") {
    json(res, 200, realtimeTracker.getHealth());
    return true;
  }

  if (url.pathname === "/api/chart-5m") {
    const tokenId = url.searchParams.get("tokenId") || "";
    if (!tokenId) {
      json(res, 400, { error: "tokenId_required" });
      return true;
    }
    const hours = numberParam(url, "hours", 24, 1, 720);
    const limit = numberParam(url, "limit", 500, 1, 5000);
    const bars = await getQuoteBars(tokenId, "5m", hours, limit).catch(() => []);
    if (bars.length) {
      json(res, 200, {
        tokenId,
        interval: "5m",
        source: "local_realtime_ohlc",
        bars
      });
    } else {
      json(res, 200, {
        tokenId,
        interval: "5m",
        source: "polymarket_clob_prices_history",
        history: await getPriceHistory(tokenId, hours, 5)
      });
    }
    return true;
  }

  if (url.pathname === "/api/sports-health") {
    json(res, 200, sportsTracker.getHealth());
    return true;
  }

  if (url.pathname === "/api/sports-results") {
    json(res, 200, {
      health: sportsTracker.getHealth(),
      events: sportsTracker.recent(numberParam(url, "limit", 50, 1, 200))
    });
    return true;
  }

  if (url.pathname === "/api/audit") {
    const audit = await runSystemAudit();
    json(res, audit.summary.ok ? 200 : 503, audit);
    return true;
  }

  if (url.pathname === "/api/mcp-self-test") {
    const result = await runMcpSelfTest();
    json(res, result.ok ? 200 : 503, result);
    return true;
  }

  if (url.pathname === "/api/persistence-health") {
    json(res, 200, {
      config: persistenceConfig(),
      connection: await testPersistenceConnection().catch(error => ({ error: errorMessage(error) })),
      stats: await getPersistentStats().catch(error => ({ error: errorMessage(error) })),
      streams: await getStreamPersistenceStats().catch(error => ({ error: errorMessage(error) })),
      realtimeTargets: await getRealtimeTargetStats().catch(error => ({ error: errorMessage(error) })),
      maintenance: await getMaintenanceStats().catch(error => ({ error: errorMessage(error) })),
      trading: await getTradeControlStats().catch(error => ({ error: errorMessage(error) })),
      multiHorizon: await getMultiHorizonSnapshotStats().catch(error => ({ error: errorMessage(error) }))
    });
    return true;
  }

  if (url.pathname === "/api/alerts") {
    json(res, 200, {
      stats: await getAlertStats().catch(error => ({ error: errorMessage(error) })),
      alerts: await getRecentAlerts(numberParam(url, "limit", 100, 1, 500)).catch(() => [])
    });
    return true;
  }

  if (url.pathname === "/api/historical-calibration") {
    json(res, 200, await getHistoricalCalibrationSummary().catch(error => ({
      error: errorMessage(error)
    })));
    return true;
  }

  if (url.pathname === "/api/behavior-backtest") {
    json(res, 200, await getBehavioralShockBacktest({
      lookbackDays: numberParam(url, "lookbackDays", 14, 1, 90),
      shockThresholdPct: Number(url.searchParams.get("shockThresholdPct") || 10),
      minSamples: numberParam(url, "minSamples", 5, 1, 1000)
    }).catch(error => ({ error: errorMessage(error) })));
    return true;
  }

  if (url.pathname === "/api/sports-board") {
    const snapshot = await getLatestMultiHorizonSnapshot();
    const board = buildSportsBoard(snapshot as any);
    const sportNeedle = (url.searchParams.get("sport") || "").trim().toUpperCase();
    const liveOnly = (url.searchParams.get("liveOnly") || "false").toLowerCase() === "true";
    const games = (board.games || []).filter((game: any) =>
      (!sportNeedle || String(game.sport || "").toUpperCase().includes(sportNeedle)) &&
      (!liveOnly || game.liveState?.live === true)
    );
    json(res, 200, {
      ...board,
      games,
      filteredGameCount: games.length
    });
    return true;
  }

  if (url.pathname === "/api/wallet-control") {
    const status = await getWalletControlStatus("primary");
    const profile = await getWalletProfile("primary");
    json(res, 200, {
      ...status,
      portfolio: await getWalletPortfolio(profile),
      stats: await getTradeControlStats()
    });
    return true;
  }

  if (url.pathname === "/api/wallets") {
    json(res, 200, {
      stats: await getWalletIntelligenceStats().catch(error => ({ error: errorMessage(error) })),
      wallets: await getTopWalletIntelligence(numberParam(url, "limit", 50, 1, 200)).catch(() => [])
    });
    return true;
  }

  if (url.pathname === "/api/cross-venue") {
    json(res, 200, {
      stats: await getOpportunityIntelligenceStats().catch(error => ({ error: errorMessage(error) })),
      matches: await getRecentCrossVenueMatches(numberParam(url, "limit", 100, 1, 500)).catch(() => [])
    });
    return true;
  }

  if (url.pathname === "/api/opportunity-packets") {
    json(res, 200, {
      stats: await getOpportunityIntelligenceStats().catch(error => ({ error: errorMessage(error) })),
      packets: await getRecentOpportunityPackets(numberParam(url, "limit", 100, 1, 500)).catch(() => [])
    });
    return true;
  }

  if (url.pathname === "/api/price-bucket-calibration") {
    json(res, 200, await getPriceBucketCalibration({
      bucketSize: Number(url.searchParams.get("bucketSize") || 0.05),
      minSamples: numberParam(url, "minSamples", 5, 1, 1000)
    }).catch(error => ({ error: errorMessage(error) })));
    return true;
  }

  if (url.pathname === "/api/calibration") {
    json(res, 200, await getCalibrationStats().catch(error => ({ error: errorMessage(error) })));
    return true;
  }

  if (url.pathname === "/api/resolution-history") {
    json(res, 200, await getResolutionStats().catch(error => ({ error: errorMessage(error) })));
    return true;
  }

  if (url.pathname === "/api/snapshots") {
    json(res, 200, getSnapshots(numberParam(url, "limit", 100, 1, 500)));
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

  if (url.pathname === "/api/multi-horizon") {
    const latest = await getLatestMultiHorizonSnapshot();
    if (!latest) {
      json(res, 503, {
        error: "no_scanner_snapshot_yet",
        stats: await getMultiHorizonSnapshotStats().catch(() => null)
      });
      return true;
    }
    const maxAgeSeconds = numberParam(url, "maxAgeSeconds", 300, 1, 3600);
    json(res, 200, {
      stale: Number(latest.ageSeconds || 0) > maxAgeSeconds,
      maxAgeSeconds,
      ...latest
    });
    return true;
  }

  if (url.pathname === "/api/calibration-health") {
    const summary = await getHistoricalCalibrationSummary();
    const minUsableCoveragePct = Math.max(
      50,
      Math.min(100, Number(process.env.CAUSAL_V2_MIN_USABLE_COVERAGE_PCT || 80))
    );
    const remaining = Number((summary as any)?.causalV2Remaining || 0);
    const usableCoveragePct = Number((summary as any)?.causalV2UsableCoveragePct || 0);
    const complete =
      Number((summary as any)?.sampleCount || 0) > 0 &&
      remaining === 0 &&
      usableCoveragePct >= minUsableCoveragePct;
    json(res, 200, {
      ...summary,
      calibrationVersion: HISTORICAL_CALIBRATION_VERSION,
      minUsableCoveragePct,
      complete,
      productionGateReady: complete,
      status: complete
        ? "ready_for_strategy_revalidation"
        : remaining > 0
          ? "rebuild_in_progress"
          : "insufficient_usable_causal_coverage"
    });
    return true;
  }

  if (url.pathname === "/api/paper-trading") {
    json(res,200,{
      enabled:PAPER_TRADING_ENABLED,
      requireCausalV2Complete:PAPER_TRADE_REQUIRE_CAUSAL_COMPLETE,
      stakeUsd:PAPER_TRADE_STAKE_USD,
      stats:await getPaperTradingStats(),
      trades:await listPaperTrades(numberParam(url,"limit",100,1,1000))
    });
    return true;
  }

  if (url.pathname === "/api/liquidity-capacity") {
    const lane = normalizeOpportunityLane(url.searchParams.get("lane"));
    json(res,200,await getLiquidityCapacity(
      lane,
      numberParam(url,"limit",100,1,500)
    ));
    return true;
  }

  if (url.pathname === "/api/strategy-policy") {
    json(res, 200, await getProductionStrategyPolicy(url.searchParams.get("force") === "true"));
    return true;
  }

  if (url.pathname === "/api/unified-opportunities") {
    const lane = normalizeOpportunityLane(url.searchParams.get("lane"));
    json(res, 200, await loadUnifiedOpportunities(
      lane,
      numberParam(url, "limit", 50, 1, 500)
    ));
    return true;
  }

  if (url.pathname === "/api/historical-replay") {
    const domains = (url.searchParams.get("domains") || "")
      .split(",")
      .map(value => value.trim())
      .filter(value => ["sports","crypto","weather","other"].includes(value));
    json(res, 200, await runHistoricalReplay({
      years: numberParam(url, "years", 3, 0.25, 10),
      horizon: url.searchParams.get("horizon") || "tMinus60m",
      threshold: numberParam(url, "threshold", 0.75, 0.5, 0.999),
      trainFraction: numberParam(url, "trainFraction", 0.7, 0.1, 0.9),
      bufferBps: numberParam(url, "bufferBps", 50, 0, 5000),
      domains: domains.length ? domains : undefined
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
      description: "Polymarket full-universe intelligence and non-custodial trade-control MCP. Trade staging and submission are feature-gated; final order signing requires the configured user wallet.",
      transport: { type: "streamable-http", url: "/mcp" },
      capabilities: ["tools"],
      readOnly: false
    });
    return true;
  }

  if (url.pathname === "/") {
    json(res, 200, {
      name: "zoey-polymarket-mcp",
      version: VERSION,
      mode: "non-custodial-control-plane",
      tradingEnabled: String(process.env.TRADING_ENABLED || "false").toLowerCase() === "true",
      tradeIntentsEnabled: String(process.env.TRADING_INTENTS_ENABLED || "false").toLowerCase() === "true",
      mcp: "/mcp",
      health: "/health",
      deepHealth: "/health/deep",
      storageHealth: "/api/storage-health",
      dashboard: "/dashboard",
      unifiedOpportunities: "/api/unified-opportunities?lane=urgent_2h&limit=50",
      strategyPolicy: "/api/strategy-policy",
      liquidityCapacity: "/api/liquidity-capacity?lane=urgent_2h&limit=100",
      paperTrading: "/api/paper-trading?limit=100",
      calibrationHealth: "/api/calibration-health",
      historicalReplay: "/api/historical-replay?years=3&horizon=tMinus60m&threshold=0.75",
      opportunities: "/api/opportunities?minutes=120&limit=50",
      multiHorizon: "/api/multi-horizon?limitPerLane=100&structuralLimit=200",
      scan: "/api/closing-soon?minutes=120&limit=50&books=true&sort=opportunity",
      arbitrage: "/api/arbitrage?minutes=120&limit=50",
      upstream: "/api/upstream-check",
      externalEvidence: "/api/external-evidence?question=Will%20Bitcoin%20be%20above%20%2485000%3F",
      snapshotHealth: "/api/snapshot-health",
      realtimeHealth: "/api/realtime-health",
      sportsHealth: "/api/sports-health",
      sportsResults: "/api/sports-results?limit=50",
      audit: "/api/audit",
      mcpSelfTest: "/api/mcp-self-test",
      persistenceHealth: "/api/persistence-health",
      alerts: "/api/alerts?limit=100",
      chart5m: "/api/chart-5m?tokenId=<token>&hours=24&limit=500",
      behaviorBacktest: "/api/behavior-backtest?lookbackDays=14&shockThresholdPct=10&minSamples=5",
      wallets: "/api/wallets?limit=50",
      walletControl: "/api/wallet-control",
      sportsBoard: "/api/sports-board?sport=NFL&liveOnly=false",
      crossVenue: "/api/cross-venue?limit=100",
      opportunityPackets: "/api/opportunity-packets?limit=100",
      calibration: "/api/calibration",
      priceBucketCalibration: "/api/price-bucket-calibration?bucketSize=0.05&minSamples=5",
      historicalCalibration: "/api/historical-calibration",
      resolutionHistory: "/api/resolution-history"
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

let heartbeatRunning = false;

async function runWorkerHeartbeat() {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  try {
    const details: Record<string, unknown> = {
      version: VERSION,
      role: SERVICE_ROLE,
      at: new Date().toISOString()
    };

    if (ROLE_STREAMS) {
      details.realtime = realtimeTracker.getHealth();
      details.sports = sportsTracker.getHealth();
    }
    if (ROLE_SCANNER) {
      details.realtimeTargets = await getRealtimeTargetStats().catch(() => null);
    }
    if (ROLE_HISTORY) {
      details.historicalCalibration = await getHistoricalCalibrationSummary().catch(() => null);
      details.walletIntelligence = await getWalletIntelligenceStats().catch(() => null);
    }
    if (ROLE_MAINTENANCE) {
      details.maintenance = await getMaintenanceStats().catch(() => null);
    }

    await upsertWorkerHeartbeat(SERVICE_ROLE, details);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "worker_heartbeat_failed",
      role: SERVICE_ROLE,
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    heartbeatRunning = false;
  }
}

let backgroundScanRunning = false;
let structuralScanRunning = false;
let lastStructuralUniverse: Awaited<ReturnType<typeof scanMultiHorizon>>["structuralUniverse"] | null = null;
let resolutionWorkerRunning = false;
let streamPersistRunning = false;
let quoteCompactionRunning = false;
let historicalBackfillRunning = false;
let walletIntelligenceRunning = false;
let maintenanceRunning = false;
let paperEntryRunning = false;
let paperSettlementRunning = false;
const BACKGROUND_SCAN_SECONDS = Math.max(30, Number(process.env.BACKGROUND_SCAN_SECONDS || 60));
const STRUCTURAL_SCAN_SECONDS = Math.max(900, Number(process.env.STRUCTURAL_SCAN_SECONDS || 1800));
const PERSIST_SCAN_SECONDS = Math.max(BACKGROUND_SCAN_SECONDS, Number(process.env.PERSIST_SCAN_SECONDS || 300));
const PERSIST_PACKET_SECONDS = Math.max(BACKGROUND_SCAN_SECONDS, Number(process.env.PERSIST_PACKET_SECONDS || 300));
const RESOLUTION_CHECK_SECONDS = Math.max(60, Number(process.env.RESOLUTION_CHECK_SECONDS || 300));
const STREAM_PERSIST_SECONDS = Math.max(5, Number(process.env.STREAM_PERSIST_SECONDS || 5));
const QUOTE_COMPACTION_SECONDS = Math.max(60, Number(process.env.QUOTE_COMPACTION_SECONDS || 60));
const HISTORICAL_BACKFILL_SECONDS = Math.max(300, Number(process.env.HISTORICAL_BACKFILL_SECONDS || 900));
const HISTORICAL_LOOKBACK_HOURS = Math.max(6, Math.min(24 * 365 * 10, Number(process.env.HISTORICAL_LOOKBACK_HOURS || 24 * 365 * 3)));
const HISTORICAL_BACKFILL_LIMIT = Math.max(1, Math.min(2000, Number(process.env.HISTORICAL_BACKFILL_LIMIT || 500)));
const HISTORICAL_BACKFILL_WINDOW_DAYS = Math.max(1, Math.min(180, Number(process.env.HISTORICAL_BACKFILL_WINDOW_DAYS || 30)));
const HISTORICAL_BACKFILL_RUN_MINUTES = Math.max(1, Math.min(30, Number(process.env.HISTORICAL_BACKFILL_RUN_MINUTES || 25)));
const WALLET_INTELLIGENCE_SECONDS = Math.max(120, Number(process.env.WALLET_INTELLIGENCE_SECONDS || 300));
const WALLET_INTELLIGENCE_LIMIT = Math.max(5, Math.min(100, Number(process.env.WALLET_INTELLIGENCE_LIMIT || 25)));
const MAINTENANCE_SECONDS = Math.max(300, Number(process.env.MAINTENANCE_SECONDS || 600));
const RAW_QUOTE_RETENTION_HOURS = Math.max(1, Number(process.env.RAW_QUOTE_RETENTION_HOURS || 2));
const SPORTS_EVENT_RETENTION_DAYS = Math.max(7, Number(process.env.SPORTS_EVENT_RETENTION_DAYS || 30));
const CANDIDATE_RETENTION_DAYS = Math.max(3, Number(process.env.CANDIDATE_RETENTION_DAYS || 14));
const SCAN_RETENTION_DAYS = Math.max(3, Number(process.env.SCAN_RETENTION_DAYS || 14));
const OPPORTUNITY_PACKET_RETENTION_DAYS = Math.max(7, Number(process.env.OPPORTUNITY_PACKET_RETENTION_DAYS || 30));
const QUOTE_BAR_1M_RETENTION_HOURS = Math.max(1, Number(process.env.QUOTE_BAR_1M_RETENTION_HOURS || 6));
const QUOTE_BAR_5M_RETENTION_HOURS = Math.max(6, Number(process.env.QUOTE_BAR_5M_RETENTION_HOURS || 48));
const CROSS_VENUE_RETENTION_DAYS = Math.max(7, Number(process.env.CROSS_VENUE_RETENTION_DAYS || 30));
const SNAPSHOT_KEEP_COUNT = Math.max(2, Number(process.env.SNAPSHOT_KEEP_COUNT || 10));
const TRUNCATE_REALTIME_AFTER_COMPACTION =
  String(process.env.TRUNCATE_REALTIME_AFTER_COMPACTION || "true").toLowerCase() !== "false";
const REALTIME_TARGET_TOKEN_LIMIT = Math.max(100, Math.min(2000, Number(process.env.REALTIME_TARGET_TOKEN_LIMIT || 400)));
const PERSIST_CANDIDATE_LIMIT = Math.max(50, Math.min(500, Number(process.env.PERSIST_CANDIDATE_LIMIT || 250)));
const PERSIST_PACKET_LIMIT = Math.max(50, Math.min(500, Number(process.env.PERSIST_PACKET_LIMIT || 250)));
const PAPER_TRADING_ENABLED = String(process.env.PAPER_TRADING_ENABLED || "false").toLowerCase() === "true";
const PAPER_TRADING_SECONDS = Math.max(60, Number(process.env.PAPER_TRADING_SECONDS || 300));
const PAPER_TRADE_STAKE_USD = Math.max(1, Math.min(100, Number(process.env.PAPER_TRADE_STAKE_USD || 25)));
const PAPER_TRADE_REQUIRE_CAUSAL_COMPLETE =
  String(process.env.PAPER_TRADE_REQUIRE_CAUSAL_COMPLETE || "true").toLowerCase() !== "false";

let lastBroadPersistenceAt = 0;
let lastPacketPersistenceAt = 0;

async function runBackgroundScan() {
  if (backgroundScanRunning) return;
  backgroundScanRunning = true;
  try {
    const multi = await scanMultiHorizon({
      minLiquidity: 0,
      limitPerLane: 500,
      structuralLimit: 500,
      bufferBps: Number(process.env.OPPORTUNITY_BUFFER_BPS || 50),
      sourceMode: "near_term",
      nearTermMinutes: 1440
    });

    if (lastStructuralUniverse) {
      multi.structuralUniverse = lastStructuralUniverse;
    }

    // Persist the broad <=24h lane so historical evidence accumulates before markets
    // become urgent. Full-universe structural opportunities remain available in
    // multi.structuralUniverse without polluting the time-window semantics.
    const broadScan = {
      generatedAt: multi.generatedAt,
      maxMinutes: 1440,
      totalActiveMarketsScanned: multi.totalActiveMarketsScanned,
      totalInWindowBeforeFilters: multi.lanes.broader24h.totalInWindow,
      returned: Math.min(PERSIST_CANDIDATE_LIMIT, multi.lanes.broader24h.candidates.length),
      scanDurationMs: multi.scanDurationMs,
      candidates: multi.lanes.broader24h.candidates.slice(0, PERSIST_CANDIDATE_LIMIT),
      eventBaskets: []
    };

    await persistMultiHorizonSnapshot(multi).catch(error => {
      console.error(JSON.stringify({
        level: "error",
        message: "multi_horizon_snapshot_persistence_failed",
        error: errorMessage(error),
        at: new Date().toISOString()
      }));
    });

    if (Date.now() - lastBroadPersistenceAt >= PERSIST_SCAN_SECONDS * 1000) {
      await persistScan(broadScan)
        .then(result => {
          if ((result as any)?.ok !== false) lastBroadPersistenceAt = Date.now();
        })
        .catch(error => {
          console.error(JSON.stringify({
            level: "error",
            message: "persistence_write_failed",
            error: errorMessage(error),
            at: new Date().toISOString()
          }));
        });
    }

    const alertCandidates = new Map<string, (typeof multi.lanes.broader24h.candidates)[number]>();
    for (const candidate of multi.lanes.broader24h.candidates) {
      alertCandidates.set(candidate.conditionId || candidate.id || candidate.slug || candidate.question, candidate);
    }
    for (const candidate of multi.structuralUniverse.binary) {
      alertCandidates.set(candidate.conditionId || candidate.id || candidate.slug || candidate.question, candidate);
    }

    await persistAlertsFromScan({
      ...broadScan,
      candidates: [...alertCandidates.values()],
      returned: alertCandidates.size,
      eventBaskets: multi.structuralUniverse.eventBaskets
    }).catch(error => {
      console.error(JSON.stringify({
        level: "error",
        message: "alert_persistence_failed",
        error: errorMessage(error),
        at: new Date().toISOString()
      }));
    });

    if (Date.now() - lastPacketPersistenceAt >= PERSIST_PACKET_SECONDS * 1000) {
      const packetCandidateMap = new Map<string, (typeof multi.lanes.broader24h.candidates)[number]>();
      for (const candidate of multi.structuralUniverse.binary) {
        packetCandidateMap.set(candidate.conditionId || candidate.id || candidate.slug || candidate.question, candidate);
      }
      for (const candidate of multi.lanes.urgent2h.candidates) {
        if (packetCandidateMap.size >= PERSIST_PACKET_LIMIT) break;
        packetCandidateMap.set(candidate.conditionId || candidate.id || candidate.slug || candidate.question, candidate);
      }
      for (const candidate of multi.lanes.broader24h.candidates) {
        if (packetCandidateMap.size >= PERSIST_PACKET_LIMIT) break;
        packetCandidateMap.set(candidate.conditionId || candidate.id || candidate.slug || candidate.question, candidate);
      }

      await persistOpportunityPackets(
        multi.generatedAt,
        [...packetCandidateMap.values()].slice(0, PERSIST_PACKET_LIMIT)
      ).then(() => {
        lastPacketPersistenceAt = Date.now();
      }).catch(error => {
        console.error(JSON.stringify({
          level: "error",
          message: "opportunity_packet_persistence_failed",
          error: errorMessage(error),
          at: new Date().toISOString()
        }));
      });
    }

    // Realtime subscriptions focus on <=6h markets plus any structural edge anywhere.
    // The 24h/full-universe lanes are still rescanned from fresh CLOB books each cycle.
    const tokens = new Set<string>();
    const addCandidateTokens = (candidates: ScanCandidate[], maxTokens: number) => {
      for (const candidate of candidates) {
        for (const tokenId of candidate.tokenIds) {
          if (tokens.size >= maxTokens) return;
          tokens.add(tokenId);
        }
      }
    };
    const urgentBudget = Math.max(50, Math.floor(REALTIME_TARGET_TOKEN_LIMIT * 0.75));
    addCandidateTokens(multi.lanes.urgent2h.candidates, urgentBudget);
    addCandidateTokens(multi.structuralUniverse.binary, REALTIME_TARGET_TOKEN_LIMIT);
    for (const basket of multi.structuralUniverse.eventBaskets) {
      for (const tokenId of basket.yesTokenIds) {
        if (tokens.size >= REALTIME_TARGET_TOKEN_LIMIT) break;
        tokens.add(tokenId);
      }
      if (tokens.size >= REALTIME_TARGET_TOKEN_LIMIT) break;
    }
    addCandidateTokens(multi.lanes.developing6h.candidates, REALTIME_TARGET_TOKEN_LIMIT);
    await replaceRealtimeTargets(
      [...tokens],
      "multi_horizon_scanner",
      Math.max(180, BACKGROUND_SCAN_SECONDS * 3)
    );

    if (ROLE_STREAMS) {
      realtimeTracker.updateTokens([...tokens]);
    }

    console.log(JSON.stringify({
      level: "info",
      message: "multi_horizon_scan",
      totalActive: multi.totalActiveMarketsScanned,
      urgent2h: multi.lanes.urgent2h.totalInWindow,
      developing6h: multi.lanes.developing6h.totalInWindow,
      broader24h: multi.lanes.broader24h.totalInWindow,
      structuralBinary: multi.structuralUniverse.binary.length,
      structuralEventBaskets: multi.structuralUniverse.eventBaskets.length,
      executableStructural: multi.structuralUniverse.executableCount,
      scanDurationMs: multi.scanDurationMs,
      at: new Date().toISOString()
    }));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "background_scan_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    backgroundScanRunning = false;
  }
}

async function runStructuralScan() {
  if (structuralScanRunning) return;
  structuralScanRunning = true;
  try {
    const structural = await scanMultiHorizon({
      minLiquidity: 0,
      limitPerLane: 50,
      structuralLimit: 500,
      bufferBps: Number(process.env.OPPORTUNITY_BUFFER_BPS || 50),
      sourceMode: "full"
    });
    lastStructuralUniverse = structural.structuralUniverse;
    console.log(JSON.stringify({
      level:"info",
      message:"structural_universe_scan",
      totalActive:structural.totalActiveMarketsScanned,
      structuralBinary:structural.structuralUniverse.binary.length,
      structuralEventBaskets:structural.structuralUniverse.eventBaskets.length,
      executableStructural:structural.structuralUniverse.executableCount,
      scanDurationMs:structural.scanDurationMs,
      at:new Date().toISOString()
    }));
  } catch (error) {
    console.error(JSON.stringify({
      level:"error",
      message:"structural_universe_scan_failed",
      error:errorMessage(error),
      at:new Date().toISOString()
    }));
  } finally {
    structuralScanRunning = false;
  }
}

let realtimeTargetRefreshRunning = false;

async function runRealtimeTargetRefresh() {
  if (realtimeTargetRefreshRunning) return;
  realtimeTargetRefreshRunning = true;
  try {
    const targets = await getRealtimeTargets();
    realtimeTracker.updateTokens(targets);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "realtime_target_refresh_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    realtimeTargetRefreshRunning = false;
  }
}

async function runStreamPersistenceWorker() {
  if (streamPersistRunning) return;
  streamPersistRunning = true;
  try {
    const quotes = realtimeTracker.getQuotes();
    const sportsEvents = sportsTracker.drainPendingEvents(500);

    const [quoteResult, sportsResult] = await Promise.all([
      persistRealtimeQuotes(quotes),
      persistSportsEvents(sportsEvents)
    ]);

    if ((quoteResult.inserted || 0) > 0 || (sportsResult.inserted || 0) > 0) {
      console.log(JSON.stringify({
        level: "info",
        message: "stream_persistence",
        quotesInserted: quoteResult.inserted || 0,
        sportsEventsInserted: sportsResult.inserted || 0,
        at: new Date().toISOString()
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "stream_persistence_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    streamPersistRunning = false;
  }
}

async function runQuoteCompactionWorker() {
  if (quoteCompactionRunning) return;
  quoteCompactionRunning = true;
  try {
    const result = await compactRealtimeQuotes(120);
    if ((result.barsUpserted || 0) > 0) {
      console.log(JSON.stringify({
        level: "info",
        message: "quote_compaction",
        ...result,
        at: new Date().toISOString()
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "quote_compaction_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    quoteCompactionRunning = false;
  }
}

async function runMaintenanceWorker() {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    // Preserve minute/5-minute summaries before reclaiming disposable raw quote
    // storage. This keeps chart/history utility while preventing raw-table bloat.
    const preCleanupCompaction = await compactRealtimeQuotes(120).catch(error => ({
      configured:false,
      error:errorMessage(error),
      barsUpserted:0,
      bars5mUpserted:0
    }));

    const result = await cleanupRawStreams(
      RAW_QUOTE_RETENTION_HOURS,
      SPORTS_EVENT_RETENTION_DAYS,
      {
        candidateRetentionDays: CANDIDATE_RETENTION_DAYS,
        scanRetentionDays: SCAN_RETENTION_DAYS,
        packetRetentionDays: OPPORTUNITY_PACKET_RETENTION_DAYS,
        oneMinuteBarRetentionHours: QUOTE_BAR_1M_RETENTION_HOURS,
        fiveMinuteBarRetentionHours: QUOTE_BAR_5M_RETENTION_HOURS,
        crossVenueRetentionDays: CROSS_VENUE_RETENTION_DAYS,
        snapshotKeepCount: SNAPSHOT_KEEP_COUNT,
        truncateRealtimeQuotes: TRUNCATE_REALTIME_AFTER_COMPACTION
      }
    );
    console.log(JSON.stringify({
      level: "info",
      message: "raw_stream_cleanup",
      preCleanupCompaction,
      ...result,
      at: new Date().toISOString()
    }));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "raw_stream_cleanup_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    maintenanceRunning = false;
  }
}

function paperFeeRate(domain:string) {
  if (domain === "crypto") return 0.07;
  if (domain === "sports" || domain === "weather" || domain === "other") return 0.05;
  return 0;
}

async function runPaperEntryWorker() {
  if (!PAPER_TRADING_ENABLED || paperEntryRunning) return;
  paperEntryRunning = true;
  try {
    const policy = await getProductionStrategyPolicy(true) as any;
    if (PAPER_TRADE_REQUIRE_CAUSAL_COMPLETE && policy?.calibration?.complete !== true) {
      console.log(JSON.stringify({
        level:"info",
        message:"paper_trade_entry_skipped",
        reason:"causal_v2_rebuild_incomplete",
        calibration:policy?.calibration || null,
        at:new Date().toISOString()
      }));
      return;
    }

    const latest = await getLatestMultiHorizonSnapshot();
    if (!latest) return;
    const candidates:ScanCandidate[] = latest.lanes?.urgent2h?.candidates || [];
    let inserted=0;
    let considered=0;

    for (const candidate of candidates) {
      if (candidate.minutesRemaining < 45 || candidate.minutesRemaining > 75) continue;
      if (!candidate.conditionId || !candidate.slug || candidate.outcomes.length !== 2) continue;
      const domain=strategyDomainForCategory(candidate.primaryCategory);
      if (domain === "political") continue;

      const researchPolicy=policy?.perDomain?.[domain]?.sampleWalkForward;
      const selected=researchPolicy?.selectedPolicy;
      if (!selected) continue;
      const threshold=Number(selected.threshold);
      if (!(threshold >= 0.5 && threshold < 1)) continue;

      const p0=Number(candidate.displayedOutcomePrices?.[0]);
      if (!(p0 > 0 && p0 < 1)) continue;
      let outcomeIndex=-1;
      if (p0 >= threshold) outcomeIndex=0;
      else if (p0 <= 1-threshold) outcomeIndex=1;
      if (outcomeIndex < 0) continue;

      const book=candidate.books?.find(b=>b.tokenId===candidate.tokenIds[outcomeIndex])
        || candidate.books?.[outcomeIndex];
      if (!book) continue;
      const execution=(book.executions || [])
        .filter(e=>Number(e.fillPct||0)>=99.5 && Number(e.budgetUsd||0)>=PAPER_TRADE_STAKE_USD)
        .sort((a,b)=>Number(a.budgetUsd)-Number(b.budgetUsd))[0]
        || (book.executions || [])
          .filter(e=>Number(e.fillPct||0)>=99.5)
          .sort((a,b)=>Number(b.budgetUsd)-Number(a.budgetUsd))[0];
      if (!execution || execution.avgFillPrice == null) continue;

      const stake=Math.min(PAPER_TRADE_STAKE_USD,Number(execution.spendableUsd||execution.budgetUsd||0));
      if (!(stake > 0)) continue;
      considered += 1;

      const result=await createPaperTrade({
        strategyId:`sample_walk_forward_${domain}_tMinus60m`,
        calibrationVersion:HISTORICAL_CALIBRATION_VERSION,
        conditionId:candidate.conditionId,
        marketId:candidate.id,
        slug:candidate.slug,
        question:candidate.question,
        domain,
        outcome:candidate.outcomes[outcomeIndex],
        tokenId:candidate.tokenIds[outcomeIndex],
        entryAt:new Date().toISOString(),
        expectedResolutionAt:candidate.endDate,
        entryPrice:Number(execution.avgFillPrice),
        stakeUsd:stake,
        expectedEdgeBps:Number(selected.minEdgeBps ?? 0),
        expectedRoiPct:Number(researchPolicy?.holdout?.roiPct ?? 0),
        feeRate:paperFeeRate(domain),
        policySnapshot:{
          selectedPolicy:selected,
          researchDeployable:researchPolicy?.deployable === true,
          productionDomainEnabled:policy?.perDomain?.[domain]?.enabled === true,
          calibration:policy?.calibration || null
        },
        marketSnapshot:{
          minutesRemaining:candidate.minutesRemaining,
          displayedOutcomePrices:candidate.displayedOutcomePrices,
          bestAsk:book.bestAsk,
          avgFillPrice:execution.avgFillPrice,
          fillPct:execution.fillPct,
          liquidityUsd:candidate.liquidityUsd,
          volume24hUsd:candidate.volume24hUsd
        }
      });
      if ((result as any)?.inserted) inserted += 1;
    }

    console.log(JSON.stringify({
      level:"info",
      message:"paper_trade_entries",
      considered,
      inserted,
      stakeUsd:PAPER_TRADE_STAKE_USD,
      at:new Date().toISOString()
    }));
  } catch(error) {
    console.error(JSON.stringify({
      level:"error",
      message:"paper_trade_entry_failed",
      error:errorMessage(error),
      at:new Date().toISOString()
    }));
  } finally {
    paperEntryRunning=false;
  }
}

async function runPaperSettlementWorker() {
  if (!PAPER_TRADING_ENABLED || paperSettlementRunning) return;
  paperSettlementRunning=true;
  try {
    const open=await getOpenPaperTrades(500);
    let resolved=0;
    for(const trade of open as any[]) {
      if (!trade.slug) continue;
      const expectedTs=trade.expectedResolutionAt ? Date.parse(trade.expectedResolutionAt) : NaN;
      if (Number.isFinite(expectedTs) && Date.now() < expectedTs) continue;
      const market=await getMarketBySlug(String(trade.slug)).catch(()=>null);
      if(!market) continue;
      const resolution=inferFinalResolution(market);
      if(!resolution) continue;
      const winning=String(resolution.winningOutcome || "");
      const chosen=String(trade.outcome || "");
      const won=winning.trim().toLowerCase() === chosen.trim().toLowerCase();
      await settlePaperTrade({
        id:trade.id,
        winningOutcome:winning || null,
        resolvedAt:new Date().toISOString(),
        won
      });
      resolved += 1;
    }
    if(open.length || resolved){
      console.log(JSON.stringify({
        level:"info",
        message:"paper_trade_settlement",
        checked:open.length,
        resolved,
        at:new Date().toISOString()
      }));
    }
  } catch(error) {
    console.error(JSON.stringify({
      level:"error",
      message:"paper_trade_settlement_failed",
      error:errorMessage(error),
      at:new Date().toISOString()
    }));
  } finally {
    paperSettlementRunning=false;
  }
}

async function runWalletIntelligenceWorker() {
  if (walletIntelligenceRunning) return;
  walletIntelligenceRunning = true;
  try {
    const profiles = await fetchTopWalletProfiles(WALLET_INTELLIGENCE_LIMIT);
    const persisted = await persistWalletIntelligenceProfiles(profiles);
    console.log(JSON.stringify({
      level: "info",
      message: "wallet_intelligence_refresh",
      requested: WALLET_INTELLIGENCE_LIMIT,
      profiles: profiles.length,
      persisted,
      at: new Date().toISOString()
    }));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "wallet_intelligence_refresh_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    walletIntelligenceRunning = false;
  }
}

async function runHistoricalBackfillWorker() {
  if (historicalBackfillRunning) return;
  historicalBackfillRunning = true;
  try {
    const runStarted = Date.now();
    const budgetMs = HISTORICAL_BACKFILL_RUN_MINUTES * 60_000;
    const cutoff = new Date(Date.now() - HISTORICAL_LOOKBACK_HOURS * 3600_000);
    const summary = await getHistoricalCalibrationSummary().catch(() => null) as any;

    const sampleCount = Number(summary?.sampleCount || 0);
    const causalV2Samples = Number(summary?.causalV2Samples || 0);
    const recalibrationComplete = sampleCount > 0 && causalV2Samples >= sampleCount;

    if (summary?.firstResolvedAt) {
      const earliestStored = Date.parse(summary.firstResolvedAt);
      if (
        Number.isFinite(earliestStored) &&
        earliestStored <= cutoff.getTime() &&
        recalibrationComplete
      ) {
        console.log(JSON.stringify({
          level: "info",
          message: "historical_calibration_backfill_complete",
          firstResolvedAt: summary.firstResolvedAt,
          targetCutoff: cutoff.toISOString(),
          targetYears: Number((HISTORICAL_LOOKBACK_HOURS / (24 * 365)).toFixed(2)),
          calibrationVersion: HISTORICAL_CALIBRATION_VERSION,
          causalV2Samples,
          sampleCount,
          at: new Date().toISOString()
        }));
        return;
      }
    }

    const needsRecalibration = sampleCount > causalV2Samples;

    if (needsRecalibration) {
      let directStored = 0;
      let directSkipped = 0;
      let directChecked = 0;
      while (Date.now() - runStarted < budgetMs) {
        const stale = await getStaleHistoricalCalibrationRefs(
          Math.max(HISTORICAL_BACKFILL_LIMIT, 500),
          HISTORICAL_CALIBRATION_VERSION
        );
        if (!stale.length) break;
        directChecked += stale.length;

        const recalibrationConcurrency = Math.max(
          4,
          Math.min(24, Number(process.env.HISTORICAL_RECALIBRATION_CONCURRENCY || 12))
        );
        for (let i = 0; i < stale.length && Date.now() - runStarted < budgetMs; i += recalibrationConcurrency) {
          const batch = stale.slice(i, i + recalibrationConcurrency);
          const results = await Promise.all(batch.map(async ref => {
            try {
              const storedRef = {
                conditionId:String((ref as any).conditionId || ""),
                marketId:(ref as any).marketId ? String((ref as any).marketId) : null,
                slug:(ref as any).slug ? String((ref as any).slug) : null,
                question:String((ref as any).question || ""),
                domain:String((ref as any).domain || "other"),
                resolvedAt:String((ref as any).resolvedAt || ""),
                outcome0:String((ref as any).outcome0 || ""),
                outcome1:String((ref as any).outcome1 || ""),
                actualOutcome0:Number((ref as any).actualOutcome0) as 0 | 1,
                winningOutcome:String((ref as any).winningOutcome || ""),
                token0Id:String((ref as any).token0Id || "")
              } as StoredHistoricalCalibrationRef;

              if (storedRef.token0Id && storedRef.resolvedAt && storedRef.question) {
                const directSample = await rebuildHistoricalCalibrationSampleFromStored(storedRef);
                return directSample
                  ? { ref, sample:directSample, reason:null }
                  : { ref, sample:null, reason:"causal_price_history_unavailable" };
              }

              // Legacy rows missing stored token metadata fall back to Gamma.
              const market = await getMarketBySlug(String((ref as any).slug || ""));
              if (!market) {
                return { ref, sample:null, reason:"market_lookup_unavailable" };
              }
              const sample = await buildHistoricalCalibrationSample(market);
              return sample
                ? { ref, sample, reason:null }
                : { ref, sample:null, reason:"causal_price_history_unavailable" };
            } catch (error) {
              return { ref, sample:null, reason:errorMessage(error) };
            }
          }));
          for (const result of results) {
            if (!result.sample) {
              directSkipped += 1;
              await recordHistoricalCalibrationRebuildFailure(
                String(result.ref.conditionId || ""),
                String(result.reason || "unknown_rebuild_failure"),
                5
              ).catch(() => null);
              continue;
            }
            await upsertHistoricalCalibrationSample(result.sample);
            directStored += 1;
          }
        }

        // Failed rows are moved to the back of the retry queue by updating
        // their attempt metadata, so the same unrebuildable head cannot stall
        // the other historical rows. After repeated failures they are explicitly
        // quarantined from strategy data rather than silently treated as causal.

      }

      const refreshed = await getHistoricalCalibrationSummary().catch(() => null) as any;
      const remaining = Number(refreshed?.causalV2Remaining || 0);
      console.log(JSON.stringify({
        level:"info",
        message:"historical_causal_v2_recalibration",
        calibrationVersion:HISTORICAL_CALIBRATION_VERSION,
        checked:directChecked,
        stored:directStored,
        skipped:directSkipped,
        causalV2Samples:Number(refreshed?.causalV2Samples || causalV2Samples),
        sampleCount:Number(refreshed?.sampleCount || sampleCount),
        remaining,
        progressPct:Number(refreshed?.causalV2ProgressPct || 0),
        runtimeSeconds:Number(((Date.now()-runStarted)/1000).toFixed(1)),
        at:new Date().toISOString()
      }));

      if (remaining === 0 || Date.now() - runStarted >= budgetMs) return;
    }

    let cursorEnd = needsRecalibration
      ? new Date()
      : summary?.firstResolvedAt
        ? new Date(Date.parse(summary.firstResolvedAt) - 1)
        : new Date();
    if (!Number.isFinite(cursorEnd.getTime())) cursorEnd = new Date();

    let stored = 0;
    let skipped = 0;
    let windows = 0;
    let checked = 0;
    let saturatedWindows = 0;
    let windowDays = HISTORICAL_BACKFILL_WINDOW_DAYS;

    while (cursorEnd > cutoff && Date.now() - runStarted < budgetMs) {
      const cursorStart = new Date(Math.max(
        cutoff.getTime(),
        cursorEnd.getTime() - windowDays * 86_400_000
      ));

      let closedMarkets;
      try {
        closedMarkets = await listClosedMarketsEndingBetween(cursorStart, cursorEnd, 50, 100);
      } catch (error) {
        const message = errorMessage(error);
        if (windowDays > 1) {
          saturatedWindows += 1;
          windowDays = Math.max(1, Math.floor(windowDays / 2));
          console.warn(JSON.stringify({
            level: "warn",
            message: "historical_backfill_window_retry",
            error: message,
            cursorStart: cursorStart.toISOString(),
            cursorEnd: cursorEnd.toISOString(),
            nextWindowDays: windowDays,
            at: new Date().toISOString()
          }));
          continue;
        }

        // A single persistently failing day should not stall the entire
        // multi-year cursor forever. Skip that one-day window and continue.
        console.warn(JSON.stringify({
          level: "warn",
          message: "historical_backfill_window_skipped",
          error: message,
          cursorStart: cursorStart.toISOString(),
          cursorEnd: cursorEnd.toISOString(),
          at: new Date().toISOString()
        }));
        windows += 1;
        cursorEnd = new Date(cursorStart.getTime() - 1);
        windowDays = HISTORICAL_BACKFILL_WINDOW_DAYS;
        continue;
      }

      if (closedMarkets.length >= 5000 && windowDays > 1) {
        saturatedWindows += 1;
        windowDays = Math.max(1, Math.floor(windowDays / 2));
        continue;
      }

      checked += closedMarkets.length;
      const eligible = closedMarkets.filter(market =>
        Boolean(market.conditionId) && classifyHistoricalDomain(market) !== null
      );
      const conditionIds = eligible.map(market => String(market.conditionId || "")).filter(Boolean);
      const known = await getKnownHistoricalCalibrationIds(conditionIds);
      const pending = eligible
        .filter(market => !known.has(String(market.conditionId || "")))
        .slice(0, HISTORICAL_BACKFILL_LIMIT);

      for (let i = 0; i < pending.length && Date.now() - runStarted < budgetMs; i += 6) {
        const batch = pending.slice(i, i + 6);
        const samples = await Promise.all(batch.map(async market => {
          try { return await buildHistoricalCalibrationSample(market); }
          catch { return null; }
        }));
        for (const sample of samples) {
          if (!sample) { skipped += 1; continue; }
          await upsertHistoricalCalibrationSample(sample);
          stored += 1;
        }
      }

      windows += 1;
      cursorEnd = new Date(cursorStart.getTime() - 1);
      windowDays = HISTORICAL_BACKFILL_WINDOW_DAYS;
    }

    console.log(JSON.stringify({
      level: "info",
      message: "historical_calibration_backfill",
      targetLookbackHours: HISTORICAL_LOOKBACK_HOURS,
      targetYears: Number((HISTORICAL_LOOKBACK_HOURS / (24 * 365)).toFixed(2)),
      calibrationVersion: HISTORICAL_CALIBRATION_VERSION,
      recalibrationMode: needsRecalibration,
      causalV2SamplesBefore: causalV2Samples,
      sampleCountBefore: sampleCount,
      windows,
      saturatedWindows,
      checked,
      stored,
      skipped,
      nextCursorEnd: cursorEnd.toISOString(),
      targetCutoff: cutoff.toISOString(),
      runtimeSeconds: Number(((Date.now() - runStarted) / 1000).toFixed(1)),
      at: new Date().toISOString()
    }));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "historical_calibration_backfill_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    historicalBackfillRunning = false;
  }
}

async function runResolutionWorker() {
  if (resolutionWorkerRunning) return;
  resolutionWorkerRunning = true;
  try {
    const unresolved = await getUnresolvedObservedMarkets(100);
    let recorded = 0;
    for (const observed of unresolved) {
      const market = await getMarketBySlug(observed.slug).catch(() => null);
      if (!market) continue;
      const resolution = inferFinalResolution(market);
      if (!resolution) continue;

      await recordResolution({
        conditionId: observed.conditionId,
        marketId: observed.marketId,
        resolvedAt: new Date().toISOString(),
        winningOutcome: resolution.winningOutcome,
        winningTokenId: resolution.winningTokenId,
        source: "gamma_final_prices",
        payload: {
          slug: observed.slug,
          question: observed.question,
          finalPrices: resolution.finalPrices,
          winningIndex: resolution.winningIndex
        }
      });
      recorded += 1;
    }

    if (unresolved.length || recorded) {
      console.log(JSON.stringify({
        level: "info",
        message: "resolution_worker",
        checked: unresolved.length,
        recorded,
        at: new Date().toISOString()
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "resolution_worker_failed",
      error: errorMessage(error),
      at: new Date().toISOString()
    }));
  } finally {
    resolutionWorkerRunning = false;
  }
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({
    level: "info",
    message: "Polymarket MCP listening",
    version: VERSION,
    port: PORT,
    mode: "non-custodial-control-plane",
    serviceRole: SERVICE_ROLE,
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

  if (ROLE_API) {
    runOpenAISelfTest()
      .then(result => console.log(JSON.stringify({
        level: result.ok ? "info" : "warn",
        message: result.ok ? "gpt_self_test" : "gpt_self_test_skipped",
        result,
        at: new Date().toISOString()
      })))
      .catch(error => console.error(JSON.stringify({
        level: "error",
        message: "gpt_self_test_failed",
        error: errorMessage(error),
        at: new Date().toISOString()
      })));
  }

  runWorkerHeartbeat().catch(() => {});
  setInterval(() => {
    runWorkerHeartbeat().catch(() => {});
  }, 15_000).unref();

  if (ROLE_STREAMS) {
    sportsTracker.start();

    runRealtimeTargetRefresh().catch(() => {});
    setInterval(() => {
      runRealtimeTargetRefresh().catch(() => {});
    }, 10_000).unref();

    runStreamPersistenceWorker().catch(() => {});
    setInterval(() => {
      runStreamPersistenceWorker().catch(() => {});
    }, STREAM_PERSIST_SECONDS * 1000).unref();

    runQuoteCompactionWorker().catch(() => {});
    setInterval(() => {
      runQuoteCompactionWorker().catch(() => {});
    }, QUOTE_COMPACTION_SECONDS * 1000).unref();
  }

  if (ROLE_SCANNER) {
    runBackgroundScan().catch(() => {});
    setInterval(() => {
      runBackgroundScan().catch(() => {});
    }, BACKGROUND_SCAN_SECONDS * 1000).unref();

    runPaperEntryWorker().catch(() => {});
    setInterval(() => {
      runPaperEntryWorker().catch(() => {});
    }, PAPER_TRADING_SECONDS * 1000).unref();

    setTimeout(() => runStructuralScan().catch(() => {}), 15_000).unref();
    setInterval(() => {
      runStructuralScan().catch(() => {});
    }, STRUCTURAL_SCAN_SECONDS * 1000).unref();
  }

  if (ROLE_HISTORY) {
    runResolutionWorker().catch(() => {});
    setInterval(() => {
      runResolutionWorker().catch(() => {});
    }, RESOLUTION_CHECK_SECONDS * 1000).unref();

    runHistoricalBackfillWorker().catch(() => {});
    setInterval(() => {
      runHistoricalBackfillWorker().catch(() => {});
    }, HISTORICAL_BACKFILL_SECONDS * 1000).unref();

    runWalletIntelligenceWorker().catch(() => {});
    setInterval(() => {
      runWalletIntelligenceWorker().catch(() => {});
    }, WALLET_INTELLIGENCE_SECONDS * 1000).unref();

    runPaperSettlementWorker().catch(() => {});
    setInterval(() => {
      runPaperSettlementWorker().catch(() => {});
    }, PAPER_TRADING_SECONDS * 1000).unref();
  }

  if (ROLE_MAINTENANCE) {
    runMaintenanceWorker().catch(() => {});
    setInterval(() => {
      runMaintenanceWorker().catch(() => {});
    }, MAINTENANCE_SECONDS * 1000).unref();
  }
});

function shutdown(signal: string) {
  if (ROLE_STREAMS) {
    realtimeTracker.close();
    sportsTracker.close();
  }
  console.log(JSON.stringify({ level: "info", message: "shutdown", signal }));
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
