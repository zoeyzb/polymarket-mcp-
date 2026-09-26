import { describe, expect, it } from "vitest";
import { routeCandidateToValidatedHorizon } from "./horizon-routing.js";

const policies = {
  tMinus15m:{enabled:true, deployable:true},
  tMinus30m:{enabled:true, deployable:true},
  tMinus60m:{enabled:true, deployable:true},
  tMinus120m:{enabled:true, deployable:true}
};

describe("validated horizon routing", () => {
  it("routes to the nearest validated horizon", () => {
    expect(routeCandidateToValidatedHorizon(28,policies,8)?.horizon).toBe("tMinus30m");
    expect(routeCandidateToValidatedHorizon(117,policies,8)?.horizon).toBe("tMinus120m");
  });

  it("uses deterministic shorter-horizon tie breaking", () => {
    expect(routeCandidateToValidatedHorizon(45,policies,20)?.horizon).toBe("tMinus30m");
  });

  it("rejects candidates outside tolerance", () => {
    expect(routeCandidateToValidatedHorizon(90,policies,10)).toBeNull();
  });

  it("does not fall back to an unvalidated horizon", () => {
    const restricted={...policies,tMinus30m:{enabled:false,deployable:false}};
    expect(routeCandidateToValidatedHorizon(30,restricted,8)).toBeNull();
  });
});
