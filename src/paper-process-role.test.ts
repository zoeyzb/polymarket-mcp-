import { describe, expect, it } from "vitest";
import { serviceOwnsEphemeralPaperLedger } from "./paper-process-role.js";

describe("paper process ownership",()=>{
  it("assigns the ephemeral ledger to scanner and all-in-one roles",()=>{
    expect(serviceOwnsEphemeralPaperLedger("scanner")).toBe(true);
    expect(serviceOwnsEphemeralPaperLedger("all")).toBe(true);
  });

  it("does not let history settle scanner-local memory",()=>{
    expect(serviceOwnsEphemeralPaperLedger("history")).toBe(false);
    expect(serviceOwnsEphemeralPaperLedger("streams")).toBe(false);
    expect(serviceOwnsEphemeralPaperLedger("maintenance")).toBe(false);
    expect(serviceOwnsEphemeralPaperLedger("api")).toBe(false);
  });
});
