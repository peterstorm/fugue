/**
 * SecretsSource port — the seam that resolves an opaque `SecretsRef` to the
 * actual tenant secrets (AD-6, FR-031).
 *
 * ── The structural security property (FR-005, FR-006, SC-002) ─────────────────
 *
 * This module defines ONLY a type — a function contract. It constructs NOTHING.
 * That is deliberate and load-bearing:
 *
 *   - The registry (T3) stores a tenant's secrets as an OPAQUE `SecretsRef`
 *     (default adapter: a mounted per-tenant env-file PATH; future: a Vault
 *     key). A `SecretsRef` is a branded string (see `domain/tenant.ts`) that
 *     carries NO secret value — only a pointer the holder may or may not have
 *     the authority to dereference.
 *
 *   - The SUPERVISOR deals only in authentication, routing, and registry
 *     metadata (FR-005). It may hold a `SecretsRef` (it rides in registry
 *     metadata), but it MUST NOT hold a concrete `SecretsSource`. Holding a ref
 *     without a source is inert: a ref is just a string; dereferencing requires
 *     a concrete adapter that carries the real authority (filesystem read perm
 *     for the env-file adapter, a Vault token for a future Vault adapter). The
 *     supervisor does not import `env-file-secrets-source.ts` (or any concrete
 *     `SecretsSource`) — enforced by convention today, verified end-to-end in
 *     T11 — so no resolution path exists supervisor-side via this port: there is
 *     no code path from supervisor state to a *tenant env-file secret value via
 *     this port*, not even transiently (FR-006). This file's type is the ONLY
 *     thing the supervisor sees of this port, and a type cannot dereference
 *     anything.
 *
 *     SCOPE NOTE: this guarantee is about *tenant env-file secrets resolved
 *     through this port*. It is NOT a claim that NO secret ever materializes
 *     supervisor-side. The Redis ACL credential is a separate, deliberately
 *     transient supervisor-side mint+handoff: `redis-acl-provisioner.ts` mints a
 *     per-tenant ACL password on the supervisor's admin connection and the
 *     worker-lifecycle manager injects it into the owning worker's SPAWN ENV
 *     (`FUGUE_REDIS_ACL_USERNAME`/`PASSWORD`) — a SEPARATE channel from this
 *     `SecretsSource` port (see that file's CREDENTIAL HANDOFF CONTRACT). The two
 *     narratives are complementary, not contradictory — this port carries no value
 *     supervisor-side; the ACL mint is a bounded, unretained, never-logged handoff.
 *
 *   - The WORKER bootstrap (T6, a later wave) is the SOLE wiring site: it
 *     constructs a concrete `SecretsSource` and resolves the owning tenant's
 *     ref INSIDE the worker process (FR-031). Because construction lives only
 *     there, the secret value exists only in worker memory — the
 *     supervisor-secrets-absence guarantee (SC-002) holds by construction, not
 *     by convention.
 *
 * Keeping the port a pure type here (and the adapter in a separate file the
 * supervisor never imports) is what makes a Vault adapter droppable later
 * WITHOUT widening the supervisor's authority — exactly the rationale the
 * `AgentClientCredentials` port follows in
 * `packages/host/src/adapters/agent-client-credentials.ts`.
 *
 * @satisfies FR-005 — the supervisor does not import/construct a `SecretsSource` (convention today, verified e2e in T11); it holds only the inert `SecretsRef`.
 * @satisfies FR-006 — tenant env-file secrets resolve only inside the owning worker; no such value transits the supervisor via this port, even transiently.
 * @satisfies FR-031 — the per-tenant secrets source is referenced by registry metadata and resolved only within the owning worker.
 * @satisfies SC-002 — resolution requires a concrete adapter (filesystem/Vault authority) the supervisor structurally lacks.
 */

import type { Result } from "@fuguejs/framework";
import type { SecretsRef } from "../../domain/tenant.js";
import type { HostError } from "../../domain/host-error.js";

/**
 * The resolved secrets for a single tenant: a flat, immutable map of
 * `KEY → VALUE`. SENSITIVE — every VALUE is a tenant secret.
 *
 * Deliberately a bare `Readonly<Record<string, string>>` with no
 * logging-friendly wrapper: like `KeycloakClientCredential`, there is no custom
 * `toString`/`toJSON`, so an accidental string coercion of a wrapper does not
 * conveniently surface a value. Callers (the worker bootstrap, T6) MUST treat
 * this as opaque and MUST NEVER log its values — only key NAMES, if anything.
 */
export type ResolvedSecrets = Readonly<Record<string, string>>;

/**
 * Resolve an opaque `SecretsRef` to the actual tenant secrets.
 *
 * Fail-closed (FR-006): a missing, unreadable, or malformed source yields a
 * `HostError` Left — NEVER a partial or silently-empty map. A caller therefore
 * cannot mistake "no secrets resolved" for "this tenant has no secrets": the
 * only success is a fully-parsed map.
 *
 * Pure CONTRACT: the type names no concrete I/O. Each adapter (env-file today,
 * Vault later) supplies its own authority and is constructed only inside the
 * owning worker (T6) — never the supervisor. The port is the substitution seam
 * that makes a new adapter droppable without touching the supervisor.
 */
export type SecretsSource = (ref: SecretsRef) => Result<ResolvedSecrets, HostError>;
