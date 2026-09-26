import type { ScanCandidate } from "./types.js";

type SnapshotLike = {
  lanes?: {
    urgent2h?: { candidates?: ScanCandidate[] };
    developing6h?: { candidates?: ScanCandidate[] };
    broader24h?: { candidates?: ScanCandidate[] };
  };
  structuralUniverse?: {
    binary?: ScanCandidate[];
  };
};

function candidateKey(candidate: ScanCandidate) {
  return String(
    candidate.conditionId ||
    candidate.id ||
    candidate.slug ||
    candidate.question
  );
}

function isSports(candidate: ScanCandidate) {
  const category=String(candidate.primaryCategory || "").toLowerCase();
  return Boolean(
    candidate.sportsStructure ||
    ["sports","nba","basketball","soccer","games_esports"].includes(category)
  );
}

export function buildResearchCandidateUniverse(snapshot: SnapshotLike): ScanCandidate[] {
  const orderedSources: ScanCandidate[][] = [
    snapshot.lanes?.urgent2h?.candidates || [],
    snapshot.lanes?.developing6h?.candidates || [],
    snapshot.lanes?.broader24h?.candidates || [],
    snapshot.structuralUniverse?.binary || []
  ];

  const deduped=new Map<string,ScanCandidate>();
  for (const source of orderedSources) {
    for (const candidate of source) {
      const key=candidateKey(candidate);
      if (!key || deduped.has(key)) continue;
      deduped.set(key,candidate);
    }
  }

  return [...deduped.values()].sort((a,b)=>{
    const sportsDelta=Number(isSports(b))-Number(isSports(a));
    if (sportsDelta) return sportsDelta;
    const minutesDelta=Number(a.minutesRemaining || 0)-Number(b.minutesRemaining || 0);
    if (minutesDelta) return minutesDelta;
    return Number(b.liquidityUsd || 0)-Number(a.liquidityUsd || 0);
  });
}
