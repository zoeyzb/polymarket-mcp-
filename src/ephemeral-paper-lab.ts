import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type EphemeralStatus="OPEN"|"WIN"|"LOSS";

export interface EphemeralPaperTradeInput {
  strategyId:string;
  conditionId:string;
  tokenId:string;
  slug:string;
  question:string;
  domain:string;
  family:string;
  outcome:string;
  entryPrice:number;
  stakeUsd:number;
  expectedResolutionAt:string|null;
}

interface EphemeralPaperTrade extends EphemeralPaperTradeInput {
  id:number;
  entryAt:string;
  status:EphemeralStatus;
  resolvedAt:string|null;
  winningOutcome:string|null;
  netPnlUsd:number|null;
  realizedRoiPct:number|null;
}

export interface StructuralBasketPaperInput {
  eventId:string;
  eventTitle:string|null;
  marketCount:number;
  yesTokenIds:string[];
  budgetUsd:number;
  netProfitUsd:number;
  netRoiPct:number;
}

interface StructuralBasketPaperObservation extends StructuralBasketPaperInput {
  id:number;
  firstSeenAt:string;
  lastSeenAt:string;
  sightings:number;
  bestNetProfitUsd:number;
  bestNetRoiPct:number;
}

let nextId=1;
let trades:EphemeralPaperTrade[]=[];
let structuralBaskets:StructuralBasketPaperObservation[]=[];
let persistencePath:string|null=null;
let persistenceLoadedAt:string|null=null;
let persistenceLastWriteAt:string|null=null;
let persistenceLastError:string|null=null;

function errorText(error:unknown){
  return error instanceof Error ? error.message : String(error);
}

function validTrade(value:any): value is EphemeralPaperTrade {
  return Boolean(
    value &&
    Number.isFinite(Number(value.id)) &&
    typeof value.strategyId==="string" &&
    typeof value.conditionId==="string" &&
    typeof value.tokenId==="string" &&
    typeof value.slug==="string" &&
    typeof value.question==="string" &&
    typeof value.domain==="string" &&
    typeof value.family==="string" &&
    typeof value.outcome==="string" &&
    Number.isFinite(Number(value.entryPrice)) &&
    Number.isFinite(Number(value.stakeUsd)) &&
    typeof value.entryAt==="string" &&
    ["OPEN","WIN","LOSS"].includes(String(value.status))
  );
}

function validStructuralBasket(value:any): value is StructuralBasketPaperObservation {
  return Boolean(
    value &&
    Number.isFinite(Number(value.id)) &&
    typeof value.eventId==="string" &&
    Number.isFinite(Number(value.marketCount)) &&
    Array.isArray(value.yesTokenIds) &&
    Number.isFinite(Number(value.budgetUsd)) &&
    Number.isFinite(Number(value.netProfitUsd)) &&
    Number.isFinite(Number(value.netRoiPct)) &&
    typeof value.firstSeenAt==="string" &&
    typeof value.lastSeenAt==="string" &&
    Number.isFinite(Number(value.sightings))
  );
}

function persistEphemeralPaperState(){
  if(!persistencePath) return {configured:false,written:false};
  const tempPath=`${persistencePath}.${process.pid}.tmp`;
  try{
    mkdirSync(dirname(persistencePath),{recursive:true});
    const payload={
      version:2,
      writtenAt:new Date().toISOString(),
      nextId,
      trades,
      structuralBaskets
    };
    writeFileSync(tempPath,JSON.stringify(payload),"utf8");
    renameSync(tempPath,persistencePath);
    persistenceLastWriteAt=payload.writtenAt;
    persistenceLastError=null;
    return {configured:true,written:true,at:payload.writtenAt};
  }catch(error){
    persistenceLastError=errorText(error);
    try{ if(existsSync(tempPath)) unlinkSync(tempPath); }catch{}
    return {configured:true,written:false,error:persistenceLastError};
  }
}

