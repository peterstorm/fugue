// Pass-through CapabilityBroker — an optional embedder convenience.
//
// It ignores the invocation `origin` and the `requires` declaration and hands
// back the statically-configured clients BYTE-IDENTICALLY — the same client
// references it was constructed with, never copies. Routing a run through it
// is observably equivalent to omitting the broker altogether: NOTHING defaults
// to this broker — `runDag` without a `minting` option skips per-node minting
// entirely, and that omission is the zero-regression path the host uses when
// no realm config is present. Use this broker when an embedder wants a
// `CapabilityBroker`-shaped value (e.g. to satisfy a seam in its own wiring)
// with exactly today's static-client behavior.
//
// It mints NOTHING and makes ZERO token requests, so SC-008 (≤1 token request
// per (identity,audience,scope)/TTL) is satisfied trivially. It references no
// concrete identity provider of any kind (FR-W2-004).
//
// Pure factory: returns a closure over the captured clients. No I/O, no
// `Date.now`/`Math.random`, no mutation.
//
// @satisfies FR-W2-002 — framework ships a pass-through broker handing back
//   statically-configured clients, reproducing today's behavior exactly
// @satisfies FR-W2-003 — every DAG/embedder compiling today keeps byte-identical
//   capability behavior with zero migration steps (omitting the broker is that
//   path; this broker reproduces it for embedders that want an explicit value)
// @satisfies FR-W2-004 — neither the port nor this default references Keycloak/
//   Entra (no imports, no type names, no string literals)
// @satisfies SC-005 — byte-identical client resolution (same references)
// @satisfies SC-008 — mints nothing; zero token requests

import { ok } from "../types/result.js";
import type {
  CapabilityBroker,
  ScopedCapabilityHandle,
} from "../types/capability-broker.js";

/**
 * Build a pass-through broker over a fixed client set.
 *
 * `mintFor` resolves to `ok(clients)` for every invocation — the SAME object
 * reference it was given, so per-capability client references are preserved
 * exactly (`resolved.db === clients.db`). `inv` and `requires` are ignored:
 * today's behavior hands back the full configured set regardless of the
 * declared `requires` (validation of the declared set happens elsewhere, at the
 * `validateCapabilities` boundary).
 */
export const createPassthroughBroker = (
  clients: ScopedCapabilityHandle,
): CapabilityBroker => ({
  mintFor: (_inv, _requires) => Promise.resolve(ok(clients)),
});
