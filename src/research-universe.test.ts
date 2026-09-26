import { describe, expect, it } from "vitest";
import { buildResearchCandidateUniverse } from "./research-universe.js";

function c(id:string, category:string, minutes:number, liquidity=1000, outcomes=["Yes","No"]) {
  return {
    id, conditionId:id, slug:id, question:id, primaryCategory:category,
    minutesRemaining:minutes, liquidityUsd:liquidity, outcomes,
    tokenIds:outcomes.map((_,i)=>id+"-"+i),
    displayedOutcomePrices:outcomes.map((_,i)=>i===0?0.8:0.2)
  } as any;
}

describe("buildResearchCandidateUniverse", () => {
  it("pulls candidates from 2h, 6h, 24h and structural lanes without duplicates", () => {
    const a=c("sports-urgent","sports",50);
    const duplicate={...a};
    const b=c("sports-6h","sports",240);
    const d=c("crypto-24h","crypto",900);
    const e=c("structural","sports",2000);
    const result=buildResearchCandidateUniverse({
      lanes:{
        urgent2h:{candidates:[a]},
        developing6h:{candidates:[duplicate,b]},
        broader24h:{candidates:[a,b,d]}
      },
      structuralUniverse:{binary:[e]}
    } as any);
    expect(result.map(x=>x.conditionId)).toEqual(["sports-urgent","sports-6h","structural","crypto-24h"]);
  });

  it("prioritizes sports but still retains other non-political domains", () => {
    const result=buildResearchCandidateUniverse({
      lanes:{
        urgent2h:{candidates:[]},
        developing6h:{candidates:[]},
        broader24h:{candidates:[
          c("crypto","crypto",60,10000),
          c("sports","sports",300,100)
        ]}
      },
      structuralUniverse:{binary:[]}
    } as any);
    expect(result.map(x=>x.conditionId)).toEqual(["sports","crypto"]);
  });

  it("retains multi-outcome sports markets for shadow research", () => {
    const score=c("score-band","sports",300,1000,["0-1","2-3","4-5","6+"]);
    const result=buildResearchCandidateUniverse({
      lanes:{urgent2h:{candidates:[]},developing6h:{candidates:[]},broader24h:{candidates:[score]}},
      structuralUniverse:{binary:[]}
    } as any);
    expect(result[0]?.outcomes).toHaveLength(4);
  });
});
