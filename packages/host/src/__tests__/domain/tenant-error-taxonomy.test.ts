/**
 * Tenant error-taxonomy tests (AD-10, SC-012, FR-040, FR-041).
 *
 * Verifies the three supervisor-boundary HostError variants classify correctly:
 *   - tenant-unknown   → 404, no breaker trip, leaks nothing
 *   - tenant-over-quota→ 429 + Retry-After, no breaker trip, names only own tenant
 *   - worker-unavailable→ 503 + Retry-After, DOES count, names only own tenant
 *
 * And the cross-cutting guarantee (SC-012/FR-041): no message or detail of one
 * tenant's error ever references another tenant.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import {
  httpStatusFor,
  formatHostError,
  retryAfterSeconds,
  retryAfterSecondsFor,
  tenantUnknown,
  tenantOverQuota,
  workerUnavailable,
  type HostError,
} from "../../domain/host-error.js";
import {
  classifyHostError,
  isSupervisorHostError,
} from "../../domain/framework-error-http.js";
import type { TenantId } from "../../domain/tenant.js";

const tid = (s: string) => s as unknown as TenantId;

describe("tenant error smart constructors", () => {
  it("tenantUnknown carries no discriminating field (non-leakage, FR-040)", () => {
    expect(tenantUnknown()).toEqual({ kind: "tenant-unknown" });
  });

  it("tenantOverQuota carries its own tenant + retry-after", () => {
    expect(tenantOverQuota(tid("acme"), 30)).toEqual({
      kind: "tenant-over-quota",
      tenant: "acme",
      retryAfterSeconds: 30,
    });
  });

  it("Retry-After accepts exactly the non-negative safe-integer domain", () => {
    fc.assert(
      fc.property(fc.double(), (value) => {
        const accepted = Number.isSafeInteger(value) && value >= 0;
        if (accepted) {
          expect(retryAfterSeconds(value)).toBe(value);
          expect(tenantOverQuota(tid("acme"), value).retryAfterSeconds).toBe(value);
        } else {
          expect(() => retryAfterSeconds(value)).toThrow(
            "retryAfterSeconds must be a non-negative safe integer",
          );
          expect(() => tenantOverQuota(tid("acme"), value)).toThrow();
        }
      }),
    );
  });

  it("workerUnavailable carries its own tenant", () => {
    expect(workerUnavailable(tid("acme"))).toEqual({
      kind: "worker-unavailable",
      tenant: "acme",
    });
  });
});

describe("httpStatusFor (tenant variants)", () => {
  it("tenant-unknown → 404", () => {
    expect(httpStatusFor(tenantUnknown())).toBe(404);
  });
  it("tenant-over-quota → 429", () => {
    expect(httpStatusFor(tenantOverQuota(tid("acme"), 5))).toBe(429);
  });
  it("worker-unavailable → 503", () => {
    expect(httpStatusFor(workerUnavailable(tid("acme")))).toBe(503);
  });
});

describe("retryAfterSecondsFor", () => {
  it("tenant-over-quota advertises its own per-tenant backoff", () => {
    expect(retryAfterSecondsFor(tenantOverQuota(tid("acme"), 42))).toBe(42);
  });
  it("coarse concurrency limits keep the fixed 5s", () => {
    expect(retryAfterSecondsFor({ kind: "global-concurrency-exceeded" })).toBe(5);
    expect(
      retryAfterSecondsFor({ kind: "dag-concurrency-exceeded", dagId: "d" as never }),
    ).toBe(5);
  });
  it("tenant-unknown advertises no Retry-After here", () => {
    expect(retryAfterSecondsFor(tenantUnknown())).toBeUndefined();
  });
  it("worker-unavailable advertises a fixed 5s — single-sourced for BOTH the middleware and classifier", () => {
    expect(retryAfterSecondsFor(workerUnavailable(tid("acme")))).toBe(5);
  });
});

describe("formatHostError (non-leakage, FR-040/FR-041)", () => {
  it("tenant-unknown message names no tenant and is tenant-agnostic", () => {
    const msg = formatHostError(tenantUnknown());
    expect(msg).toBe("tenant not found");
  });

  it("tenant-over-quota / worker-unavailable name ONLY the caller's own tenant", () => {
    expect(formatHostError(tenantOverQuota(tid("acme"), 12))).toContain("acme");
    expect(formatHostError(workerUnavailable(tid("acme")))).toContain("acme");
  });

  it("property: a tenant error's message never mentions any OTHER tenant", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,8}$/),
        fc.stringMatching(/^[a-z]{3,8}$/),
        fc.integer({ min: 1, max: 3600 }),
        (own, other, retry) => {
          fc.pre(own !== other);
          // A tenant id is ONLY ever emitted inside single quotes in these
          // message templates (e.g. `tenant '<id>' is over quota`,
          // `worker for tenant '<id>' is unavailable`). "Names a tenant" is
          // therefore precisely "contains the quoted-id form `'<id>'`". We must
          // assert against the QUOTED form, not the bare substring: the raw
          // substring check produces FALSE failures when a generated id happens
          // to be an English fragment in a template (e.g. other="una" is a
          // substring of "unavailable", other="over" of "over quota") even
          // though no other tenant id is leaked.
          const quoted = (t: string) => `'${t}'`;
          const errs: HostError[] = [
            tenantOverQuota(tid(own), retry),
            workerUnavailable(tid(own)),
          ];
          for (const e of errs) {
            const msg = formatHostError(e);
            // DOES name the caller's own tenant (in quoted form).
            expect(msg).toContain(quoted(own));
            // NEVER names any other tenant (in quoted form).
            expect(msg).not.toContain(quoted(other));
          }
          // tenant-unknown names NO tenant at all — neither own nor other,
          // in any form. Its message is a fixed tenant-agnostic string.
          const unknownMsg = formatHostError(tenantUnknown());
          expect(unknownMsg).not.toContain(quoted(own));
          expect(unknownMsg).not.toContain(quoted(other));
        },
      ),
    );
  });
});

describe("classifyHostError (breaker classification, AD-10)", () => {
  it("isSupervisorHostError narrows the three tenant kinds", () => {
    expect(isSupervisorHostError(tenantUnknown())).toBe(true);
    expect(isSupervisorHostError(tenantOverQuota(tid("a"), 1))).toBe(true);
    expect(isSupervisorHostError(workerUnavailable(tid("a")))).toBe(true);
    expect(isSupervisorHostError({ kind: "redis-unavailable", operation: "GET" })).toBe(false);
  });

  it("tenant-unknown: 404, NOT a circuit failure (settled rejection)", () => {
    const c = classifyHostError(tenantUnknown());
    expect(c.status).toBe(404);
    expect(c.countsAsCircuitFailure).toBe(false);
  });

  it("tenant-over-quota: 429 + Retry-After, NOT a circuit failure (settled limit)", () => {
    const c = classifyHostError(tenantOverQuota(tid("acme"), 30));
    expect(c.status).toBe(429);
    expect(c.countsAsCircuitFailure).toBe(false);
    expect(c.retryAfterSeconds).toBe(30);
  });

  it("worker-unavailable: 503 + Retry-After, DOES count (transient infra)", () => {
    const c = classifyHostError(workerUnavailable(tid("acme")));
    expect(c.status).toBe(503);
    expect(c.countsAsCircuitFailure).toBe(true);
    expect(c.retryAfterSeconds).toBe(5);
  });

  it("worker-unavailable Retry-After is single-sourced: classifier === middleware backoff", () => {
    const e = workerUnavailable(tid("acme"));
    // The classifier's Retry-After and the value the live error-handler
    // middleware emits (via retryAfterSecondsFor) must be the SAME number —
    // no divergent hardcoded source.
    expect(classifyHostError(e).retryAfterSeconds).toBe(retryAfterSecondsFor(e));
  });

  it("property: a tenant's quota/unknown refusal NEVER trips a breaker", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{3,8}$/), fc.integer({ min: 1, max: 3600 }), (t, r) => {
        expect(classifyHostError(tenantUnknown()).countsAsCircuitFailure).toBe(false);
        expect(classifyHostError(tenantOverQuota(tid(t), r)).countsAsCircuitFailure).toBe(false);
      }),
    );
  });
});
