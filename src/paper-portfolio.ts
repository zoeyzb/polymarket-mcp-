export interface PaperPortfolioStateInput {
  startingBankrollUsd: number;
  realizedNetPnlUsd: number;
  openExposureUsd: number;
}

export function computePaperPortfolioState(input: PaperPortfolioStateInput) {
  const starting = Number.isFinite(input.startingBankrollUsd) ? Math.max(0, input.startingBankrollUsd) : 0;
  const realized = Number.isFinite(input.realizedNetPnlUsd) ? input.realizedNetPnlUsd : 0;
  const exposure = Number.isFinite(input.openExposureUsd) ? Math.max(0, input.openExposureUsd) : 0;
  const current = Math.max(0, starting + realized);
  const cash = Math.max(0, current - exposure);
  const round = (value:number) => Math.round(value * 10000) / 10000;
  return {
    startingBankrollUsd: round(starting),
    currentBankrollUsd: round(current),
    openExposureUsd: round(exposure),
    availableCashUsd: round(cash),
    returnPct: starting > 0 ? round(((current - starting) / starting) * 100) : 0
  };
}
