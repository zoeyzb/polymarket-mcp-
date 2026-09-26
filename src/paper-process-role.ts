export type PaperServiceRole="all"|"api"|"scanner"|"streams"|"history"|"maintenance";

export function serviceOwnsEphemeralPaperLedger(role:PaperServiceRole){
  return role==="all" || role==="scanner";
}
