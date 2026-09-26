export type ResearchConfidenceBand = "ultra_high" | "high" | "exploratory";

export function classifyResearchConfidenceBand(price:number):ResearchConfidenceBand|null {
  if (!Number.isFinite(price)) return null;
  if (price >= 0.9 && price <= 0.985) return "ultra_high";
  if (price >= 0.8 && price < 0.9) return "high";
  if (price >= 0.6 && price < 0.8) return "exploratory";
  return null;
}
