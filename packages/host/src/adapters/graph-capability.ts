/**
 * Graph Capability — the concrete operation bodies behind the narrowed handle
 * types (`MailSendHandle` / `SitesReadHandle` / `DynamicsReadHandle`) the broker
 * hands a node. Each builder closes over the app-only WIF token PRIVATELY and
 * returns an object exposing ONLY its named operation method — there is NO
 * `client`, `token`, or `apiKey` field on the returned handle, so a node holding
 * one cannot reach the raw bearer credential (SC-007). The token lives solely in
 * the closure that calls the injected transport.
 *
 * Like every authority seam in this package, the HTTP egress is an INJECTED
 * transport (`GraphHttp`), never a hardcoded `fetch`, so the bearer-presentation
 * and 4xx→`downstream-denied` mapping are provable against a call-recording fake
 * with no live network.
 *
 * Error mapping mirrors `entra-wif`: a Graph 4xx is a settled "no" →
 * `downstream-denied` (kept distinct from `infra-unreachable`); a transport
 * rejection or unexpected status is a reach failure → `infra-unreachable`. The
 * operation methods NEVER throw — they return on the framework Result channel.
 *
 * @satisfies US7 — the node calls Graph/Dynamics through a narrowly-scoped handle
 *   over the app-only WIF token; no raw client/token is reachable.
 * @satisfies FR-W4-005 — the operation-method/URL narrowing half: the handle
 *   targets the specific Graph resource/operation and only the named operation is
 *   reachable. (The other half — requesting the resource's `.default` app-only
 *   scope at the WIF egress — lives in entra-wif.ts `buildWifFormBody`.)
 * @satisfies SC-007 — 0 raw-client and 0 token/key fields reachable from a handle.
 */

import type { Result, FrameworkError } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import { match } from "ts-pattern";
import type {
  DownstreamScope,
  MailSendHandle,
  SitesReadHandle,
  DynamicsReadHandle,
  OperationNarrowedHandle,
  MailMessage,
  MailSendReceipt,
  SiteContent,
  DynamicsQuery,
  DynamicsResult,
} from "../domain/capability-scope.js";

// ───────────────────────────────────────────────────────────────────────────
// Injected HTTP transport
//
// A minimal request/response surface the operation bodies drive. The bearer
// token is passed explicitly per call (never stored on the transport), so a
// test can assert the WIF token was presented as `Authorization: Bearer …`
// without a `fetch` mock.
// ───────────────────────────────────────────────────────────────────────────

/** A single Graph request — method, absolute URL, bearer token, optional JSON body. */
export interface GraphRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  /** The app-only WIF bearer token — presented as `Authorization: Bearer <token>`. */
  readonly bearer: string;
  /** JSON body for a POST (e.g. the sendMail envelope); absent for a GET. */
  readonly body?: Record<string, unknown>;
}

/** The response shape the operation bodies consume from the transport. */
export interface GraphResponse {
  readonly status: number;
  /** Parsed JSON body (Graph error payload on a 4xx, resource on success). */
  readonly json: Record<string, unknown>;
}

