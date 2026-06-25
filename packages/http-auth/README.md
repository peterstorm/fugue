# @fuguejs/http-auth

A generic **authenticated-REST capability** for the Fugue DAG framework. Any
DAG that must call a token-auth'd REST API declares `requires: ["authedHttp"]`
and reads `ctx.authedHttp`. The capability mints and caches a boot-scoped bearer
token (a generic OAuth2-style password/operator grant), injects it into every
request, validates responses against Zod schemas, and returns `Result` — no
exception escapes any method.

This package is **not specific to any single API**. All auth and base-location
configuration arrives via the factory; nothing is read from `process.env` here
(FR-060).

## Install

```sh
bun add @fuguejs/http-auth
```

`@fuguejs/framework` and `zod` are peer dependencies.

## Usage

```ts
import { createHttpAuthAdapter } from "@fuguejs/http-auth";
import { z } from "zod";

const authedHttp = createHttpAuthAdapter({
  baseUrl: "https://api.example.com",
  defaultHeaders: { Accept: "application/json" },
  timeoutMs: 10_000,
  auth: {
    tokenUrl: "https://auth.example.com/oauth/token",
    grantType: "operator_password",
    params: { brand_key: "acme" },           // static extra form fields
    basicAuth: { username: "id", password: "secret" }, // optional HTTP Basic
    credentials: { username: "operator", password: "s3cret" },
  },
});

// Register with the host:
const sharedInfra = { /* ... */ capabilities: [authedHttp] };

// In a node:
const CustomerSchema = z.object({ id: z.string(), name: z.string() });

createFetchNode({
  id: "fetch-customer",
  requires: ["authedHttp"] as const,
  fetch: (input, ctx) =>
    ctx.authedHttp.get(`/customers/${input.id}`, { schema: CustomerSchema }),
});
```

## Capability surface

`ctx.authedHttp` exposes:

| Method                          | Body | Notes                                  |
| ------------------------------- | ---- | -------------------------------------- |
| `get(path, { schema, ... })`    | no   |                                        |
| `post(path, { schema, body })`  | yes  | body is JSON-stringified               |
| `put(path, { schema, body })`   | yes  |                                        |
| `patch(path, { schema, body })` | yes  |                                        |
| `delete(path, { schema, ... })` | no   |                                        |

No-body verbs (`get`/`delete`) take `AuthedRequestOpts`:
`{ schema, headers?, timeoutMs? }`. Body verbs (`post`/`put`/`patch`) take
`AuthedBodyRequestOpts`, which additionally carries `body?` and `contentType?`.
The body/no-body split lives in the option types alone — passing `body` to a
no-body verb is a compile error. Every method returns
`Promise<Result<T, FrameworkError>>`.

## Token management

- **One boot-scoped cached token**, shared across all requests, minted lazily on
  first use and refreshed when absent or expired (with a 30s clock-skew guard).
- **Single-flight refresh**: a burst of concurrent callers arriving after expiry
  mints exactly one token, not N.
- **401 retry**: on a `401` from any verb, the token is invalidated, re-minted,
  and the original request retried exactly once.

The boot-scoped cache means steady-state requests inject the cached token without
a per-request auth round-trip (NFR-001/SC-001). The token and credentials are
never logged and never returned from any method (NFR-010).

## Error mapping

Mirrors the framework's built-in HTTP capability. The same classification applies
on **both** the token-mint path and the request path.

| Failure                                       | `FrameworkError.kind`         | Retriable? | Why                                                                                  |
| --------------------------------------------- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| network failure                               | `transient`                   | yes        | A connectivity blip should be retried.                                               |
| our own timeout (deadline abort, msg "timeout") | `transient`                   | yes        | A slow endpoint should be retried.                                                   |
| non-timeout `AbortError` (caller/node cancel) | `node-crash` (non-retriable)  | **no**     | A deliberate cancellation must not silently auto-retry the work it stopped.          |
| HTTP 5xx                                       | `transient` (with httpStatus) | yes        | Server-side fault, typically transient.                                              |
| HTTP 429 (Too Many Requests)                  | `transient` (with httpStatus) | yes        | Rate-limit — the textbook back-off-and-retry signal.                                 |
| HTTP 408 (Request Timeout)                    | `transient` (with httpStatus) | yes        | The server timed the request out — retry.                                            |
| HTTP 4xx (other non-401)                      | `node-crash` (non-retriable)  | **no**     | Deterministic rejection; the same request would just fail again.                     |
| invalid JSON / schema mismatch                | `node-crash` (non-retriable)  | **no**     | Deterministic payload defect.                                                        |
| 401 persisting after a token refresh          | `node-crash` (non-retriable)  | **no**     | A second consecutive 401 is settled auth failure, not a transient blip.              |

Timeout vs. cancellation: our **own** deadline abort (we fire it with the message
`"timeout"`) stays `transient` (retriable), but a non-timeout `AbortError` — a
caller/node cancellation, including a health-check deadline cancelling its mint —
maps to a non-retriable `node-crash`, because auto-retrying cancelled work defeats
the cancellation.

## Lifecycle

The handle returned by `createHttpAuthAdapter` participates in the runtime
lifecycle:

- `connect()` mints the first token (a bad credential fails boot, not the first
  run).
- `healthCheck()` forces a fresh token-mint round-trip, racing a 5s timeout.
- `close()` is a no-op (no connection pool to drain).

## Testing

Use `createFakeAuthedHttpCapability` to test DAG nodes without network or token
machinery:

```ts
import { createFakeAuthedHttpCapability } from "@fuguejs/http-auth";

const fake = createFakeAuthedHttpCapability({
  "GET /customers/123": { id: "123", name: "Alice" },
  "POST /orders": { body: { orderId: "ord-1" } },
  "GET /customers/999": { status: 404, body: "Not Found" },
});
```

For unit-testing the real client/provider, inject a fake `fetch` seam via the
`fetch` config option — no network and no mocking framework required.
