import { describe, expect, it } from "vitest";
import { collectRealtimeTargetTokens } from "./realtime-targets.js";

const c=(id:string,tokens:string[])=>({conditionId:id,tokenIds:tokens}) as any;

describe("collectRealtimeTargetTokens",()=>{
  it("prioritizes urgent then structural then developing within the cap",()=>{
    const result=collectRealtimeTargetTokens({
      urgent:[c("u1",["u1a","u1b"]),c("u2",["u2a","u2b"])],
      structuralBinary:[c("s1",["s1a","s1b"])],
      structuralBaskets:[{yesTokenIds:["b1","b2"]}] as any[],
      developing:[c("d1",["d1a","d1b"])]
    },6);
    expect(result).toEqual(["u1a","u1b","u2a","u2b","s1a","s1b"]);
  });

  it("deduplicates tokens without wasting the cap",()=>{
    const result=collectRealtimeTargetTokens({
      urgent:[c("u1",["a","b"]),c("u2",["a","c"])],
      structuralBinary:[c("s1",["d"])],
      structuralBaskets:[],
      developing:[]
    },4);
    expect(result).toEqual(["a","b","c","d"]);
  });

  it("uses developing markets after urgent and structural capacity remains",()=>{
    const result=collectRealtimeTargetTokens({
      urgent:[c("u1",["a"])],
      structuralBinary:[],
      structuralBaskets:[],
      developing:[c("d1",["b","c"])]
    },4);
    expect(result).toEqual(["a","b","c"]);
  });
});
