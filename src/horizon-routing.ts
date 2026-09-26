export type StrategyHorizon = "tMinus15m"|"tMinus30m"|"tMinus60m"|"tMinus120m";

export interface HorizonPolicyLike {
  enabled?: boolean;
  deployable?: boolean;
}

export interface HorizonRoute {
  horizon: StrategyHorizon;
  targetMinutes: number;
  distanceMinutes: number;
}

const HORIZON_MINUTES: Record<StrategyHorizon,number> = {
  tMinus15m:15,
  tMinus30m:30,
  tMinus60m:60,
  tMinus120m:120
};

export function routeCandidateToValidatedHorizon(
  minutesRemaining: number,
  policies: Partial<Record<StrategyHorizon,HorizonPolicyLike>>,
  toleranceMinutes = 10
): HorizonRoute | null {
  const minutes=Number(minutesRemaining);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const tolerance=Math.max(0,Number(toleranceMinutes||0));

  const routes=(Object.entries(HORIZON_MINUTES) as Array<[StrategyHorizon,number]>)
    .filter(([horizon]) => policies[horizon]?.enabled === true && policies[horizon]?.deployable === true)
    .map(([horizon,targetMinutes])=>({
      horizon,
      targetMinutes,
      distanceMinutes:Math.abs(minutes-targetMinutes)
    }))
    .filter(route=>route.distanceMinutes<=tolerance)
    .sort((a,b)=>a.distanceMinutes-b.distanceMinutes || a.targetMinutes-b.targetMinutes);

  return routes[0] || null;
}

export function horizonMinutes(horizon: StrategyHorizon) {
  return HORIZON_MINUTES[horizon];
}

export const STRATEGY_HORIZONS = Object.keys(HORIZON_MINUTES) as StrategyHorizon[];
