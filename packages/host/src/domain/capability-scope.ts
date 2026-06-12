/**
 * Capability Scope — parse-don't-validate for downstream capability names and
 * the TYPE of the operation-narrowed handle a node receives.
 *
 * A node declares `requires: ["msgraph:mail.send"]`. Before any token is
 * minted, the broker must turn that raw string into a TYPED scope (so illegal /
 * unknown scopes are rejected once, at the edge) and hand the node a handle
 * that exposes ONLY the named operation — never a raw downstream client and
 * never a token/key field. This module owns both halves PURELY: the parser
 * (`parseScope`) and the narrowed-handle TYPES. The concrete implementations
 * live in `adapters/graph-capability.ts` (`buildGraphHandle`, wired by the
 * Keycloak broker; the Dynamics path is unwired — see its KNOWN LIMITATION) —
 * here the handles are interfaces with operation methods and structurally no
 * `client`/`token`/`apiKey` slot.
 *
 * @satisfies US4 — a node declaring `requires:["msgraph:mail.send"]` receives a
 *   narrowed handle; the functional core can NEVER reach a raw downstream
 *   client or token (the handle types below expose neither).
 * @satisfies FR-W3-004 — operation narrowing: the handle exposes only the named
 *   operation(s); the raw client is unreachable, enforced by the type with no
 *   escape hatch (no `client` member exists to widen to).
 * @satisfies FR-W3-005 — no raw token or vendor API key is reachable from
 *   node-executed code: the handle interfaces declare no `token`/`apiKey` field.
 * @satisfies SC-007 — 0 raw-client and 0 token/key fields reachable from a
 *   node's capability handle (type-level test in capability-scope.test.ts).
 */

import { match } from "ts-pattern";
import type { Result, FrameworkError } from "@fuguejs/framework";

// ───────────────────────────────────────────────────────────────────────────
// Parsed scope ADT
//
// A `DownstreamScope` is a discriminated union on `provider`, with a
// provider-specific `operation` literal union. This makes illegal states
// unrepresentable: there is no `DownstreamScope` for an unknown provider and no
// way to pair `msgraph` with a Dynamics operation — the parser is the only
// constructor, so every value in the type came from a recognised name.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Provider → recognised operations: the single source of truth, from which the
 * operation unions below are DERIVED (not asserted to agree). Adding an
 * operation here without extending the handle machinery is therefore a COMPILE
 * error at the exhaustive `match` sites (`handleKindForScope`,
 * `buildGraphHandle`) — not a runtime `.exhaustive()` throw — and the
 * membership casts in `parseScope` are tautological, never forging.
 */
const KNOWN_SCOPES = {
  msgraph: ["mail.send", "sites.read"],
  dynamics: ["read"],
} as const;

/** Microsoft Graph operations this layer recognises — derived from `KNOWN_SCOPES`. */
export type MsGraphOperation = (typeof KNOWN_SCOPES)["msgraph"][number];

/** Dynamics operations this layer recognises — derived from `KNOWN_SCOPES`. */
export type DynamicsOperation = (typeof KNOWN_SCOPES)["dynamics"][number];

/**
 * A parsed, typed downstream scope. Discriminated by `provider`; the
 * `operation` field is narrowed to that provider's operation union, so an
 * exhaustive `match` on `provider` always knows the operation's shape.
 */
export type DownstreamScope =
  | { readonly provider: "msgraph"; readonly operation: MsGraphOperation }
  | { readonly provider: "dynamics"; readonly operation: DynamicsOperation };

// ───────────────────────────────────────────────────────────────────────────
// Operation-narrowed handle types (FR-W3-004 / FR-W3-005 / SC-007)
//
// Each handle interface carries ONLY operation methods. There is deliberately
// NO `client`, `token`, or `apiKey` member: a node holding one of these handles
// has no field to reach a raw vendor client or credential through. The concrete
// implementations (`adapters/graph-capability.ts`) supply the method bodies;
// they close over the app-only token privately, but the TYPE the node sees
// exposes only the operations.
// ───────────────────────────────────────────────────────────────────────────

/** Handle for `msgraph:mail.send` — exposes only `sendMail`, nothing else. */
export interface MailSendHandle {
  readonly sendMail: (message: MailMessage) => Promise<Result<MailSendReceipt, FrameworkError>>;
}

/** Handle for `msgraph:sites.read` — exposes only `readSite`. */
export interface SitesReadHandle {
  readonly readSite: (siteId: string) => Promise<Result<SiteContent, FrameworkError>>;
}

/** Handle for `dynamics:read` — exposes only `read`. */
export interface DynamicsReadHandle {
  readonly read: (query: DynamicsQuery) => Promise<Result<DynamicsResult, FrameworkError>>;
}

/**
 * The union of every operation-narrowed handle. A parsed scope maps to exactly
 * one member of this union (see `handleKindForScope`); no member exposes a raw
 * client or credential, so SC-007 holds for the whole union.
 */
export type OperationNarrowedHandle = MailSendHandle | SitesReadHandle | DynamicsReadHandle;