/** The injected Graph HTTP transport — fakeable; never a hardcoded `fetch`. */
export interface GraphHttp {
  readonly request: (req: GraphRequest) => Promise<GraphResponse>;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared response mapping
// ───────────────────────────────────────────────────────────────────────────

/** Microsoft Graph API base. The narrowed handles only ever target sub-paths of this. */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Extract a human-readable reason from a Graph error body (`{ error: { code,
 * message } }`), falling back to the status. Pure.
 */
const graphErrorReason = (status: number, json: Record<string, unknown>): string => {
  const error = json.error;
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return `Graph denied (HTTP ${status})`;
};

/**
 * Map a settled Graph response status to the framework error channel, sharing the
 * `entra-wif` denial/reach split — with ONE deliberate divergence. Like the WIF
 * mapper, a 400/401/403 authorization status is a settled `downstream-denied`
 * (kept distinct from `infra-unreachable`), and 429/503 throttling is a named
 * reach failure. The divergence: this mapper ALSO treats a 404 as
 * `downstream-denied`, where the WIF mapper does not. That is intentional — on a
 * resource-scoped Graph path (e.g. `/sites/<id>`, Sites.Selected) a 404 is an
 * authorization-shaped "no": Graph returns 404 rather than 403 to avoid
 * confirming a resource the caller may not enumerate. The `resource` is the
 * operation's target URL.
 */
const mapGraphError = (
  resource: string,
  res: GraphResponse,
): FrameworkError => {
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
    return { kind: "downstream-denied", resource, reason: graphErrorReason(res.status, res.json) };
  }
  // Throttling (429) / service-unavailable (503): a retriable reach failure named
  // so operators read the throttle, not a generic "unreachable". Retry unchanged.
  if (res.status === 429 || res.status === 503) {
    return { kind: "infra-unreachable", operation: "graph", message: `Graph throttled (HTTP ${res.status})` };
  }
  return {
    kind: "infra-unreachable",
    operation: "graph",
    message: `Graph unreachable or unexpected status (HTTP ${res.status})`,
  };
};

/**
 * Run one Graph request through the injected transport, translating a transport
 * rejection into `infra-unreachable`. Returns the raw response on a 2xx for the
 * caller to shape, or the mapped error otherwise. NEVER throws.
 */
