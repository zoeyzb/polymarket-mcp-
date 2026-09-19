export interface OpportunitySnapshot {
  at: string;
  totalActiveMarkets: number;
  totalInWindow: number;
  scanDurationMs: number | null;
  candidateCount: number;
  executableCount: number;
  topOpportunityScore: number | null;
}

const MAX_SNAPSHOTS = Math.max(20, Number(process.env.MAX_SNAPSHOTS || 500));
const snapshots: OpportunitySnapshot[] = [];

export function recordSnapshot(snapshot: OpportunitySnapshot) {
  snapshots.push(snapshot);
  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
  }
}

export function getSnapshots(limit = 100) {
  return snapshots.slice(-Math.max(1, Math.min(MAX_SNAPSHOTS, limit)));
}

export function getSnapshotHealth() {
  const latest = snapshots.at(-1) ?? null;
  const previous = snapshots.at(-2) ?? null;
  return {
    stored: snapshots.length,
    latest,
    delta: latest && previous ? {
      activeMarkets: latest.totalActiveMarkets - previous.totalActiveMarkets,
      inWindow: latest.totalInWindow - previous.totalInWindow,
      executable: latest.executableCount - previous.executableCount,
      topOpportunityScore:
        (latest.topOpportunityScore ?? 0) - (previous.topOpportunityScore ?? 0)
    } : null
  };
}
