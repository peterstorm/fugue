/**
 * Pure routing decision tests (FR-004, FR-008, FR-040/041).
 *
 * routeRequest is a total, fail-closed pure function — no I/O — so these are
 * plain data-in/decision-out unit + property tests.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { routeRequest, workerSocketForTenant } from "../../supervisor/routing.js";
import type { AdmissionDecision, WorkerPresence } from "../../supervisor/routing.js";
import { markTenant, tenantId } from "../../domain/tenant.js";
import type { Tenant } from "../../domain/tenant.js";

const makeTenant = (id: string, team = `${id}-team`): Tenant => {
  const r = tenantId(id);
  if (!r.ok) throw new Error(`bad test tenant id ${id}`);
  return markTenant(r.value, team);
};

const live = (socketPath: string): WorkerPresence => ({ kind: "live", socketPath });
const down: WorkerPresence = { kind: "unavailable" };

describe("routeRequest — admitted + live → route to OWN socket", () => {
  it("routes to exactly the live worker's socket", () => {
    const tenant = makeTenant("acme");
    const sock = "/run/fugue/acme.sock";
    const d = routeRequest(tenant, { kind: "admitted" }, live(sock));
    expect(d.kind).toBe("route");
    if (d.kind === "route") {
      expect(d.socketPath).toBe(sock);
      expect(d.tenant).toBe(tenant);
    }
  });
});

describe("routeRequest — fail-closed refusals", () => {
  it("unknown admission → tenant-unknown (404, non-leaking, no id)", () => {
    const d = routeRequest(makeTenant("acme"), { kind: "unknown" }, live("/run/fugue/acme.sock"));
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.error.kind).toBe("tenant-unknown");
      // No tenant id is carried — the type forbids it.
      expect(JSON.stringify(d.error)).not.toContain("acme");
    }
  });

  it("over-quota → tenant-over-quota (429) naming ONLY the caller's own tenant", () => {
    const tenant = makeTenant("acme");
    const d = routeRequest(tenant, { kind: "over-quota", retryAfterSeconds: 7 }, live("/run/fugue/acme.sock"));
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse" && d.error.kind === "tenant-over-quota") {
      expect(d.error.tenant).toBe(tenant.id);
      expect(d.error.retryAfterSeconds).toBe(7);
    } else {
      throw new Error("expected tenant-over-quota");
    }
  });

  it("admitted but worker unavailable → worker-unavailable (503, this tenant)", () => {
    const tenant = makeTenant("acme");
    const d = routeRequest(tenant, { kind: "admitted" }, down);
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse" && d.error.kind === "worker-unavailable") {
      expect(d.error.tenant).toBe(tenant.id);
    } else {
      throw new Error("expected worker-unavailable");
    }
  });

  it("admission unavailable → worker-unavailable even with a live worker", () => {
    const tenant = makeTenant("acme");
    const d = routeRequest(tenant, { kind: "unavailable" }, live("/run/fugue/acme.sock"));
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.error.kind).toBe("worker-unavailable");
  });
});

describe("workerSocketForTenant", () => {
  it("derives <udsDir>/<id>.sock from the branded tenant", () => {
    expect(workerSocketForTenant("/run/fugue", makeTenant("acme"))).toBe("/run/fugue/acme.sock");
    expect(workerSocketForTenant("/run/fugue/", makeTenant("b2"))).toBe("/run/fugue/b2.sock");
  });
});

describe("routeRequest — property: never routes unless admitted AND live", () => {
  const idArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);
  const admissionArb: fc.Arbitrary<AdmissionDecision> = fc.oneof(
    fc.constant<AdmissionDecision>({ kind: "admitted" }),
    fc.constant<AdmissionDecision>({ kind: "unknown" }),
    fc.constant<AdmissionDecision>({ kind: "unavailable" }),
    fc.integer({ min: 0, max: 600 }).map((s): AdmissionDecision => ({ kind: "over-quota", retryAfterSeconds: s })),
  );
  const presenceArb: fc.Arbitrary<WorkerPresence> = fc.oneof(
    idArb.map((id): WorkerPresence => ({ kind: "live", socketPath: `/run/fugue/${id}.sock` })),
    fc.constant<WorkerPresence>({ kind: "unavailable" }),
  );

  it("a route decision implies admitted + live, and its socket equals the live presence's", () => {
    fc.assert(
      fc.property(idArb, admissionArb, presenceArb, (id, admission, presence) => {
        const tenant = makeTenant(id);
        const d = routeRequest(tenant, admission, presence);
        if (d.kind === "route") {
          expect(admission.kind).toBe("admitted");
          expect(presence.kind).toBe("live");
          if (presence.kind === "live") expect(d.socketPath).toBe(presence.socketPath);
        } else {
          // every non-route is one of the three non-leaking host errors
          expect(["tenant-unknown", "tenant-over-quota", "worker-unavailable"]).toContain(d.error.kind);
        }
      }),
    );
  });

  it("an unknown admission ALWAYS refuses tenant-unknown regardless of worker presence", () => {
    fc.assert(
      fc.property(idArb, presenceArb, (id, presence) => {
        const d = routeRequest(makeTenant(id), { kind: "unknown" }, presence);
        expect(d.kind).toBe("refuse");
        if (d.kind === "refuse") expect(d.error.kind).toBe("tenant-unknown");
      }),
    );
  });
});
