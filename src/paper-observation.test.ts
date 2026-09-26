import { describe, expect, it } from "vitest";
import { selectObservationCandidates } from "./paper-observation.js";

const c=(id:string,family:string,price:number,minutes:number,liquidity:number)=>({
  id,conditionId:id,slug:id,question:id,primaryCategory:"sports",
  outcomes:["Yes","No"],tokenIds:[id+"-y",id+"-n"],
  displayedOutcomePrices:[price,1-price],minutesRemaining:minutes,liquidityUsd:liquidity,
  sportsStructure:{kind:family==="sports_total"?"game_total":family==="sports_spread"?"spread":"threshold",scope:"full_game"}
}) as any;

describe("sports observation ledger selection", () => {
  it("keeps diverse sports families instead of only the highest-price markets", () => {
    const rows=selectObservationCandidates([
      c("a","sports_total",0.93,60,1000),
      c("b","sports_spread",0.89,90,1000),
      c("c","sports_threshold",0.86,120,1000)
    ],{limit:10,perFamilyLimit:10});
    expect(rows.map(r=>r.family)).toEqual(["sports_total","sports_spread","sports_threshold"]);
  });

  it("round-robins families when one urgent family dominates the input", () => {
    const rows=selectObservationCandidates([
      c("total-a","sports_total",0.93,1,1000),
      c("total-b","sports_total",0.92,2,1000),
      c("total-c","sports_total",0.91,3,1000),
      c("spread-a","sports_spread",0.9,90,1000),
      c("spread-b","sports_spread",0.89,91,1000)
    ],{limit:4,perFamilyLimit:10});
    expect(rows.map(r=>r.family)).toEqual([
      "sports_total","sports_spread","sports_total","sports_spread"
    ]);
  });

  it("deduplicates condition and token and respects per-family caps", () => {
    const a=c("a","sports_total",0.9,60,1000);
    const duplicate={...a};
    const b=c("b","sports_total",0.88,70,1000);
    const rows=selectObservationCandidates([a,duplicate,b],{limit:10,perFamilyLimit:1});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.candidate.conditionId).toBe("a");
  });

  it("skips already-observed market tokens so fresh evidence can fill the batch", () => {
    const rows=selectObservationCandidates([
      c("old","sports_total",0.9,10,5000),
      c("fresh","sports_total",0.88,20,4000)
    ],{
      limit:10,
      perFamilyLimit:10,
      excludedKeys:new Set(["old:old-y"])
    });
    expect(rows.map(r=>r.candidate.conditionId)).toEqual(["fresh"]);
  });

  it("rejects illiquid and out-of-band sports candidates", () => {
    const rows=selectObservationCandidates([
      c("lowliq","sports_total",0.9,60,20),
      c("lowprice","sports_total",0.51,60,1000),
      c("good","sports_total",0.8,60,1000)
    ],{limit:10,perFamilyLimit:10,minLiquidityUsd:250,minPrice:0.6,maxPrice:0.99});
    expect(rows.map(r=>r.candidate.conditionId)).toEqual(["good"]);
  });
});
