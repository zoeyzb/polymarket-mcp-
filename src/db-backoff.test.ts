import { describe, expect, it } from "vitest";
import { createDbBackoff } from "./db-backoff.js";

describe("db quota backoff",()=>{
  it("recognizes quota exhaustion",()=>{
    const b=createDbBackoff({baseMs:1000,maxMs:8000});
    expect(b.isQuotaError(new Error("Your account or project has exceeded the quota. Upgrade your plan to increase limits."))).toBe(true);
    expect(b.isQuotaError(new Error("socket timeout"))).toBe(false);
  });

  it("opens after quota failure and backs off exponentially",()=>{
    const b=createDbBackoff({baseMs:1000,maxMs:8000});
    const t=10000;
    expect(b.shouldAttempt(t)).toBe(true);
    b.noteFailure(new Error("exceeded the quota"),t);
    expect(b.shouldAttempt(t+999)).toBe(false);
    expect(b.shouldAttempt(t+1000)).toBe(true);
    b.noteFailure(new Error("exceeded the quota"),t+1000);
    expect(b.status(t+1000).delayMs).toBe(2000);
  });

  it("coalesces concurrent quota failures while the breaker is already open",()=>{
    const b=createDbBackoff({baseMs:1000,maxMs:8000});
    const first=b.noteFailure(new Error("quota exceeded"),1000);
    const concurrent=b.noteFailure(new Error("quota exceeded"),1001);
    expect(first.failures).toBe(1);
    expect(concurrent.coalesced).toBe(true);
    expect(concurrent.failures).toBe(1);
    expect(b.status(1001).delayMs).toBe(1000);
  });

  it("caps backoff",()=>{
    const b=createDbBackoff({baseMs:1000,maxMs:4000});
    let now=0;
    for(let i=0;i<10;i++){
      b.noteFailure(new Error("quota exceeded"),now);
      now=b.status(now).retryAtMs;
    }
    expect(b.status(now).delayMs).toBe(4000);
  });

  it("resets immediately after success",()=>{
    const b=createDbBackoff({baseMs:1000,maxMs:8000});
    b.noteFailure(new Error("quota exceeded"),1000);
    expect(b.status(1000).open).toBe(true);
    b.noteSuccess();
    expect(b.status(1001).open).toBe(false);
    expect(b.shouldAttempt(1001)).toBe(true);
  });

  it("does not open for ordinary transient errors",()=>{
    const b=createDbBackoff({baseMs:1000,maxMs:8000});
    b.noteFailure(new Error("ECONNRESET"),1000);
    expect(b.status(1000).open).toBe(false);
  });
});
