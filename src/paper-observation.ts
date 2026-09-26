import { marketFamilyFromCandidate, type MarketFamily } from "./market-family.js";
import type { ScanCandidate } from "./types.js";

export interface ObservationSelection {
  candidate:ScanCandidate;
  family:MarketFamily;
  outcomeIndex:number;
  tokenId:string;
  displayedPrice:number;
}

export function selectObservationCandidates(
  candidates:ScanCandidate[],
  options?:{
    limit?:number;
    perFamilyLimit?:number;
    minLiquidityUsd?:number;
    minPrice?:number;
    maxPrice?:number;
  }
):ObservationSelection[] {
  const limit=Math.max(1,Math.min(2000,Number(options?.limit??500)));
  const perFamilyLimit=Math.max(1,Math.min(500,Number(options?.perFamilyLimit??100)));
  const minLiquidity=Math.max(0,Number(options?.minLiquidityUsd??250));
  const minPrice=Math.max(0.5,Math.min(0.99,Number(options?.minPrice??0.6)));
  const maxPrice=Math.max(minPrice,Math.min(0.999,Number(options?.maxPrice??0.99)));

  const seen=new Set<string>();
  const byFamily=new Map<MarketFamily,ObservationSelection[]>();
  const familyOrder:MarketFamily[]=[];

  const ordered=[...candidates].sort((a,b)=>
    Number(a.minutesRemaining||0)-Number(b.minutesRemaining||0) ||
    Number(b.liquidityUsd||0)-Number(a.liquidityUsd||0)
  );

  for(const candidate of ordered){
    const category=String(candidate.primaryCategory||"").toLowerCase();
    const isSports=Boolean(candidate.sportsStructure) ||
      ["sports","nba","basketball","soccer","games_esports"].includes(category);
    if(!isSports) continue;
    if(Number(candidate.liquidityUsd||0)<minLiquidity) continue;

    const prices=(candidate.displayedOutcomePrices||[]).map(Number);
    let outcomeIndex=-1;
    let displayedPrice=-Infinity;
    for(let i=0;i<prices.length;i++){
      if(Number.isFinite(prices[i]) && prices[i]>displayedPrice){
        displayedPrice=prices[i];
        outcomeIndex=i;
      }
    }
    if(outcomeIndex<0 || displayedPrice<minPrice || displayedPrice>maxPrice) continue;
    const tokenId=String(candidate.tokenIds?.[outcomeIndex]||"");
    if(!tokenId) continue;

    const condition=String(candidate.conditionId||candidate.id||candidate.slug||candidate.question||"");
    const key=`${condition}:${tokenId}`;
    if(!condition || seen.has(key)) continue;

    const family=marketFamilyFromCandidate(candidate,"sports");
    const bucket=byFamily.get(family) || [];
    if(bucket.length>=perFamilyLimit) continue;

    seen.add(key);
    if(!byFamily.has(family)) familyOrder.push(family);
    bucket.push({candidate,family,outcomeIndex,tokenId,displayedPrice});
    byFamily.set(family,bucket);
  }

  // Round-robin families so a burst of thousands of correlated props from one
  // market family cannot crowd every other family out of the evidence ledger.
  const rows:ObservationSelection[]=[];
  for(let index=0;rows.length<limit;index++){
    let added=false;
    for(const family of familyOrder){
      const row=byFamily.get(family)?.[index];
      if(!row) continue;
      rows.push(row);
      added=true;
      if(rows.length>=limit) break;
    }
    if(!added) break;
  }

  return rows;
}
