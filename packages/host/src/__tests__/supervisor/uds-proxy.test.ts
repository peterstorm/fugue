/**
 * UDS proxy tests: stamps the canonical X-Fugue-Tenant header (cross-verified
 * with the CANONICAL `verifyTenantHeader` from `domain/tenant-header.ts`, NOT a
 * proxy-local verifier — the proxy no longer defines one), strips any
 * client-supplied tenant header (case-insensitively), preserves the worker's
 * status/headers/body (200 contract), and fails closed to worker-unavailable
 * (503) on a transport failure. The transport is a seam so no real socket is
 * needed for the unit paths; one end-to-end test uses a real Bun UDS server.
 *
 * The cross-verification is load-bearing: it proves the proxy's stamped value
 * verifies under the SAME function the T6 worker uses, so the supervisor and
 * worker cannot drift (the whole reason `uds-proxy` imports the canonical signer
 * instead of re-implementing HMAC).
 */

import { describe, it, expect } from "bun:test";
import {
  buildForwardRequest,
  buildProbeRequest,
  proxyToWorker,
  makeBunUdsTransport,
} from "../../supervisor/uds-proxy.js";
import type { UdsTransport } from "../../supervisor/uds-proxy.js";
// CANONICAL verifier — the worker side uses exactly this. The proxy stamps with
// the canonical signer; verifying here proves byte-for-byte agreement.
import { verifyTenantHeader, TENANT_HEADER_NAME } from "../../domain/tenant-header.js";
import { ok, err } from "@fuguejs/framework";
import { markTenant, tenantId } from "../../domain/tenant.js";
import type { Tenant } from "../../domain/tenant.js";

const KEY = "internal-platform-hmac-key-not-a-tenant-secret";

const makeTenant = (id: string, team = `${id}-team`): Tenant => {
  const r = tenantId(id);
  if (!r.ok) throw new Error(`bad id ${id}`);
  return markTenant(r.value, team);
};

describe("buildProbeRequest — UDS liveness probe (path + signed header)", () => {
  const tid = (id: string) => {
    const r = tenantId(id);
    if (!r.ok) throw new Error(`bad id ${id}`);
    return r.value;
  };

  it("GETs the worker's /health route (NOT /healthz — a wrong path 404s every live worker)", () => {
    const req = buildProbeRequest(KEY, tid("acme"));
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/health");
  });

  it("signs X-Fugue-Tenant so the worker's fail-closed verification passes (else 401 → worker reads as dead)", () => {
    const t = tid("acme");
    const req = buildProbeRequest(KEY, t);
    const header = req.headers.get(TENANT_HEADER_NAME) ?? undefined;
    // The SAME canonical verifier the worker runs in its Bun.serve wrapper.
    expect(verifyTenantHeader(KEY, t, header)).toEqual({ kind: "ok" });
  });

  it("omits the header when no HMAC key is configured (worker then skips verification)", () => {
    const req = buildProbeRequest(undefined, tid("acme"));
    expect(req.headers.get(TENANT_HEADER_NAME)).toBeNull();
  });
});

describe("buildForwardRequest — header signing + stripping", () => {
  it("strips a client-supplied X-Fugue-Tenant and sets a value that verifies under the CANONICAL verifier", () => {
    const tenant = makeTenant("acme");
    const inbound = new Request("http://host/runs/dag1", {
      method: "POST",
      headers: {
        [TENANT_HEADER_NAME]: "evil.deadbeef",
        Authorization: "Bearer fug_abc",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ x: 1 }),
    });
    const fwd = buildForwardRequest(inbound, tenant, KEY);
    // The forged header is replaced with a value the WORKER's canonical verifier
    // accepts as bound to acme — proving supervisor/worker agreement.
    expect(verifyTenantHeader(KEY, "acme", fwd.headers.get(TENANT_HEADER_NAME)!)).toEqual({ kind: "ok" });
    // A DIFFERENT tenant's worker rejects the same stamped header (tenant-mismatch).
    expect(verifyTenantHeader(KEY, "evil", fwd.headers.get(TENANT_HEADER_NAME)!)).toEqual({
      kind: "tenant-mismatch",
    });
    // Authorization is forwarded unchanged (the worker re-validates the bearer).
    expect(fwd.headers.get("Authorization")).toBe("Bearer fug_abc");
  });

  it("strips a client-supplied header sent under a DIFFERENT case (case-insensitive smuggling defense)", () => {
    const tenant = makeTenant("acme");
    const inbound = new Request("http://host/runs/dag1", {
      method: "GET",
      // lower-cased + odd-cased variants — Headers normalizes, delete must catch all.
      headers: { "x-fugue-tenant": "evil.deadbeef" },
    });
    const fwd = buildForwardRequest(inbound, tenant, KEY);
    // Exactly one header value remains, and it verifies as acme (not evil).
    expect(verifyTenantHeader(KEY, "acme", fwd.headers.get(TENANT_HEADER_NAME)!)).toEqual({ kind: "ok" });
  });

  it("adds NO tenant header when the HMAC key is unset, but STILL strips the client's", () => {
    const tenant = makeTenant("acme");
    const inbound = new Request("http://host/runs/dag1", {
      method: "GET",
      headers: { [TENANT_HEADER_NAME]: "evil.deadbeef" },
    });
    const fwd = buildForwardRequest(inbound, tenant, undefined);
    expect(fwd.headers.get(TENANT_HEADER_NAME)).toBeNull();
  });
});

