// verify.test.ts — pure parsing + error classification for the Bot Framework
// token verifier (ADR-0060). The verifier is the security boundary of the bot
// endpoint; these unit-test the two pure pieces directly (the live JWKS path is
// integration-tested).

import { describe, it, expect } from "bun:test";
import { bearer, classifyJoseError } from "../verify.js";

describe("bearer", () => {
  it("returns null for a missing or non-Bearer header", () => {
    expect(bearer(undefined)).toBe(null);
    expect(bearer("")).toBe(null);
    expect(bearer("Token abc")).toBe(null);
    expect(bearer("Basic abc")).toBe(null);
  });

  it("extracts the token, case-insensitively, trimming surrounding whitespace", () => {
    expect(bearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearer("bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearer("  Bearer abc.def.ghi  ")).toBe("abc.def.ghi");
  });
});

describe("classifyJoseError", () => {
  it("classifies JWKS timeout / network faults as unavailable (→ 503)", () => {
    expect(classifyJoseError({ code: "ERR_JWKS_TIMEOUT" })).toBe("unavailable");
    expect(classifyJoseError({ name: "JWKSTimeout", message: "timed out" })).toBe("unavailable");
    expect(classifyJoseError(new TypeError("fetch failed"))).toBe("unavailable");
    expect(classifyJoseError(new Error("getaddrinfo ENOTFOUND login.botframework.com"))).toBe("unavailable");
    expect(classifyJoseError(new Error("connect ECONNREFUSED"))).toBe("unavailable");
  });

  it("classifies signature / claim / structural faults as invalid (→ 401, fail closed)", () => {
    expect(classifyJoseError({ code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", message: "bad sig" })).toBe("invalid");
    expect(classifyJoseError({ code: "ERR_JWT_EXPIRED", message: "exp" })).toBe("invalid");
    expect(classifyJoseError({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED", message: "aud" })).toBe("invalid");
    expect(classifyJoseError(new Error("unexpected token type"))).toBe("invalid");
    expect(classifyJoseError("opaque")).toBe("invalid");
  });
});