export function configureEphemeralPaperPersistence(filePath:string|null){
  const nextPath=String(filePath||"").trim();
  persistencePath=nextPath || null;
  persistenceLoadedAt=null;
  persistenceLastWriteAt=null;
  persistenceLastError=null;

  if(!persistencePath){
    return {configured:false,loadedTrades:0};
  }

  try{
    mkdirSync(dirname(persistencePath),{recursive:true});
    if(!existsSync(persistencePath)){
      return {configured:true,loadedTrades:0,filePath:persistencePath};
    }
    const parsed=JSON.parse(readFileSync(persistencePath,"utf8"));
    const loaded=Array.isArray(parsed?.trades) ? parsed.trades.filter(validTrade) : [];
    const loadedBaskets=Array.isArray(parsed?.structuralBaskets)
      ? parsed.structuralBaskets.filter(validStructuralBasket)
      : [];
    trades=loaded.map((trade:any)=>({
      ...trade,
      id:Number(trade.id),
      entryPrice:Number(trade.entryPrice),
      stakeUsd:Number(trade.stakeUsd),
      netPnlUsd:trade.netPnlUsd==null ? null : Number(trade.netPnlUsd),
      realizedRoiPct:trade.realizedRoiPct==null ? null : Number(trade.realizedRoiPct),
      resolvedAt:trade.resolvedAt ?? null,
      winningOutcome:trade.winningOutcome ?? null,
      expectedResolutionAt:trade.expectedResolutionAt ?? null
    }));
    structuralBaskets=loadedBaskets.map((basket:any)=>({
      ...basket,
      id:Number(basket.id),
      marketCount:Number(basket.marketCount),
      yesTokenIds:basket.yesTokenIds.map(String),
      budgetUsd:Number(basket.budgetUsd),
      netProfitUsd:Number(basket.netProfitUsd),
      netRoiPct:Number(basket.netRoiPct),
      sightings:Math.max(1,Number(basket.sightings)||1),
      bestNetProfitUsd:Number(basket.bestNetProfitUsd ?? basket.netProfitUsd),
      bestNetRoiPct:Number(basket.bestNetRoiPct ?? basket.netRoiPct)
    }));
    const maxId=Math.max(
      trades.reduce((max,trade)=>Math.max(max,Number(trade.id)||0),0),
      structuralBaskets.reduce((max,basket)=>Math.max(max,Number(basket.id)||0),0)
    );
    nextId=Math.max(maxId+1,Number(parsed?.nextId)||1);
    persistenceLoadedAt=new Date().toISOString();
    return {
      configured:true,
      loadedTrades:trades.length,
      loadedStructuralBaskets:structuralBaskets.length,
      filePath:persistencePath,
      loadedAt:persistenceLoadedAt
    };
  }catch(error){
    persistenceLastError=errorText(error);
    return {
      configured:true,
      loadedTrades:0,
      filePath:persistencePath,
      error:persistenceLastError
    };
  }
}

export function getEphemeralPaperPersistenceStatus(){
  return {
    configured:Boolean(persistencePath),
    filePath:persistencePath,
    loadedAt:persistenceLoadedAt,
    lastWriteAt:persistenceLastWriteAt,
    lastError:persistenceLastError,
    trades:trades.length,
    openTrades:trades.filter(trade=>trade.status==="OPEN").length,
    structuralBaskets:structuralBaskets.length
  };
}

export function resetEphemeralPaperLab(){
  nextId=1;
  trades=[];
  structuralBaskets=[];
  persistEphemeralPaperState();
}

export function createEphemeralPaperTrade(input:EphemeralPaperTradeInput){
  const duplicate=trades.some(trade=>
    trade.strategyId===input.strategyId &&
    trade.conditionId===input.conditionId &&
    trade.tokenId===input.tokenId
  );
  if(duplicate) return {configured:true,inserted:false,id:null};
  const trade:EphemeralPaperTrade={
    ...input,
    id:nextId++,
    entryAt:new Date().toISOString(),
    status:"OPEN",
    resolvedAt:null,
    winningOutcome:null,
    netPnlUsd:null,
    realizedRoiPct:null
  };
  trades.push(trade);
  persistEphemeralPaperState();
  return {configured:true,inserted:true,id:trade.id};
}