const runGraph = async (
  http: GraphHttp,
  req: GraphRequest,
  resource: string,
): Promise<Result<GraphResponse, FrameworkError>> => {
  let res: GraphResponse;
  try {
    res = await http.request(req);
  } catch (e) {
    return err({
      kind: "infra-unreachable",
      operation: "graph",
      message: `Graph transport failure: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (res.status >= 200 && res.status < 300) return ok(res);
  return err(mapGraphError(resource, res));
};

// ───────────────────────────────────────────────────────────────────────────
// Operation-narrowed handle builders
//
// Each builder takes the app-only token + transport and returns a handle whose
// ONLY own member is the operation method. The token is captured in the closure
// and never exposed — `Object.keys(handle)` is exactly `[operation]` (SC-007).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the `sendMail`-only handle for `msgraph:mail.send`, over the app-only WIF
 * token. Targets `/users/{message.from}/sendMail` — NOT `/me/sendMail`: the token
 * is application-permission (client-credentials), for which Graph rejects `/me`
 * unconditionally ("/me request is only valid with delegated authentication
 * flow"). The sender mailbox is the caller-supplied `message.from`; Graph gates
 * which mailboxes the agent app may send as (ApplicationAccessPolicy), so a
 * disallowed mailbox surfaces as `downstream-denied` (review C2).
 */
export const buildMailSendHandle = (token: string, http: GraphHttp): MailSendHandle => ({
  sendMail: async (message: MailMessage): Promise<Result<MailSendReceipt, FrameworkError>> => {
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(message.from)}/sendMail`;
    const ran = await runGraph(
      http,
      {
        method: "POST",
        url,
        bearer: token,
        body: {
          message: {
            subject: message.subject,
            body: { contentType: "Text", content: message.body },
            toRecipients: [{ emailAddress: { address: message.to } }],
          },
        },
      },
      url,
    );
    if (!ran.ok) return err(ran.error);
    // Graph `sendMail` returns 202 Accepted with no id; synthesise a receipt from
    // the response's request id if present, else a stable accepted marker. A3
    // (intentional, documented best-effort): Graph guarantees no message id on a
    // 202, so `"accepted"` is a deliberate sentinel, not a recoverable failure.
    const messageId =
      typeof ran.value.json.id === "string" ? ran.value.json.id : "accepted";
    return ok({ messageId });
  },
});

/** Build the `readSite`-only handle for `msgraph:sites.read`, over the WIF token. */
export const buildSitesReadHandle = (token: string, http: GraphHttp): SitesReadHandle => ({
  readSite: async (siteId: string): Promise<Result<SiteContent, FrameworkError>> => {
    const url = `${GRAPH_BASE}/sites/${encodeURIComponent(siteId)}`;
    const ran = await runGraph(http, { method: "GET", url, bearer: token }, url);
    if (!ran.ok) return err(ran.error);
    const title =
      typeof ran.value.json.displayName === "string"
        ? ran.value.json.displayName
        : typeof ran.value.json.name === "string"
          ? ran.value.json.name
          : undefined;
    // A 2xx whose body carries NO usable title is a malformed success — mirror
    // entra-wif's A4 mapping (200-without-usable-body → infra-unreachable) rather
    // than silently returning an empty title that reads as a real (blank) site.
    if (title === undefined) {
      return err({
        kind: "infra-unreachable",
        operation: "graph",
        message: `Graph returned 2xx for site '${siteId}' with no displayName/name`,
      });
    }
    return ok({ siteId, title });
  },
});

/** Build the `read`-only handle for `dynamics:read`, over the WIF token. */
export const buildDynamicsReadHandle = (token: string, http: GraphHttp): DynamicsReadHandle => ({
  read: async (query: DynamicsQuery): Promise<Result<DynamicsResult, FrameworkError>> => {
    // KNOWN LIMITATION: the Dynamics/Dataverse path is unwired in production. The
    // correct base is the per-org Dataverse host `https://<org>.crm.dynamics.com`,
    // NOT this placeholder — see
    // docs/runbooks/2026-06-10-entra-fugue-agents-provisioning.md. When Dynamics is
    // wired, the per-org Dataverse host MUST come from config, never hardcoded.
    const base = "https://dynamics.microsoft.com/api/data/v9.2";
    const filter = query.filter !== undefined ? `?$filter=${encodeURIComponent(query.filter)}` : "";
    const url = `${base}/${encodeURIComponent(query.entity)}${filter}`;
    const ran = await runGraph(http, { method: "GET", url, bearer: token }, url);
    if (!ran.ok) return err(ran.error);
    const value = ran.value.json.value;
    // A Dataverse collection response always carries a `value` array (possibly
    // empty). Its ABSENCE on a 2xx is a malformed success, not an empty result —
    // map it to infra-unreachable (entra-wif A4) instead of silently returning
    // zero rows, which a caller would read as "the query legitimately matched
    // nothing".
    if (!Array.isArray(value)) {
      return err({
        kind: "infra-unreachable",
        operation: "graph",
        message: `Dynamics returned 2xx for entity '${query.entity}' with no 'value' array`,
      });
    }
    const rows = value.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object");
    // A non-object row inside an otherwise-2xx `value` array is a PARTIALLY
    // malformed success — same A4 precedent as the absent `value` above. Map it
    // to infra-unreachable rather than silently filtering: a quietly smaller row
    // set would read as "the query legitimately matched fewer records".
    if (rows.length !== value.length) {
      return err({
        kind: "infra-unreachable",
        operation: "graph",
        message: `Dynamics returned 2xx for entity '${query.entity}' with ${value.length - rows.length} non-object row(s) in 'value'`,
      });
    }
    return ok({ rows });
  },
});

/**
 * Build the operation-narrowed handle for a parsed scope over the app-only WIF
 * token. Exhaustive over the scope ADT — a new operation is a compile error. The
 * returned handle exposes ONLY its operation method; the token is unreachable.
 */
export const buildGraphHandle = (
  scope: DownstreamScope,
  token: string,
  http: GraphHttp,
): OperationNarrowedHandle =>
  match(scope)
    .with({ provider: "msgraph", operation: "mail.send" }, () => buildMailSendHandle(token, http))
    .with({ provider: "msgraph", operation: "sites.read" }, () => buildSitesReadHandle(token, http))
    .with({ provider: "dynamics", operation: "read" }, () => buildDynamicsReadHandle(token, http))
    .exhaustive();
