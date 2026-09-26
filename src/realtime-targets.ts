import type { ScanCandidate } from "./types.js";

export interface RealtimeTargetSource {
  urgent:ScanCandidate[];
  structuralBinary:ScanCandidate[];
  structuralBaskets:Array<{yesTokenIds:string[]}>;
  developing:ScanCandidate[];
}

export function collectRealtimeTargetTokens(
  source:RealtimeTargetSource,
  maxTokens:number
){
  const limit=Math.max(1,Math.floor(maxTokens));
  const tokens=new Set<string>();

  const addCandidateTokens=(candidates:ScanCandidate[],cap:number)=>{
    for(const candidate of candidates){
      for(const tokenId of candidate.tokenIds || []){
        if(tokens.size>=cap) return;
        if(tokenId) tokens.add(tokenId);
      }
    }
  };

  const urgentBudget=Math.min(limit,Math.max(1,Math.floor(limit*0.75)));
  addCandidateTokens(source.urgent,urgentBudget);
  addCandidateTokens(source.structuralBinary,limit);

  for(const basket of source.structuralBaskets){
    for(const tokenId of basket.yesTokenIds || []){
      if(tokens.size>=limit) break;
      if(tokenId) tokens.add(tokenId);
    }
    if(tokens.size>=limit) break;
  }

  addCandidateTokens(source.developing,limit);
  return [...tokens];
}