export function recordStructuralBasketPaper(input:StructuralBasketPaperInput){
  const eventId=String(input.eventId||"").trim();
  const tokenKey=[...input.yesTokenIds].map(String).sort().join("|");
  if(!eventId || !tokenKey) return {configured:true,inserted:false,updated:false,id:null};
  const now=new Date().toISOString();
  const existing=structuralBaskets.find(row=>
    row.eventId===eventId &&
    [...row.yesTokenIds].map(String).sort().join("|")===tokenKey
  );
  if(existing){
    existing.lastSeenAt=now;
    existing.sightings+=1;
    if(Number(input.netProfitUsd)>existing.bestNetProfitUsd){
      existing.bestNetProfitUsd=Number(input.netProfitUsd);
      existing.bestNetRoiPct=Number(input.netRoiPct);
      existing.budgetUsd=Number(input.budgetUsd);
      existing.netProfitUsd=Number(input.netProfitUsd);
      existing.netRoiPct=Number(input.netRoiPct);
      existing.marketCount=Number(input.marketCount);
      existing.eventTitle=input.eventTitle;
    }
    persistEphemeralPaperState();
    return {configured:true,inserted:false,updated:true,id:existing.id};
  }
  const row:StructuralBasketPaperObservation={
    ...input,
    id:nextId++,
    eventId,
    eventTitle:input.eventTitle ?? null,
    marketCount:Number(input.marketCount),
    yesTokenIds:input.yesTokenIds.map(String),
    budgetUsd:Number(input.budgetUsd),
    netProfitUsd:Number(input.netProfitUsd),
    netRoiPct:Number(input.netRoiPct),
    firstSeenAt:now,
    lastSeenAt:now,
    sightings:1,
    bestNetProfitUsd:Number(input.netProfitUsd),
    bestNetRoiPct:Number(input.netRoiPct)
  };
  structuralBaskets.push(row);
  persistEphemeralPaperState();
  return {configured:true,inserted:true,updated:false,id:row.id};
}

export function listStructuralBasketPaper(limit=100){
  return structuralBaskets
    .slice()
    .sort((a,b)=>b.bestNetProfitUsd-a.bestNetProfitUsd || Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt))
    .slice(0,Math.max(1,Math.min(1000,Number(limit||100))));
}

export function getStructuralBasketPaperStats(){
  const simulatedCapitalUsd=structuralBaskets.reduce((sum,row)=>sum+Number(row.budgetUsd||0),0);
  const simulatedNetProfitUsd=structuralBaskets.reduce((sum,row)=>sum+Number(row.netProfitUsd||0),0);
  return {
    configured:true,
    paperOnly:true,
    uniqueBaskets:structuralBaskets.length,
    sightings:structuralBaskets.reduce((sum,row)=>sum+Number(row.sightings||0),0),
    simulatedCapitalUsd:Math.round(simulatedCapitalUsd*1e6)/1e6,
    simulatedNetProfitUsd:Math.round(simulatedNetProfitUsd*1e6)/1e6,
    simulatedRoiPct:simulatedCapitalUsd>0
      ? Math.round((simulatedNetProfitUsd/simulatedCapitalUsd)*100000)/1000
      : null,
    bestNetRoiPct:structuralBaskets.length
      ? Math.max(...structuralBaskets.map(row=>Number(row.bestNetRoiPct||0)))
      : null,
    note:"Depth-and-buffer-verified structural basket observations. Paper-only; not live fills or guaranteed realized profit."
  };
}

export function getEphemeralOpenTrades(limit=500){
  return trades.filter(t=>t.status==="OPEN").slice(0,Math.max(1,limit));
}


export function listEphemeralPaperTrades(limit=500,prefix=""){
  const bounded=Math.max(1,Math.min(5000,Number(limit||500)));
  const rows=prefix ? trades.filter(t=>t.strategyId.startsWith(prefix)) : [...trades];
  return rows
    .slice()
    .sort((a,b)=>Date.parse(b.entryAt)-Date.parse(a.entryAt) || b.id-a.id)
    .slice(0,bounded);
}

export function settleEphemeralPaperTrade(input:{id:number;won:boolean;winningOutcome:string|null}){
  const trade=trades.find(t=>t.id===input.id && t.status==="OPEN");
  if(!trade) return {updated:false};
  const gross=input.won ? trade.stakeUsd*((1/trade.entryPrice)-1) : -trade.stakeUsd;
  const feeRate=trade.domain==="crypto" ? 0.07 : 0.05;
  const fee=input.won ? (trade.stakeUsd/trade.entryPrice)*feeRate*trade.entryPrice*(1-trade.entryPrice) : 0;
  const net=gross-fee;
  trade.status=input.won?"WIN":"LOSS";
  trade.resolvedAt=new Date().toISOString();
  trade.winningOutcome=input.winningOutcome;
  trade.netPnlUsd=Math.round(net*1e6)/1e6;
  trade.realizedRoiPct=trade.stakeUsd>0 ? Math.round((net/trade.stakeUsd)*100000)/1000 : 0;
  persistEphemeralPaperState();
  return {updated:true,trade};
}

