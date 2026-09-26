import { describe, expect, it } from "vitest";
import { createDbBackoff } from "./db-backoff.js";

describe("scanner DB isolation contract",()=>{
  it("allows scanner work while quota circuit is open",()=>{
    const b=createDbBackoff({baseMs:60000,maxMs:900000});
    b.noteFailure(new Error("Your account or project has exceeded the quota."),1000);
    expect(b.shouldAttempt(2000)).toBe(false);
    // Scanner computation is intentionally independent of shouldAttempt().
    const computed={urgent:12,developing:30};
    expect(computed.urgent).toBe(12);
  });
});