// --- Operation payloads ---
/**
 * A mail to send through the `msgraph:mail.send` handle.
 *
 * `from` is the SENDER MAILBOX (an id or UPN, e.g. `agent@contoso.com`) the
 * message is sent AS — it is REQUIRED and load-bearing (review C2): the handle is
 * built over an APP-ONLY (client-credentials / WIF) token, and Microsoft Graph
 * rejects `/me/sendMail` unconditionally for application-permission tokens
 * ("/me request is only valid with delegated authentication flow"). An app-only
 * send MUST target `/users/{mailbox}/sendMail`, so the mailbox cannot be implicit
 * — modelling it as a required field makes "send with no sender mailbox"
 * unrepresentable rather than a guaranteed runtime Graph rejection. Graph still
 * gates which mailboxes the agent's app registration may send as
 * (ApplicationAccessPolicy), so naming a mailbox here is not itself authority.
 */
export type MailMessage = {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};
export type MailSendReceipt = { readonly messageId: string };
export type SiteContent = { readonly siteId: string; readonly title: string };
export type DynamicsQuery = { readonly entity: string; readonly filter?: string };
export type DynamicsResult = { readonly rows: readonly Readonly<Record<string, unknown>>[] };

/**
 * Type-level map from a parsed scope to its narrowed-handle type. Lets the
 * broker side (`buildGraphHandle` in `adapters/graph-capability.ts`) say "a
 * `msgraph:mail.send` scope yields a `MailSendHandle`" in the types, so node
 * code that requested mail.send is handed exactly the sendMail-only handle.
 * Implemented as a conditional type over the scope ADT.
 */
export type HandleForScope<S extends DownstreamScope> =
  S extends { readonly provider: "msgraph"; readonly operation: "mail.send" } ? MailSendHandle :
  S extends { readonly provider: "msgraph"; readonly operation: "sites.read" } ? SitesReadHandle :
  S extends { readonly provider: "dynamics"; readonly operation: "read" } ? DynamicsReadHandle :
  never;

// ───────────────────────────────────────────────────────────────────────────
// Parser
// ───────────────────────────────────────────────────────────────────────────

// Compile-time pin (same `_StaticAssert` idiom as capability-registry.ts):
// every provider in the scope ADT has a `KNOWN_SCOPES` entry. The operations
// themselves are derived from the const above, so they cannot drift.
type _StaticAssert<T extends true> = T;
type _ProvidersCovered = _StaticAssert<
  [DownstreamScope["provider"]] extends [keyof typeof KNOWN_SCOPES] ? true : false
>;
// Reference the assertion so `noUnusedLocals`-style tooling keeps it.
export type KnownScopesCoverProviders = [_ProvidersCovered];

/**
 * Parse a capability `requires` name (`"<provider>:<operation>"`) into a typed
 * `DownstreamScope`. Parse-don't-validate: the ONLY way to obtain a
 * `DownstreamScope` is through this function, so every downstream scope in the
 * system is one of the recognised names.
 *
 * A name that is not a recognised downstream scope reads as `undefined` —
 * first-class ABSENCE, not an error (the same FR-X-003 shape as
 * `token-cache.ts`'s `lookup`). Every caller (the broker's `mintFor` skip and
 * `provides`, the boot-time `AGENT_CLIENT_SCOPES` validation) asks "is this a
 * downstream scope?", a classification with a routine negative case: plain
 * capability names (`http`, `llm`) and ADR-0051 custom names flow through here
 * on every validation and are simply not scopes. An unknown name in a node's
 * `requires` surfaces at run-start as `missing-capability` (no static
 * capability of that name exists), and a typo'd policy entry fails the boot —
 * neither path is an authorization refusal, so no `policy-refusal` is
 * constructed here (that kind is reserved for a settled "no" to a real scope).
 */
export const parseScope = (name: string): DownstreamScope | undefined => {
  const sep = name.indexOf(":");
  if (sep <= 0 || sep === name.length - 1) return undefined;
  const provider = name.slice(0, sep);
  const operation = name.slice(sep + 1);

  if (provider === "msgraph" && (KNOWN_SCOPES.msgraph as readonly string[]).includes(operation)) {
    return { provider: "msgraph", operation: operation as MsGraphOperation };
  }
  if (provider === "dynamics" && (KNOWN_SCOPES.dynamics as readonly string[]).includes(operation)) {
    return { provider: "dynamics", operation: operation as DynamicsOperation };
  }
  return undefined;
};

/**
 * The narrowed-handle KIND a parsed scope resolves to, as a stable string tag.
 * Pure mapping naming which concrete handle a scope yields — the same
 * scope→handle selection `buildGraphHandle` (`adapters/graph-capability.ts`)
 * performs when the broker builds the real handle; exposed here so the
 * correspondence is testable without any concrete implementation. Exhaustive
 * over the scope ADT.
 */
export type HandleKind = "mail.send" | "sites.read" | "dynamics.read";

export const handleKindForScope = (scope: DownstreamScope): HandleKind =>
  match(scope)
    .with({ provider: "msgraph", operation: "mail.send" }, () => "mail.send" as const)
    .with({ provider: "msgraph", operation: "sites.read" }, () => "sites.read" as const)
    .with({ provider: "dynamics" }, () => "dynamics.read" as const)
    .exhaustive();