export function getEphemeralPaperStats(prefix=""){
  const rows=prefix ? trades.filter(t=>t.strategyId.startsWith(prefix)) : [...trades];
  const resolved=rows.filter(t=>t.status==="WIN"||t.status==="LOSS");
  const wins=resolved.filter(t=>t.status==="WIN").length;
  const losses=resolved.filter(t=>t.status==="LOSS").length;
  const open=rows.filter(t=>t.status==="OPEN");
  const netPnlUsd=resolved.reduce((sum,t)=>sum+Number(t.netPnlUsd||0),0);
  const resolvedStakeUsd=resolved.reduce((sum,t)=>sum+t.stakeUsd,0);
  return {
    configured:true,
    ephemeral:true,
    trades:rows.length,
    openTrades:open.length,
    wins,
    losses,
    resolvedTrades:resolved.length,
    openExposureUsd:open.reduce((sum,t)=>sum+t.stakeUsd,0),
    netPnlUsd:Math.round(netPnlUsd*1e6)/1e6,
    resolvedStakeUsd,
    winRatePct:resolved.length ? Math.round((wins/resolved.length)*100000)/1000 : null,
    aggregateRoiPct:resolvedStakeUsd>0 ? Math.round((netPnlUsd/resolvedStakeUsd)*100000)/1000 : null
  };
}

export function getEphemeralDailyStats(prefix="",day=new Date().toISOString().slice(0,10)){
  const rows=trades.filter(t=>
    (!prefix || t.strategyId.startsWith(prefix)) &&
    t.entryAt.slice(0,10)===day
  );
  const resolved=rows.filter(t=>t.status==="WIN"||t.status==="LOSS");
  const wins=resolved.filter(t=>t.status==="WIN").length;
  const losses=resolved.filter(t=>t.status==="LOSS").length;
  const open=rows.filter(t=>t.status==="OPEN");
  const netPnlUsd=resolved.reduce((sum,t)=>sum+Number(t.netPnlUsd||0),0);
  const resolvedStakeUsd=resolved.reduce((sum,t)=>sum+t.stakeUsd,0);
  return {
    configured:true,
    ephemeral:true,
    day,
    trades:rows.length,
    openTrades:open.length,
    wins,
    losses,
    resolvedTrades:resolved.length,
    openExposureUsd:Math.round(open.reduce((sum,t)=>sum+t.stakeUsd,0)*1e6)/1e6,
    netPnlUsd:Math.round(netPnlUsd*1e6)/1e6,
    resolvedStakeUsd:Math.round(resolvedStakeUsd*1e6)/1e6,
    winRatePct:resolved.length ? Math.round((wins/resolved.length)*100000)/1000 : null,
    aggregateRoiPct:resolvedStakeUsd>0 ? Math.round((netPnlUsd/resolvedStakeUsd)*100000)/1000 : null
  };
}


export function getEphemeralConfidenceStats(prefix="research_shadow_"){
  const bands=["ultra_high","high","exploratory"];
  return bands.map(confidenceBand=>{
    const stats=getEphemeralPaperStats(prefix+confidenceBand+"_");
    return {confidenceBand,...stats};
  });
}


export function getEphemeralFamilyStats(prefix="research_shadow_"){
  const rows=prefix ? trades.filter(t=>t.strategyId.startsWith(prefix)) : [...trades];
  const families=[...new Set(rows.map(t=>t.family).filter(Boolean))];
  return families.map(family=>{
    const familyRows=rows.filter(t=>t.family===family);
    const resolved=familyRows.filter(t=>t.status==="WIN"||t.status==="LOSS");
    const wins=resolved.filter(t=>t.status==="WIN").length;
    const losses=resolved.filter(t=>t.status==="LOSS").length;
    const open=familyRows.filter(t=>t.status==="OPEN");
    const netPnlUsd=resolved.reduce((sum,t)=>sum+Number(t.netPnlUsd||0),0);
    const resolvedStakeUsd=resolved.reduce((sum,t)=>sum+Number(t.stakeUsd||0),0);
    return {
      family,
      trades:familyRows.length,
      openTrades:open.length,
      resolvedTrades:resolved.length,
      wins,
      losses,
      openExposureUsd:Math.round(open.reduce((sum,t)=>sum+Number(t.stakeUsd||0),0)*1e6)/1e6,
      netPnlUsd:Math.round(netPnlUsd*1e6)/1e6,
      resolvedStakeUsd:Math.round(resolvedStakeUsd*1e6)/1e6,
      winRatePct:resolved.length ? Math.round((wins/resolved.length)*100000)/1000 : null,
      aggregateRoiPct:resolvedStakeUsd>0 ? Math.round((netPnlUsd/resolvedStakeUsd)*100000)/1000 : null
    };
  }).sort((a,b)=>b.resolvedTrades-a.resolvedTrades || Number(b.winRatePct||0)-Number(a.winRatePct||0));
}
