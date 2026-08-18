/**
 * UDS reverse proxy — forwards an inbound `Request` to the resolved tenant's
 * worker over its Unix-domain socket, attaching the SIGNED `X-Fugue-Tenant`
 * header, and streams the worker's `Response` back verbatim (the existing HTTP
 * 200 contract — status, headers, body — is preserved).
 *
 * SECURITY MODEL (FR-005, FR-007, AD-8):
 *   - The supervisor holds ZERO tenant secrets. The ONLY credential this module
 *     uses is the platform-internal `FUGUE_SUPERVISOR_HMAC_KEY` — an integrity
 *     key shared between the supervisor and every worker, NOT a tenant secret
 *     and NOT the per-tenant Redis-ACL credential. It is used solely to stamp
 *     the tenant-principal header so a worker can defensively verify the request
 *     came from the supervisor (the 0600 socket is the primary isolation; the
 *     header is the secondary check — see config.ts WORKER_UDS_DIR).
 *   - The signed header binds the request to EXACTLY the resolved tenant id. The
 *     value is `<tenantId>.<hmac>` where `hmac = hex(HMAC-SHA256(key, tenantId))`.
 *     This module does NOT define that algorithm — it IMPORTS the canonical
 *     `signTenantHeader` / `TENANT_HEADER_NAME` from `../domain/tenant-header.ts`,
 *     the single source of truth the T6 worker's `verifyTenantHeader` also imports.
 *     Re-implementing it here is exactly the drift hazard that module exists to
 *     prevent, so the supervisor and worker can never diverge byte-for-byte.
 *   - Any inbound `X-Fugue-Tenant` header the CLIENT may have sent is STRIPPED
 *     and replaced with the supervisor's freshly-signed value, so a client can
 *     never forge or smuggle a tenant principal to a worker (header-injection /
 *     request-smuggling defense — OWASP API1/API8).
 *   - The inbound `Authorization` header is forwarded UNCHANGED so the worker can
 *     run its own auth (the tenant principal travels in the signed header; the
 *     bearer is what the worker re-validates). No NEW secret is added beyond the
 *     internal HMAC stamp.
 *
 * FAIL-CLOSED (FR-041, AD-8): a socket connect/transport failure maps to
 * `worker-unavailable` (503) for THIS tenant only — a worker fault is contained
 * to its tenant and never surfaces as another tenant's error or a generic 500.
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { Tenant, TenantId } from "../domain/tenant.js";
import type { HostError } from "../domain/host-error.js";
import { workerUnavailable } from "../domain/host-error.js";
// CANONICAL contract — the SINGLE source of truth for how the tenant principal
// is named + signed. The worker side (`verifyTenantHeader`) imports from the
// SAME module, so supervisor and worker cannot drift. Do NOT re-implement here.
import { signTenantHeader, TENANT_HEADER_NAME } from "../domain/tenant-header.js";

/**
 * Attach the supervisor's signed tenant header to `headers` IFF an HMAC key is
 * configured, via the canonical `signTenantHeader`. The SINGLE decision point for
 * the "sign iff key present" branch shared by the data path (`buildForwardRequest`)
 * and the liveness probe (`buildProbeRequest`) — the canonical-contract module
 * keeps SIGNING in one place, so the optional-signing branch lives in one place
 * too and the two paths cannot drift. When no key: no header (the worker skips
 * verification on the UDS hop). Mutates + returns `headers`.
 */
const applySignedTenantHeader = (headers: Headers, hmacKey: string | undefined, tenant: TenantId): Headers => {
  if (hmacKey !== undefined) {
    headers.set(TENANT_HEADER_NAME, signTenantHeader(hmacKey, tenant));
  }
  return headers;
};

// ── Transport seam (injected — keeps the proxy testable without a real UDS) ──

/**
 * The HTTP-over-UDS transport. The production adapter is `bunUdsTransport`
 * (Bun's `fetch(url, { unix })`); tests inject a fake that points at a real
 * in-process server on a temp socket, or that simulates a connect failure. The
 * seam returns a `Result` so a connect/transport failure is an explicit value,
 * never a thrown error the shell has to catch ad hoc.
 */
export type UdsTransport = (
  socketPath: string,
  request: Request,
) => Promise<Result<Response, { readonly reason: string }>>;

/**
 * Production HTTP-over-UDS transport using Bun's `fetch(url, { unix })`. The URL
 * host is irrelevant (the connection is the socket), so a fixed sentinel host is
 * used; the path/query/method/headers/body all come from the forwarded request.
 * A connect/transport error is caught and returned as a typed transport failure
 * (the proxy maps it to `worker-unavailable`).
 */
export const bunUdsTransport: UdsTransport = async (socketPath, request) => {
  try {
    const url = new URL(request.url);
    // Preserve path + query; the authority is the socket, not a TCP host.
    const target = `http://uds.fugue.internal${url.pathname}${url.search}`;
    const res = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // Bun streams a request body; declare half-duplex so a body-carrying
      // method (POST/PUT) does not throw under the fetch streaming contract.
      ...(request.body !== null ? { duplex: "half" } : {}),
      // Bun-specific: dial the Unix-domain socket instead of a TCP host.
      unix: socketPath,
    } as RequestInit & { unix: string; duplex?: "half" });
    return ok(res);
  } catch (e) {
    return err({ reason: e instanceof Error ? e.message : String(e) });
  }
};

