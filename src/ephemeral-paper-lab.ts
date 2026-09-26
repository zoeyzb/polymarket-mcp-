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

let nextId=1;
let trades:EphemeralPaperTrade[]=[];

export function resetEphemeralPaperLab(){
  nextId=1;
  trades=[];
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
  return {configured:true,inserted:true,id:trade.id};
}

export function getEphemeralOpenTrades(limit=500){
  return trades.filter(t=>t.status==="OPEN").slice(0,Math.max(1,limit));
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


export function listEphemeralPaperTrades(limit=500,prefix=""){
  const bounded=Math.max(1,Math.min(5000,Number(limit||500)));
  const rows=prefix ? trades.filter(t=>t.strategyId.startsWith(prefix)) : [...trades];
  return rows
    .slice()
    .sort((a,b)=>Date.parse(b.entryAt)-Date.parse(a.entryAt) || b.id-a.id)
    .slice(0,bounded);
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
