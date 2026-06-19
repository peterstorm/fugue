# ADR-0066: IPC — a Unix domain socket carrying HTTP between supervisor and worker

## Status

Accepted

## Date

2026-06-19

## Context

The multi-tenant single-host design (ADR-0064) splits today's "one process =
one tenant" host into a **supervisor** that owns the single inbound HTTP listener
(FR-001) and **workers** that are each `createHost` bound to exactly one tenant
(FR-007). US3 requires that an authenticated caller, resolved to a `Tenant`
principal at the supervisor boundary, be routed to the worker that owns that
tenant — and to **no other worker** (FR-004). This raises a transport question
the spec deferred to architecture (spec edge case 4: "Supervisor⇆worker IPC
mechanism — UDS / stdio JSON-RPC / Redis queue / localhost HTTP"):

> **By what mechanism does the supervisor hand a request to the owning worker,
> and the worker hand its response back?**

The forces at play are sharp and partly in tension:

- **Preserve the existing HTTP contract.** The synchronous `POST /dags/:id/run`
  path already has a fully-built, tested HTTP request/response semantics —
  status codes, headers, streaming bodies, back-pressure — served by `run-dag.ts`
  through the Hono router on `Bun.serve` (ADR-0035). The split must reuse that
  control plane (auth→team, `canAccessDag`, token store, capability broker, cache
  keys, HITL) verbatim; rewriting handlers onto a new wire format would discard
  the contract and its test suite.
- **Strong per-tenant isolation on a single box.** The OS process boundary is the
  isolation mechanism. The transport must not become a second, weaker boundary:
  a worker's endpoint must be reachable only by the supervisor and that worker's
  own uid, never by an arbitrary local process or another tenant's worker
  (FR-004, FR-007, FR-008).
- **Carry a principal, not a secret.** The supervisor holds **zero** tenant
  secrets (FR-005); secrets reach only the owning worker (FR-006). Whatever the
  supervisor stamps onto a forwarded request to identify the resolved tenant must
  be a *principal proof*, not a credential the supervisor would have to possess.
- **Low latency, contained failure.** The synchronous run path must not gain a
  durable hop or extra round-trips, and a single worker's transport fault must be
  contained to that tenant (fail-closed to `worker-unavailable` 503, FR-041) and
  never surface as another tenant's error or a generic 500.

State the problem, not the solution: the supervisor needs a local IPC that keeps
the HTTP contract intact, scopes reachability to the supervisor+worker uid, and
threads a non-secret tenant principal — without re-framing a single handler.

## Options Considered

1. **HTTP over a per-worker Unix-domain socket (chosen).**
   The worker is the *same* HTTP app — `createHost`'s `Bun.serve` simply binds a
   per-tenant UDS (`/run/fugue/<tenant>.sock`, chmod `0600`) instead of a TCP
   port. The supervisor is a transparent reverse proxy: it forwards the inbound
   `Request` to the owning worker's socket and streams the worker's `Response`
   back verbatim, attaching a signed `X-Fugue-Tenant` header (HMAC over an
   internal supervisor key — never a tenant secret).
   - Pros: reuses the existing HTTP request/response contract **byte-for-byte** —
     no handler, no router, no `run-dag.ts` change; the worker is the unchanged
     single-tenant app bound to a socket instead of a port. Lowest-latency local
     transport (a same-host kernel socket, no network stack hop). Reachability is
     scoped by **filesystem permissions** (`0600`): only the supervisor and the
     worker's own uid can open the socket, so a request arriving on a worker's
     UDS is, by construction, for that worker's tenant — there is no port and no
     network namespace to expose. Carries no secret on the wire: the stamped
     header is an HMAC *principal proof*. Streaming and back-pressure semantics
     come free from `Bun.serve`. A connect/transport failure is a typed value the
     proxy maps to `worker-unavailable` for that tenant alone (fail-closed,
     contained).
   - Cons: the worker and supervisor must agree byte-for-byte on the signed-header
     contract or every request fails closed — a drift hazard that has to be
     centralized in one module. UDS is a POSIX/local-host mechanism (acceptable:
     NFR-001's target is a single box of ~10–20 workers, not a distributed mesh).
     Requires socket-file lifecycle management (stale-socket cleanup on restart,
     liveness re-probe on re-adoption — see ADR-0065).

2. **Localhost TCP (loopback) between supervisor and worker.**
   - Pros: also reuses the HTTP contract unchanged; `Bun.serve` on a `127.0.0.1`
     port is trivial; portable across OSes.
   - Cons: **weaker isolation** — a loopback port is reachable by *any* local
     process under any uid, not just the supervisor + owning worker, so the
     transport is no longer a tenant boundary the way `0600` filesystem perms are.
     Adds **port management** (allocation, collision avoidance, recycling across
     crash/restart) that a per-tenant socket path sidesteps. Buys nothing over
     UDS for a single-box deployment while widening the attack surface.

3. **stdio JSON-RPC (a bespoke RPC framing over the worker's stdin/stdout).**
   - Pros: no socket file, no port; a private channel inherently scoped to the
     parent→child pipe.
   - Cons: **throws away the HTTP contract** — every handler would have to be
     re-framed off HTTP onto an RPC envelope, discarding the router, the existing
     request/response shape, and its tests (the exact reuse this design exists to
     protect, ADR-0035). Loses the streaming/back-pressure semantics `Bun.serve`
     gives for free, and re-implements a request/response, headers, and status
     vocabulary HTTP already provides.

4. **Redis queue for synchronous runs.**
   - Pros: durable hop; decouples supervisor from worker availability.
   - Cons: adds a **durable round-trip and latency** to a path whose whole point
     is to preserve the existing *synchronous* HTTP 200 contract. Inverts the
     request/response model into produce/consume/correlate, complicating the
     in-flight 200 path for no isolation gain (Redis isolation is already handled
     per-tenant by ACL users, ADR-0064 / AD-4). Wrong tool for a sync hop.

A genuine alternative existed (loopback TCP also preserves the HTTP contract), so
this is **not** a forced choice — it is a deliberate isolation-and-latency
decision to scope reachability by `0600` filesystem permissions rather than an
open local port.

## Decision

**Supervisor↔worker IPC is HTTP carried over a per-worker Unix-domain socket: the
worker is the unchanged `createHost` HTTP app bound to `/run/fugue/<tenant>.sock`
(chmod `0600`), and the supervisor is a transparent reverse proxy that forwards
the request and streams the response back verbatim, stamping a signed
`X-Fugue-Tenant` principal header.**

Concretely:

- **Worker bind (the same app, a socket instead of a port).**
  `packages/host/src/host.ts` accepts `deps.bind = { unix }`. When set, it calls
  `Bun.serve({ fetch, unix: unixPath, ... })` instead of `Bun.serve({ fetch,
  port })`, then `chmodSync(unixPath, 0o600)` **before** announcing readiness — a
  chmod failure is a fail-closed boot abort, because an un-restricted tenant
  socket is worse than a clean boot failure (FR-007). A UDS server has no TCP
  port; the handle reports `port: 0`. `packages/host/src/worker-main.ts` is the
  entrypoint: it reads `TENANT_ID` + the secrets reference from spawn env, parses
  config, computes the socket path from `WORKER_UDS_DIR`, and calls `createHost`
  bound to that one tenant on that one socket. No router, no handler, no
  `run-dag.ts` change — the HTTP contract is reused verbatim.

- **Supervisor proxy (transparent, verbatim).**
  `packages/host/src/supervisor/uds-proxy.ts` exposes `proxyToWorker(deps,
  inbound, tenant, socketPath)`. It builds the forward request, dials the
  worker's socket via an injected `UdsTransport` (production `bunUdsTransport`
  uses Bun's `fetch(url, { unix })` with `duplex: "half"` for body-carrying
  methods), and on success returns the worker's `Response` **unchanged** —
  status, headers, body preserved. On a connect/transport failure it returns
  `workerUnavailable(tenant.id)` (503) naming **only the caller's own tenant**
  (FR-041).

- **Signed tenant principal (a proof, never a secret).**
  `packages/host/src/domain/tenant-header.ts` is the single source of truth for
  the header contract: name `X-Fugue-Tenant`, value `<tenantId>.<hmacHex>` where
  `hmacHex = hex(HMAC-SHA256(FUGUE_SUPERVISOR_HMAC_KEY, tenantId))`. The
  supervisor's `buildForwardRequest` **strips** any client-supplied
  `X-Fugue-Tenant` (case-insensitively — smuggling defense) and sets the freshly
  signed value; the worker's `verifyTenantHeader` re-validates it constant-time
  against its own bound tenant. Both sides `import` the *same* function, so the
  signer (supervisor) and verifier (worker) cannot drift. The key is a
  platform-internal integrity key shared supervisor↔worker — **not** a tenant
  secret and **not** the per-tenant Redis-ACL credential (FR-005/FR-006 hold).

Key invariants:

- The **HTTP 200 contract is preserved end-to-end**: the worker's status, headers,
  and body are streamed back unchanged. This is the load-bearing property and is
  pinned by `packages/host/src/__tests__/supervisor/uds-proxy.test.ts`:
  *"preserves the worker's status, headers, and body verbatim"* asserts a `200`
  round-trips intact; *"preserves a non-200 worker status (e.g. 400) verbatim —
  does not rewrite it"* proves the proxy never rewrites a worker status; and
  *"proxies over a real Unix-domain socket, preserving the 200 contract and a
  canonically-verifiable header"* exercises a real fetch-over-UDS round trip.
- **Reachability is scoped by `0600` filesystem permissions** — only the
  supervisor and the worker's own uid can open the socket. The socket is the
  PRIMARY per-tenant boundary; the signed header is the SECONDARY defensive check.
- **The supervisor is the sole signer.** A client can never forge or smuggle a
  tenant principal: the inbound `X-Fugue-Tenant` is always stripped before the
  supervisor stamps its own value, even when no HMAC key is configured (in which
  case no header is added and the worker relies on socket isolation alone).
- **No secret transits the wire.** The HMAC stamp is a principal proof; the
  inbound `Authorization` bearer is forwarded unchanged for the worker to
  re-validate. The supervisor holds zero tenant secrets (FR-005).
- **Failure is contained and fail-closed.** A transport fault → `worker-unavailable`
  (503) for that tenant only, never another tenant's error and never a generic 500.

## Consequences

**Positive:**

- The worker is the **unchanged HTTP app** bound to a socket instead of a port —
  `run-dag.ts`, the Hono router (ADR-0035), and the entire request/response
  contract (and its tests) are reused verbatim. No handler was re-framed.
- Tenant reachability is enforced by `0600` filesystem permissions, a strictly
  stronger local boundary than an open loopback port: a request arriving on a
  worker's socket is, by construction, for that worker's tenant (FR-004, FR-007).
- The transport carries a **principal, not a credential** — the supervisor holds
  no tenant secret, and the one canonical sign/verify pair in `tenant-header.ts`
  makes supervisor↔worker drift impossible (both sides import the same function).
- Lowest-latency local transport with native streaming/back-pressure from
  `Bun.serve`; no durable hop on the synchronous 200 path.
- Failures are typed and contained: a socket fault becomes `worker-unavailable`
  (503) for exactly the affected tenant, fail-closed (FR-041).
- The HTTP 200 contract preservation is not asserted by inspection — it is pinned
  by the proxy test's verbatim status/headers/body round-trip checks.

**Negative:**

- UDS is a **local-host POSIX mechanism**: this IPC does not extend to a
  cross-host topology. Accepted — the design targets a single box of ~10–20
  workers (NFR-001), not a distributed mesh.
- The transport introduces **socket-file lifecycle** to manage: stale-socket
  cleanup on restart and a UDS liveness re-probe when the supervisor re-adopts
  still-live workers after its own restart (ADR-0065). A leaked or orphaned
  socket file is an operational concern the lifecycle code must own.
- The signed-header contract is **load-bearing and shared**: signer and verifier
  must agree byte-for-byte or every proxied request fails closed. The risk is
  accepted and mitigated by keeping the sole sign/verify implementation in
  `tenant-header.ts` (imported by both sides) rather than re-implemented per side.
- When `FUGUE_SUPERVISOR_HMAC_KEY` is unset, the worker performs **no** header
  verification and relies on socket isolation alone. This is a deliberate
  defense-in-depth posture (the `0600` socket is the primary boundary), but it
  means the secondary integrity check is opt-in; the boot log makes the active
  posture observable so an operator can tell which mode a worker is in.

## Related

- ADR-0064 — multi-tenant single-host approach (supervisor + process-per-tenant
  workers, A3 hybrid): the overall design this IPC serves.
- ADR-0065 — process topology and supervisor re-adoption: consumes this socket as
  the UDS liveness probe used when re-adopting live workers after a supervisor
  restart.
- ADR-0035 — the Hono HTTP server on `Bun.serve`: the request/response contract
  this decision reuses byte-for-byte rather than re-framing.
- ADR-0073 — the signed `X-Fugue-Tenant` tenant principal: the header this IPC
  stamps feeds tenant resolution and the extended error taxonomy on the worker
  side.
- `packages/host/src/supervisor/uds-proxy.ts` — the reverse proxy + signed-header
  stamping/stripping (this decision in code).
- `packages/host/src/domain/tenant-header.ts` — the canonical HMAC sign/verify of
  `X-Fugue-Tenant`, the single source of truth shared by supervisor and worker.
- `packages/host/src/host.ts` — `Bun.serve` binding a `unix` socket + `0600`
  chmod and worker-side header verification; `packages/host/src/worker-main.ts` —
  the worker entrypoint that binds `createHost` to one tenant on its UDS.
- `packages/host/src/__tests__/supervisor/uds-proxy.test.ts` — pins the HTTP 200
  contract preservation (verbatim status/headers/body) and the fail-closed
  `worker-unavailable` (503) behavior.
