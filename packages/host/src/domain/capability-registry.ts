/**
 * CapabilityRegistry augmentation — registers the broker-resolvable downstream
 * scopes as first-class capabilities (ADR-0051 module augmentation; review C6).
 *
 * A DAG node declares a downstream scope the same way it declares any other
 * capability: `requires: ["msgraph:mail.send"]`. For that to typecheck — and for
 * `ctx["msgraph:mail.send"]` to be typed as the narrowed `MailSendHandle` inside
 * the node's `run` — each `"<provider>:<operation>"` scope must be a key on the
 * framework's `CapabilityRegistry`. This module adds them.
 *
 * THE SOUNDNESS LINK (C6): the live Keycloak broker builds each handle via
 * `buildGraphHandle`, whose return type for a given scope is exactly the handle
 * named by `HandleForScope<scope>` (the type-level scope→handle map in
 * `capability-scope.ts`). Previously `HandleForScope` was defined but never wired
 * into the registry, so nothing connected `CapabilityRegistry["msgraph:mail.send"]`
 * to `MailSendHandle` — the broker's assembled record was widened to the registry
 * shape by an UNCHECKED cast, and augmenting a scope key with a raw vendor client
 * type would have compiled while crashing a node at runtime.
 *
 * The static assertions below close that gap: each registry entry is asserted
 * equal to the handle `HandleForScope` assigns the scope. If a future edit points
 * a scope key at the wrong type (a raw client, the wrong handle), THIS FILE fails
 * to compile — making the broker's single remaining trust-boundary cast sound by
 * construction rather than by convention.
 *
 * This file is type-only: it emits no runtime code. It is part of the host
 * compilation (so the augmentation is globally visible), and is re-exported from
 * the broker module so the dependency is explicit and the augmentation can never
 * be tree-shaken out of a consumer that imports the broker.
 */

import type {
  MailSendHandle,
  SitesReadHandle,
  DynamicsReadHandle,
  HandleForScope,
} from "./capability-scope.js";
import type { CapabilityRegistry } from "@fuguejs/framework";

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    /** `msgraph:mail.send` → the `sendMail`-only narrowed handle (FR-W3-004). */
    readonly "msgraph:mail.send": MailSendHandle;
    /** `msgraph:sites.read` → the `readSite`-only narrowed handle. */
    readonly "msgraph:sites.read": SitesReadHandle;
    /** `dynamics:read` → the `read`-only narrowed handle. */
    readonly "dynamics:read": DynamicsReadHandle;
  }
}

// ── Compile-time soundness assertions (C6) ──────────────────────────────────
// Each broker-resolvable scope key in `CapabilityRegistry` MUST equal the handle
// type the scope→handle map (`HandleForScope`) assigns it — which is exactly the
// type `buildGraphHandle` returns for that scope. If any of these errors, the
// registry and the broker's handles have drifted and the broker's record cast is
// no longer sound; fix the registry entry above (do NOT loosen the assertion).

type _Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type _StaticAssert<T extends true> = T;

type _MailSendWired = _StaticAssert<
  _Equal<
    CapabilityRegistry["msgraph:mail.send"],
    HandleForScope<{ readonly provider: "msgraph"; readonly operation: "mail.send" }>
  >
>;
type _SitesReadWired = _StaticAssert<
  _Equal<
    CapabilityRegistry["msgraph:sites.read"],
    HandleForScope<{ readonly provider: "msgraph"; readonly operation: "sites.read" }>
  >
>;
type _DynamicsReadWired = _StaticAssert<
  _Equal<
    CapabilityRegistry["dynamics:read"],
    HandleForScope<{ readonly provider: "dynamics"; readonly operation: "read" }>
  >
>;

// Reference the assertion aliases so `noUnusedLocals`-style tooling keeps them
// (they are the whole point of the file). Exported as a single phantom marker.
export type CapabilityRegistryWired = [_MailSendWired, _SitesReadWired, _DynamicsReadWired];
