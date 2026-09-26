export interface ChampionCandidate {
  id: string;
  domain: string;
  family: string;
  entryPrice: number;
  liquidityUsd: number;
  minutesRemaining: number;
}

export function chooseChampionCandidate(candidates: ChampionCandidate[]): ChampionCandidate | null {
  const eligible=candidates
    .filter(candidate=>
      Number.isFinite(candidate.entryPrice) &&
      candidate.entryPrice>=0.8 &&
      candidate.entryPrice<=0.97 &&
      Number(candidate.liquidityUsd||0)>0
    )
    .sort((a,b)=>{
      const sportsDelta=Number(b.domain==="sports")-Number(a.domain==="sports");
      if (sportsDelta) return sportsDelta;
      const growthScore=(candidate:ChampionCandidate) =>
        Math.pow(Number(candidate.entryPrice),10) *
        Math.max(0,(1/Number(candidate.entryPrice))-1);
      const growthDelta=growthScore(b)-growthScore(a);
      if (growthDelta) return growthDelta;
      const confidenceDelta=Number(b.entryPrice)-Number(a.entryPrice);
      if (confidenceDelta) return confidenceDelta;
      const timeDelta=Number(a.minutesRemaining||0)-Number(b.minutesRemaining||0);
      if (timeDelta) return timeDelta;
      return Number(b.liquidityUsd||0)-Number(a.liquidityUsd||0);
    });
  return eligible[0] || null;
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