/**
 * Build the supervisor→worker UDS LIVENESS probe request: a GET to the worker's
 * unauthenticated `/health` route, carrying the SIGNED `X-Fugue-Tenant` header for
 * `tenant` when an HMAC key is configured.
 *
 * Two invariants this encodes (both are fail-closed traps the worker enforces):
 *   1. PATH — the worker serves `/health` (http/router.ts), NOT `/healthz`; a wrong
 *      path 404s and the probe reads every LIVE worker as dead → SIGKILL → 503.
 *   2. SIGNED HEADER — when `FUGUE_SUPERVISOR_HMAC_KEY` is set (the production
 *      multi-tenant config), the worker's Bun.serve fetch wrapper verifies the
 *      tenant header on EVERY request including `/health` (host.ts) and rejects an
 *      unsigned probe 401. So the probe MUST sign, exactly as `buildForwardRequest`
 *      does for the data path. When the key is unset, no header is sent (the worker
 *      skips verification on the UDS hop).
 *
 * Exported so the path + signed-header contract is unit-testable without a transport
 * (the data-plane outage these two bugs caused was masked by fake probes in tests).
 */
export const buildProbeRequest = (hmacKey: string | undefined, tenant: TenantId): Request => {
  const headers = applySignedTenantHeader(new Headers(), hmacKey, tenant);
  return new Request("http://uds.fugue.internal/health", { method: "GET", headers });
};

// ── Proxy ────────────────────────────────────────────────────────────────────

interface UdsProxyDeps {
  /**
   * The platform-internal HMAC key. SECURITY: this is asserted (by the wiring
   * site, supervisor.ts) to be `FUGUE_SUPERVISOR_HMAC_KEY` — NOT a tenant secret.
   * When `undefined`, the supervisor relies solely on 0600 socket isolation and
   * sends NO `X-Fugue-Tenant` header (matching config.ts: the key is optional and
   * the worker then skips header verification). The client's inbound header is
   * STILL stripped in that case so a client can never inject one.
   */
  readonly hmacKey: string | undefined;
  /** HTTP-over-UDS transport (Bun in prod, fake in tests). */
  readonly transport: UdsTransport;
  readonly logger?: import("../ports.js").LogPort;
}

/**
 * Build the outbound request to forward to the worker: clone the inbound request
 * to the socket, STRIP any client-supplied `X-Fugue-Tenant`, and (when an HMAC
 * key is configured) attach the freshly-signed tenant header. Exported so the
 * header-construction + stripping invariant is directly testable without a
 * transport.
 *
 * SECURITY: the client's `X-Fugue-Tenant` is always deleted before the
 * supervisor's value is set, so a client cannot forge or smuggle a tenant
 * principal even if the key is unset (in which case no header is added at all).
 */
export const buildForwardRequest = (
  inbound: Request,
  tenant: Tenant,
  hmacKey: string | undefined,
): Request => {
  const headers = new Headers(inbound.headers);
  // Strip any client-supplied tenant header — the supervisor is the sole signer.
  // `Headers.delete` is case-insensitive, so a `x-fugue-tenant` / `X-FUGUE-TENANT`
  // smuggling attempt is removed too before the supervisor stamps its own value.
  headers.delete(TENANT_HEADER_NAME);
  // Stamp the supervisor's freshly-signed header (canonical synchronous signer,
  // node:crypto) — shared sign-iff-key-present branch with the liveness probe.
  applySignedTenantHeader(headers, hmacKey, tenant.id);
  // Preserve method/body/url; only headers change. A GET/HEAD has no body.
  const hasBody = inbound.method !== "GET" && inbound.method !== "HEAD";
  return new Request(inbound.url, {
    method: inbound.method,
    headers,
    ...(hasBody ? { body: inbound.body, duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" });
};

/**
 * Reverse-proxy `inbound` to the resolved tenant's worker over `socketPath`,
 * attaching the signed tenant header. On success returns the worker's `Response`
 * UNCHANGED (status/headers/body preserved — the 200 contract). On a transport
 * failure returns `worker-unavailable` for THIS tenant (503, fail-closed).
 */
export const proxyToWorker = async (
  deps: UdsProxyDeps,
  inbound: Request,
  tenant: Tenant,
  socketPath: string,
): Promise<Result<Response, HostError>> => {
  const forward = buildForwardRequest(inbound, tenant, deps.hmacKey);
  const res = await deps.transport(socketPath, forward);
  if (!res.ok) {
    deps.logger?.warn("[supervisor] UDS proxy transport failed — worker unavailable", {
      // Names only the caller's OWN tenant — never another tenant (FR-041).
      tenant: tenant.id,
      reason: res.error.reason,
    });
    return err(workerUnavailable(tenant.id));
  }
  return ok(res.value);
};
