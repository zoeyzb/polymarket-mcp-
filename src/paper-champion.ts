export interface ChampionCandidate {
  id: string;
  domain: string;
  family: string;
  entryPrice: number;
  liquidityUsd: number;
  minutesRemaining: number;
  empiricalResolvedTrades?: number;
  empiricalWinRatePct?: number | null;
  empiricalRoiPct?: number | null;
}

export interface ChampionSelectionOptions {
  minEmpiricalSamples?: number;
  minEmpiricalWinRatePct?: number;
  maxPicks?: number;
  maxPerFamily?: number;
}

function eligibleChampionCandidates(
  candidates: ChampionCandidate[],
  options: ChampionSelectionOptions = {}
) {
  const minSamples=Math.max(1,Number(options.minEmpiricalSamples ?? 20));
  const minWinRate=Math.max(50,Math.min(100,Number(options.minEmpiricalWinRatePct ?? 95)));

  return candidates
    .filter(candidate=>{
      if (
        !Number.isFinite(candidate.entryPrice) ||
        candidate.entryPrice<0.8 ||
        candidate.entryPrice>0.985 ||
        Number(candidate.liquidityUsd||0)<=0
      ) return false;

      const samples=Math.max(0,Number(candidate.empiricalResolvedTrades||0));
      if (samples>=minSamples) {
        const winRate=Number(candidate.empiricalWinRatePct);
        const roi=Number(candidate.empiricalRoiPct);
        if (!Number.isFinite(winRate) || winRate<minWinRate) return false;
        if (Number.isFinite(roi) && roi<0) return false;
      }
      return true;
    })
    .sort((a,b)=>{
      const sportsDelta=Number(b.domain==="sports")-Number(a.domain==="sports");
      if (sportsDelta) return sportsDelta;

      const aSamples=Math.max(0,Number(a.empiricalResolvedTrades||0));
      const bSamples=Math.max(0,Number(b.empiricalResolvedTrades||0));
      const aProven=aSamples>=minSamples;
      const bProven=bSamples>=minSamples;
      const provenDelta=Number(bProven)-Number(aProven);
      if (provenDelta) return provenDelta;

      if (aProven && bProven) {
        const winDelta=Number(b.empiricalWinRatePct||0)-Number(a.empiricalWinRatePct||0);
        if (winDelta) return winDelta;
        const roiDelta=Number(b.empiricalRoiPct||0)-Number(a.empiricalRoiPct||0);
        if (roiDelta) return roiDelta;
        const sampleDelta=bSamples-aSamples;
        if (sampleDelta) return sampleDelta;
      }

      const confidenceDelta=Number(b.entryPrice)-Number(a.entryPrice);
      if (confidenceDelta) return confidenceDelta;

      const timeDelta=Number(a.minutesRemaining||0)-Number(b.minutesRemaining||0);
      if (timeDelta) return timeDelta;

      return Number(b.liquidityUsd||0)-Number(a.liquidityUsd||0);
    });
}

export function chooseChampionPortfolio(
  candidates: ChampionCandidate[],
  options: ChampionSelectionOptions = {}
): ChampionCandidate[] {
  const maxPicks=Math.max(1,Math.min(20,Number(options.maxPicks ?? 4)));
  const maxPerFamily=Math.max(1,Math.min(maxPicks,Number(options.maxPerFamily ?? 2)));
  const selected:ChampionCandidate[]=[];
  const familyCounts=new Map<string,number>();
  const seenIds=new Set<string>();

  for (const candidate of eligibleChampionCandidates(candidates,options)) {
    if (selected.length>=maxPicks) break;
    if (seenIds.has(candidate.id)) continue;
    const count=familyCounts.get(candidate.family)||0;
    if (count>=maxPerFamily) continue;
    selected.push(candidate);
    seenIds.add(candidate.id);
    familyCounts.set(candidate.family,count+1);
  }
  return selected;
}

export function chooseChampionCandidate(
  candidates: ChampionCandidate[],
  options: ChampionSelectionOptions = {}
): ChampionCandidate | null {
  return chooseChampionPortfolio(candidates,{...options,maxPicks:1})[0] || null;
}

export function championStakeUsd(input:{
  currentBankrollUsd:number;
  availableCashUsd:number;
  maxStakeUsd:number;
}) {
  const bankroll=Number.isFinite(input.currentBankrollUsd) ? Math.max(0,input.currentBankrollUsd) : 0;
  const cash=Number.isFinite(input.availableCashUsd) ? Math.max(0,input.availableCashUsd) : 0;
  const maxStake=Number.isFinite(input.maxStakeUsd) ? Math.max(0,input.maxStakeUsd) : 0;
  return Math.round(Math.min(bankroll*0.1,cash,maxStake)*10000)/10000;
}
