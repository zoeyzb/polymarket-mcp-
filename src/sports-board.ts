import type { MultiHorizonScanResult, ScanCandidate } from "./types.js";

function candidateKey(candidate: ScanCandidate) {
  return candidate.conditionId || candidate.id || candidate.slug || candidate.question;
}

function marketView(candidate: ScanCandidate) {
  const structure = candidate.sportsStructure!;
  return {
    conditionId: candidate.conditionId,
    slug: candidate.slug,
    question: candidate.question,
    kind: structure.kind,
    scope: structure.scope,
    subject: structure.subject,
    stat: structure.stat,
    line: structure.line,
    thresholdComparator: structure.thresholdComparator,
    rangeMin: structure.rangeMin,
    rangeMax: structure.rangeMax,
    outcomes: candidate.outcomes,
    displayedOutcomePrices: candidate.displayedOutcomePrices,
    liquidityUsd: candidate.liquidityUsd,
    volume24hUsd: candidate.volume24hUsd,
    minutesRemaining: candidate.minutesRemaining,
    books: candidate.books?.map(book => ({
      outcome: book.outcome,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      midpoint: book.midpoint,
      spread: book.spread
    })) ?? null,
    flags: candidate.flags
  };
}

export function buildSportsBoard(
  snapshot: MultiHorizonScanResult | Record<string, any> | null
) {
  if (!snapshot) {
    return {
      generatedAt: null,
      games: [],
      totals: {},
      note: "No scanner snapshot available."
    };
  }

  const lanes = (snapshot as any).lanes || {};
  const allCandidates: ScanCandidate[] = [
    ...(lanes.urgent2h?.candidates || []),
    ...(lanes.developing6h?.candidates || []),
    ...(lanes.broader24h?.candidates || []),
    ...((snapshot as any).structuralUniverse?.binary || [])
  ];

  const deduped = new Map<string, ScanCandidate>();
  for (const candidate of allCandidates) {
    if (!candidate?.sportsStructure) continue;
    deduped.set(candidateKey(candidate), candidate);
  }

  const groups = new Map<string, {
    eventTitle: string;
    sport: string | null;
    liveState: ScanCandidate["sportsStructure"] extends infer _ ? any : never;
    markets: ScanCandidate[];
  }>();

  for (const candidate of deduped.values()) {
    const structure = candidate.sportsStructure!;
    const eventTitle = structure.eventTitle || candidate.question;
    const key = `${structure.sport || "SPORT"}::${eventTitle}`;
    const group = groups.get(key) || {
      eventTitle,
      sport: structure.sport,
      liveState: structure.liveState,
      markets: []
    };
    if (!group.liveState && structure.liveState) group.liveState = structure.liveState;
    group.markets.push(candidate);
    groups.set(key, group);
  }

  const games = [...groups.values()].map(group => {
    const byKind: Record<string, ReturnType<typeof marketView>[]> = {};
    for (const candidate of group.markets) {
      const kind = candidate.sportsStructure!.kind;
      (byKind[kind] ||= []).push(marketView(candidate));
    }

    for (const values of Object.values(byKind)) {
      values.sort((a, b) =>
        (a.line ?? 0) - (b.line ?? 0) ||
        b.liquidityUsd - a.liquidityUsd
      );
    }

    return {
      eventTitle: group.eventTitle,
      sport: group.sport,
      liveState: group.liveState,
      marketCount: group.markets.length,
      moneyline: byKind.moneyline || [],
      spreads: [...(byKind.spread || []), ...(byKind.period_spread || [])],
      totals: [...(byKind.game_total || []), ...(byKind.period_total || [])],
      teamTotals: byKind.team_total || [],
      playerProps: byKind.player_prop || [],
      exactScores: byKind.exact_score || [],
      scoreBands: byKind.score_band || [],
      thresholds: byKind.threshold || [],
      firstScorer: byKind.first_scorer || [],
      bothTeamsScore: byKind.both_teams_score || [],
      series: byKind.series || [],
      futures: byKind.futures || [],
      other: byKind.other_sports || []
    };
  });

  games.sort((a, b) => {
    const liveA = a.liveState?.live === true ? 1 : 0;
    const liveB = b.liveState?.live === true ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return a.eventTitle.localeCompare(b.eventTitle);
  });

  const totals: Record<string, number> = {
    games: games.length,
    markets: 0,
    moneyline: 0,
    spreads: 0,
    totals: 0,
    teamTotals: 0,
    playerProps: 0,
    scoreBands: 0,
    exactScores: 0
  };

  for (const game of games) {
    totals.markets += game.marketCount;
    totals.moneyline += game.moneyline.length;
    totals.spreads += game.spreads.length;
    totals.totals += game.totals.length;
    totals.teamTotals += game.teamTotals.length;
    totals.playerProps += game.playerProps.length;
    totals.scoreBands += game.scoreBands.length;
    totals.exactScores += game.exactScores.length;
  }

  return {
    generatedAt: (snapshot as any).generatedAt ?? null,
    ageSeconds: (snapshot as any).ageSeconds ?? null,
    totals,
    games
  };
}
