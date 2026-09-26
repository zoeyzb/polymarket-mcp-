export interface GrowthCandidate {
  id:string;
  domain:string;
  family:string;
  entryPrice:number;
  liquidityUsd:number;
  minutesRemaining:number;
  empiricalResolvedTrades?:number;
  empiricalWinRatePct?:number|null;
  empiricalRoiPct?:number|null;
}

export interface GrowthSelectionOptions {
  excludedIds?: Set<string>;
  excludedFamilies?: Set<string>;
  minEmpiricalSamples?: number;
  minEmpiricalWinRatePct?: number;
}

function isEmpiricallyProven(candidate:GrowthCandidate,minSamples:number){
  return Math.max(0,Number(candidate.empiricalResolvedTrades||0))>=minSamples;
}

function growthScore(candidate:GrowthCandidate,minSamples:number) {
  const price=Number(candidate.entryPrice);
  const minutes=Math.max(1,Number(candidate.minutesRemaining||0));
  const liquidity=Math.max(0,Number(candidate.liquidityUsd||0));

  // Paper-only heuristic: favor sports, a confidence/payout balance around 85%,
  // faster capital recycling, and enough liquidity to make fills realistic.
  const sportsBonus=candidate.domain==="sports" ? 100 : 0;
  const balanceScore=50-Math.abs(price-0.85)*220;
  const turnoverScore=Math.max(-20,20-Math.log2(minutes+1)*3);
  const liquidityScore=Math.min(15,Math.log10(liquidity+1)*4);

  // Once a family has enough resolved paper evidence, actual win rate / ROI
  // should dominate the heuristic rather than treating proven and unproven
  // families as equivalent forever.
  const samples=Math.max(0,Number(candidate.empiricalResolvedTrades||0));
  const proven=isEmpiricallyProven(candidate,minSamples);
  const empiricalWinRate=Number(candidate.empiricalWinRatePct);
  const empiricalRoi=Number(candidate.empiricalRoiPct);
  const empiricalScore=proven
    ? 80
      + (Number.isFinite(empiricalWinRate) ? Math.max(-30,Math.min(30,(empiricalWinRate-92)*4)) : 0)
      + (Number.isFinite(empiricalRoi) ? Math.max(-20,Math.min(20,empiricalRoi*2)) : 0)
      + Math.min(10,Math.log10(samples+1)*4)
    : 0;

  return sportsBonus+balanceScore+turnoverScore+liquidityScore+empiricalScore;
}

export function chooseGrowthCandidate(
  candidates:GrowthCandidate[],
  options:GrowthSelectionOptions={}
):GrowthCandidate|null {
  const minSamples=Math.max(1,Number(options.minEmpiricalSamples??20));
  const minWinRate=Math.max(50,Math.min(100,Number(options.minEmpiricalWinRatePct??92)));

  const eligible=candidates
    .filter(candidate=>!options.excludedIds?.has(candidate.id))
    .filter(candidate=>!options.excludedFamilies?.has(candidate.family))
    .filter(candidate=>{
      if(
        !Number.isFinite(candidate.entryPrice) ||
        candidate.entryPrice<0.72 ||
        candidate.entryPrice>0.97 ||
        Number(candidate.liquidityUsd||0)<=0 ||
        !Number.isFinite(candidate.minutesRemaining) ||
        candidate.minutesRemaining<0
      ) return false;

      if(isEmpiricallyProven(candidate,minSamples)){
        const winRate=Number(candidate.empiricalWinRatePct);
        const roi=Number(candidate.empiricalRoiPct);
        if(!Number.isFinite(winRate) || winRate<minWinRate) return false;
        if(Number.isFinite(roi) && roi<0) return false;
      }
      return true;
    })
    .sort((a,b)=>
      growthScore(b,minSamples)-growthScore(a,minSamples) ||
      Number(a.minutesRemaining)-Number(b.minutesRemaining)
    );
  return eligible[0]||null;
}

export function growthStakeUsd(input:{
  currentBankrollUsd:number;
  availableCashUsd:number;
  maxStakeUsd:number;
  maxFraction:number;
}) {
  const bankroll=Number.isFinite(input.currentBankrollUsd)?Math.max(0,input.currentBankrollUsd):0;
  const cash=Number.isFinite(input.availableCashUsd)?Math.max(0,input.availableCashUsd):0;
  const maxStake=Number.isFinite(input.maxStakeUsd)?Math.max(0,input.maxStakeUsd):0;
  const fraction=Number.isFinite(input.maxFraction)?Math.max(0,Math.min(1,input.maxFraction)):0;
  return Math.round(Math.min(bankroll*fraction,cash,maxStake)*10000)/10000;
}