describe("proxyToWorker — 200 contract preservation + fail-closed", () => {
  const tenant = makeTenant("acme");

  it("preserves the worker's status, headers, and body verbatim", async () => {
    const transport: UdsTransport = async (_sock, req) => {
      // assert the signed header reached the transport and verifies as acme
      const seen = req.headers.get(TENANT_HEADER_NAME);
      expect(seen).not.toBeNull();
      expect(verifyTenantHeader(KEY, "acme", seen!)).toEqual({ kind: "ok" });
      return ok(
        new Response(JSON.stringify({ runId: "r1" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Custom": "v" },
        }),
      );
    };
    const inbound = new Request("http://host/runs/dag1", { method: "POST", body: "{}" });
    const res = await proxyToWorker({ hmacKey: KEY, transport }, inbound, tenant, "/run/fugue/acme.sock");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe(200);
      expect(res.value.headers.get("X-Custom")).toBe("v");
      expect(await res.value.json()).toEqual({ runId: "r1" });
    }
  });

  it("preserves a non-200 worker status (e.g. 400) verbatim — does not rewrite it", async () => {
    const transport: UdsTransport = async () => ok(new Response("bad input", { status: 400 }));
    const inbound = new Request("http://host/runs/dag1", { method: "POST", body: "{}" });
    const res = await proxyToWorker({ hmacKey: KEY, transport }, inbound, tenant, "/run/fugue/acme.sock");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe(400);
  });

  it("succeeds with NO tenant header when the key is unset (still strips client's, 200 preserved)", async () => {
    const transport: UdsTransport = async (_sock, req) => {
      // No key configured → no stamped header, and the client's forged one is gone.
      expect(req.headers.get(TENANT_HEADER_NAME)).toBeNull();
      return ok(new Response(JSON.stringify({ runId: "r2" }), { status: 200 }));
    };
    const inbound = new Request("http://host/runs/dag1", {
      method: "POST",
      headers: { [TENANT_HEADER_NAME]: "evil.deadbeef" },
      body: "{}",
    });
    const res = await proxyToWorker({ hmacKey: undefined, transport }, inbound, tenant, "/run/fugue/acme.sock");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe(200);
  });

  it("fails closed to worker-unavailable (503) on a transport/connect failure", async () => {
    const transport: UdsTransport = async () => err({ reason: "ENOENT: no such socket" });
    const inbound = new Request("http://host/runs/dag1", { method: "GET" });
    const res = await proxyToWorker({ hmacKey: KEY, transport }, inbound, tenant, "/run/fugue/acme.sock");
    expect(res.ok).toBe(false);
    if (!res.ok && res.error.kind === "worker-unavailable") {
      expect(res.error.tenant).toBe(tenant.id);
    } else {
      throw new Error("expected worker-unavailable");
    }
  });
});

describe("proxyToWorker — real fetch-over-UDS round trip (Bun transport)", () => {
  it("proxies over a real Unix-domain socket, preserving the 200 contract and a canonically-verifiable header", async () => {
    const bunUdsTransport = makeBunUdsTransport(10_000);
    const tmpSock = `/tmp/fugue-test-${crypto.randomUUID()}.sock`;
    let seenHeader: string | null = null;
    const worker = Bun.serve({
      unix: tmpSock,
      fetch: (req) => {
        seenHeader = req.headers.get(TENANT_HEADER_NAME);
        return new Response(JSON.stringify({ ok: true, path: new URL(req.url).pathname }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const tenant = makeTenant("acme");
      const inbound = new Request("http://host/runs/dag1?q=1", { method: "POST", body: "{}" });
      const res = await proxyToWorker({ hmacKey: KEY, transport: bunUdsTransport }, inbound, tenant, tmpSock);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.status).toBe(200);
        expect(await res.value.json()).toEqual({ ok: true, path: "/runs/dag1" });
      }
      // the worker observed a signed tenant header that its CANONICAL verifier accepts
      expect(seenHeader).not.toBeNull();
      expect(verifyTenantHeader(KEY, "acme", seenHeader!)).toEqual({ kind: "ok" });
    } finally {
      worker.stop(true);
    }
  });
});
