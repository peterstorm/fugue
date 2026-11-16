/**
 * Tenant registry — PURE functional core (multi-tenant spec FR-024, FR-027, SC-009).
 *
 * This module is the runtime tenant registry's algebraic data model and its
 * total, pure, IDEMPOTENT transformations. It holds per-tenant CONFIG only — a
 * secrets *reference* (never a secret value, AD-6 / multi-tenant spec FR-005), the tenant's fs
 * root, its Keycloak client mapping, admission limits, and lifecycle metadata —
 * and it is mutated at runtime by `register` / `deregister` / `reconfigure`
 * (multi-tenant spec FR-024).
 *
 * STRICTLY NO I/O. No Redis, no clock, no `Date.now()`: every function receives
 * the data it needs (including `now`) as a parameter and returns a NEW immutable
 * `TenantRegistry`, never mutating its input. That keeps the core trivially
 * unit- and property-testable with plain data, and lets the Redis adapter
 * (`redis-registry-adapter.ts`, the imperative shell) own all persistence and
 * pub/sub. The shell calls these functions; the core never calls the shell.
 *
 * LIFECYCLE AS A DISCRIMINATED UNION (ADT, parse-don't-validate): a
 * `TenantConfig` is either an `ActiveTenantConfig` (`status:"active"`) or a
 * `DeregisteredTenantConfig` (`status:"deregistered"` + a `deregisteredAt`
 * instant). The tombstone lives ONLY on the deregistered variant, so an active
 * config carrying a `deregisteredAt` is not a representable value — the illegal
 * state is gone at the type level, not merely guarded at runtime. Every branch
 * uses `ts-pattern`'s exhaustive `match` on `status` instead of probing an
 * optional field.
 *
 * FAIL-CLOSED LOOKUP (multi-tenant spec FR-022): `lookup` returns first-class ABSENCE for an
 * unknown — or already-deregistered — tenant (`Result.err(tenantUnknown())`),
 * never a guessed or fabricated config. The supervisor turns that into a refusal
 * to start a NEW run; the Redis adapter additionally fails closed on infra loss
 * by routing through the existing `redisDied` degraded machine. A registry that
 * cannot positively confirm a tenant therefore NEVER routes on stale/guessed
 * config.
 *
 * IDEMPOTENCY (multi-tenant spec FR-027, SC-009): repeating an identical `register` or
 * `deregister` yields a STRUCTURALLY identical registry — same entries, same
 * `deregisteredAt` timestamps. `register` of an unchanged config is a no-op that
 * returns the SAME registry reference; `deregister` of an absent or
 * already-deregistered tenant is a no-op SUCCESS (not an error), and preserves
 * the original `deregisteredAt` so a retried deregister never bumps the
 * grace-window clock.
 */

import { posix } from "node:path";
import { match } from "ts-pattern";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { tenantUnknown, tenantConfigInvalid } from "../../domain/host-error.js";
import type { TenantId, SecretsRef } from "../../domain/tenant.js";
import type { Team } from "../../domain/auth.js";

// ── Per-tenant config value types ────────────────────────────────────────────

const VALIDATED_TENANT_CONFIG: unique symbol = Symbol("ValidatedTenantConfig");
type ValidatedTenantConfig = {
  readonly [VALIDATED_TENANT_CONFIG]: true;
};

/**
 * A tenant's Keycloak client mapping: the realm the tenant authenticates
 * against, the supervisor-facing OIDC client id used to resolve identities for
 * this tenant, and the per-DAG → agent-client-id mapping the worker uses when
 * minting downstream capability tokens (mirrors the existing
 * `AGENT_CLIENT_MAP` config shape, scoped per tenant). Held as plain,
 * already-validated data — this is config the registry carries, not a secret.
 */
interface KeycloakClientMapping {
  readonly realm: string;
  /** The supervisor-facing OIDC client id for resolving this tenant's identities. */
  readonly clientId: string;
  /** `dagId → real keycloak agent client id` for downstream token minting. */
  readonly agentClientIdsByDag: Readonly<Record<string, string>>;
}

/**
 * This tenant's OWN admission ceilings (multi-tenant spec FR-041 / SC-012 are enforced elsewhere;
 * the registry only carries the numbers). All counts are non-negative integers;
 * the smart constructor (`tenantConfig`) is the parse boundary that guarantees
 * that, so downstream code can treat these as already-valid.
 */
interface TenantLimits {
  /** Max concurrently-running runs admitted for this tenant. */
  readonly maxConcurrentRuns: number;
  /** Max queued (pending-admission) runs for this tenant. */
  readonly maxQueuedRuns: number;
}

/**
 * The lifecycle-independent fields of a tenant's configuration record (multi-tenant spec FR-024).
 *
 * `secretsRef` is the branded `SecretsRef` — a REFERENCE only. The registry (and
 * the supervisor that holds it) never carries a secret VALUE; dereferencing is
 * the worker's job via its `SecretsSource` (AD-6, multi-tenant spec FR-005). The type system keeps
 * "reference" and "secret" disjoint, so a registry entry can never be a secret.
 */
export interface TenantConfigBase {
  readonly id: TenantId;
  readonly team: Team;
  readonly keycloakClientMapping: KeycloakClientMapping;
  readonly fsRoot: string;
  /**
   * The per-tenant DAG root the worker discovers graphs under (multi-tenant spec FR-002). Injected
   * into the worker's spawn env as `DAGS_LOCAL_PATH`, so the worker runs the
   * LocalGitAdapter rooted HERE and globs `dags/**​/dag.ts` under it alone.
   *
   * This is the load-bearing fix for the multi-tenant DAG-isolation boundary
   * (ADR-0061 / team-security-and-capabilities.md §2): a single multi-tenant pod
   * serves many teams, and EACH tenant's worker must see ONLY its own team's DAG
   * code/prompts at rest — not the whole baked tree. Each per-team baked
   * `fugue-dags-<team>` image is staged by an initContainer into a DISTINCT
   * subdir (e.g. `/dags/<tenant>`), and that subdir is this tenant's `dagsRoot`.
   * Like `fsRoot`, it is parsed into this tenant's platform-owned subtree.
   */
  readonly dagsRoot: string;
  readonly secretsRef: SecretsRef;
  readonly admission: TenantLimits;
  readonly eagerPin: boolean;
}

/**
 * An ACTIVE tenant: registered and resolvable. The `status` discriminant carries
 * no tombstone — the type itself forbids a `deregisteredAt` here, so "an active
 * config carrying a deregistration instant" is not a representable value.
 */
export type ActiveTenantConfig = TenantConfigBase & ValidatedTenantConfig & {
  readonly status: "active";
};

/**
 * A DEREGISTERED-but-RETAINED tenant. The entry is kept (not purged) so the
 * supervisor can fail-closed-reject NEW runs for it while in-flight work drains
 * (the supervisor worker-lifecycle's concern); the grace-window purge later
 * RECLAIMS the on-disk/registry footprint once the window elapses.
 * `deregisteredAt` is REQUIRED on this variant — the deregistered state always
 * carries its instant.
 */
export type DeregisteredTenantConfig = TenantConfigBase & ValidatedTenantConfig & {
  readonly status: "deregistered";
  readonly deregisteredAt: number;
};

/**
 * The full per-tenant configuration record — a discriminated union on `status`.
 * Illegal states (active+tombstone, deregistered-without-instant) are
 * unrepresentable; every consumer matches exhaustively on `status`.
 */
export type TenantConfig = ActiveTenantConfig | DeregisteredTenantConfig;

// ── Registry ADT ─────────────────────────────────────────────────────────────

/**
 * The runtime tenant registry: an immutable map from `TenantId` to its
 * `TenantConfig`. Wrapped in a nominal-ish record (rather than exposing a bare
 * `Map`) so callers go through the pure transformations and cannot mutate
 * entries in place. Entries INCLUDE deregistered-but-retained tenants; `lookup`
 * is what enforces that a deregistered tenant no longer resolves.
 */
export interface TenantRegistry {
  readonly entries: ReadonlyMap<TenantId, TenantConfig>;
}

/**
 * Copy entries behind a frozen read-only facade. Unlike a `Map` merely typed as
 * `ReadonlyMap`, the exposed value has no runtime mutation methods, so a cast
 * cannot bypass the registry transitions or team-uniqueness invariant.
 */
const snapshotTenantConfig = (config: TenantConfig): TenantConfig => {
  if (
    Object.isFrozen(config) &&
    Object.isFrozen(config.admission) &&
    Object.isFrozen(config.keycloakClientMapping) &&
    Object.isFrozen(config.keycloakClientMapping.agentClientIdsByDag)
  ) {
    return config;
  }
  return Object.freeze({
    ...config,
    admission: Object.freeze({ ...config.admission }),
    keycloakClientMapping: Object.freeze({
      ...config.keycloakClientMapping,
      agentClientIdsByDag: Object.freeze({
        ...config.keycloakClientMapping.agentClientIdsByDag,
      }),
    }),
  });
};

const registryWithEntries = (
  entries: ReadonlyMap<TenantId, TenantConfig> = new Map(),
): TenantRegistry => {
  const snapshot = new Map(
    Array.from(entries, ([id, config]) => [id, snapshotTenantConfig(config)] as const),
  );
  let view: ReadonlyMap<TenantId, TenantConfig>;
  const facade = {
    get size(): number { return snapshot.size; },
    get: (key: TenantId): TenantConfig | undefined => snapshot.get(key),
    has: (key: TenantId): boolean => snapshot.has(key),
    entries: (): MapIterator<[TenantId, TenantConfig]> => snapshot.entries(),
    keys: (): MapIterator<TenantId> => snapshot.keys(),
    values: (): MapIterator<TenantConfig> => snapshot.values(),
    [Symbol.iterator]: (): MapIterator<[TenantId, TenantConfig]> => snapshot[Symbol.iterator](),
    forEach(
      callback: (value: TenantConfig, key: TenantId, map: ReadonlyMap<TenantId, TenantConfig>) => void,
      thisArg?: unknown,
    ): void {
      for (const [key, value] of snapshot) callback.call(thisArg, value, key, view);
    },
  } satisfies ReadonlyMap<TenantId, TenantConfig>;
  view = Object.freeze(facade);
  return Object.freeze({ entries: view });
};

/**
 * The empty registry — the boot-time starting point before any sync. A FRESH
 * instance per call (mirrors `domain/registry.ts`'s `emptyRegistry`): a shared
 * singleton exposing a `ReadonlyMap` is only readonly at compile time, so a
 * `(emptyRegistry.entries as Map).set(...)` cast could corrupt a value reused
 * across every boot/test. Returning a new frozen record each call removes that
 * shared state entirely.
 */
export const emptyRegistry = (): TenantRegistry => registryWithEntries();

/**
 * Parse a seed of configs into a registry. Used by the adapter when hydrating
 * from Redis on startup, and by tests. Duplicate ids remain last-writer-wins (a
 * seed artifact), then the complete retained snapshot is checked before it is
 * exposed: two distinct ACTIVE tenants may never own the same team. Returning a
 * `Result` makes the security-critical team-routing invariant part of registry
 * construction instead of a convention enforced only by live mutations.
 */
export const registryOf = (
  seed: readonly TenantConfig[] = [],
): Result<TenantRegistry, HostError> => {
  const entries = new Map<TenantId, TenantConfig>();
  for (const cfg of seed) entries.set(cfg.id, cfg);

  const activeOwnerByTeam = new Map<Team, TenantId>();
  for (const cfg of entries.values()) {
    if (cfg.status === "deregistered") continue;
    const owner = activeOwnerByTeam.get(cfg.team);
    if (owner !== undefined && owner !== cfg.id) {
      return err({
        kind: "config-invalid",
        message: `persisted tenant registry assigns team '${cfg.team}' to active tenants '${owner}' and '${cfg.id}'`,
      });
    }
    activeOwnerByTeam.set(cfg.team, cfg.id);
  }

  return ok(registryWithEntries(entries));
};

/**
 * A canonical path owned by one tenant. The fixed platform roots are deliberate:
 * `fsRoot` is recursively deleted during purge and `dagsRoot` is executable-code
 * authority, so syntax-only "absolute" validation is insufficient. A tenant may
 * name its root or a descendant, but never `/`, a host path, or another tenant's
 * subtree. `posix.normalize(path) === path` rejects aliases (`..`, `.`, `//`)
 * before prefix comparison.
 */
const isTenantOwnedPath = (
  path: string,
  platformRoot: "/srv" | "/dags",
  id: TenantId,
): boolean => {
  if (path.includes("\0") || posix.normalize(path) !== path) return false;
  const tenantRoot = `${platformRoot}/${id}`;
  return path === tenantRoot || path.startsWith(`${tenantRoot}/`);
};

// ── Smart constructor (parse-don't-validate) ────────────────────────────────

/**
 * The invariant a `TenantConfigBase` violates — the typed error of
 * `parseTenantConfig`. One variant per invariant, so a caller can tell the
 * faults apart without reading a message string; `describeTenantConfigFault`
 * is the one rendering of each.
 */
export type TenantConfigFault =
  | { readonly kind: "empty-team" }
  | { readonly kind: "empty-fs-root" }
  | { readonly kind: "fs-root-not-tenant-owned" }
  | { readonly kind: "empty-dags-root" }
  | { readonly kind: "dags-root-not-tenant-owned" }
  | { readonly kind: "empty-keycloak-client" }
  | { readonly kind: "empty-agent-client-id"; readonly dagId: string }
  | { readonly kind: "invalid-admission-limits" };

type Parsed<T> = Result<T, TenantConfigFault>;

/**
 * A tenant-owned root: non-empty, then inside `<platformRoot>/<id>`.
 * `fsRoot` is the recursive purge target and `dagsRoot` becomes
 * `DAGS_LOCAL_PATH` (code-loading authority), so both are parsed into the
 * tenant's own platform subtree — host paths and sibling tenants' subtrees are
 * not representable after registration.
 */
const parseOwnedRoot = (
  path: string,
  platformRoot: "/srv" | "/dags",
  id: TenantId,
  faults: { readonly empty: TenantConfigFault; readonly notOwned: TenantConfigFault },
): Parsed<string> => {
  if (path.length === 0) return err(faults.empty);
  return isTenantOwnedPath(path, platformRoot, id) ? ok(path) : err(faults.notOwned);
};

/**
 * A detached copy of the Keycloak mapping with a non-empty realm/clientId and
 * non-empty per-DAG agent-client ids — the same invariant the env-side
 * `AGENT_CLIENT_MAP` enforces (`domain/config.ts`, `z.string().min(1)`), carried
 * here so the registration/hydration boundary rejects `""` before the
 * worker-side minting consumer can see a blank client id.
 */
const parseKeycloakClientMapping = (mapping: KeycloakClientMapping): Parsed<KeycloakClientMapping> => {
  if (mapping.realm.length === 0 || mapping.clientId.length === 0) {
    return err({ kind: "empty-keycloak-client" });
  }
  for (const [dagId, clientId] of Object.entries(mapping.agentClientIdsByDag)) {
    if (clientId.length === 0) return err({ kind: "empty-agent-client-id", dagId });
  }
  return ok({
    realm: mapping.realm,
    clientId: mapping.clientId,
    agentClientIdsByDag: { ...mapping.agentClientIdsByDag },
  });
};

const isCount = (n: number): boolean => Number.isInteger(n) && n >= 0;

/** A detached copy of the admission ceilings, both non-negative integers. */
const parseTenantLimits = ({ maxConcurrentRuns, maxQueuedRuns }: TenantLimits): Parsed<TenantLimits> =>
  isCount(maxConcurrentRuns) && isCount(maxQueuedRuns)
    ? ok({ maxConcurrentRuns, maxQueuedRuns })
    : err({ kind: "invalid-admission-limits" });

/**
 * The pure parse of a `TenantConfigBase` into an `ActiveTenantConfig`, or the
 * FIRST invariant it violates. Fields are parsed in a fixed order (team, fsRoot,
 * dagsRoot, Keycloak mapping, admission) so the reported fault is
 * deterministic; each parsed piece is the value the config is built from.
 */
export const parseTenantConfig = (input: TenantConfigBase): Parsed<ActiveTenantConfig> => {
  if (input.team.length === 0) return err({ kind: "empty-team" });
  const fsRoot = parseOwnedRoot(input.fsRoot, "/srv", input.id, {
    empty: { kind: "empty-fs-root" },
    notOwned: { kind: "fs-root-not-tenant-owned" },
  });
  if (!fsRoot.ok) return fsRoot;
  const dagsRoot = parseOwnedRoot(input.dagsRoot, "/dags", input.id, {
    empty: { kind: "empty-dags-root" },
    notOwned: { kind: "dags-root-not-tenant-owned" },
  });
  if (!dagsRoot.ok) return dagsRoot;
  const keycloakClientMapping = parseKeycloakClientMapping(input.keycloakClientMapping);
  if (!keycloakClientMapping.ok) return keycloakClientMapping;
  const admission = parseTenantLimits(input.admission);
  if (!admission.ok) return admission;
  return ok({
    [VALIDATED_TENANT_CONFIG]: true,
    status: "active",
    id: input.id,
    team: input.team,
    keycloakClientMapping: keycloakClientMapping.value,
    fsRoot: fsRoot.value,
    dagsRoot: dagsRoot.value,
    secretsRef: input.secretsRef,
    admission: admission.value,
    eagerPin: input.eagerPin,
  });
};

/** The operator-facing rendering of a fault for tenant `id`. */
export const describeTenantConfigFault = (fault: TenantConfigFault, id: TenantId): string =>
  match(fault)
    .with({ kind: "empty-team" }, () => "team must be non-empty")
    .with({ kind: "empty-fs-root" }, () => "fsRoot must be non-empty")
    .with({ kind: "fs-root-not-tenant-owned" }, () => `fsRoot must be '/srv/${id}' or a canonical descendant`)
    .with({ kind: "empty-dags-root" }, () => "dagsRoot must be non-empty")
    .with({ kind: "dags-root-not-tenant-owned" }, () => `dagsRoot must be '/dags/${id}' or a canonical descendant`)
    .with({ kind: "empty-keycloak-client" }, () => "keycloak realm and clientId must be non-empty")
    .with({ kind: "empty-agent-client-id" }, ({ dagId }) => `agentClientIdsByDag['${dagId}'] must be a non-empty client id`)
    .with({ kind: "invalid-admission-limits" }, () => "admission limits must be non-negative integers")
    .exhaustive();

/**
 * The parse boundary for a `TenantConfig`, in `HostError` terms. Produces an
 * ACTIVE config (`status:"active"`): a smart constructor builds the resolvable
 * state, and deregistration is a TRANSITION (`deregister`), not a constructor
 * input — so there is nothing to strip, the active variant simply cannot carry
 * a tombstone.
 *
 * The `id` and `secretsRef` arrive already branded (their own smart constructors
 * `tenantId` / `markSecretsRef` are the seams that validate/brand them);
 * `parseTenantConfig` parses the remaining invariants:
 *   - non-empty team and tenant-owned canonical fsRoot/dagsRoot paths,
 *   - non-negative INTEGER admission limits,
 *   - a non-empty realm/clientId and non-empty per-DAG agent client ids.
 * A fault maps to `config-invalid` naming the tenant. Returns `Result` (never
 * throws) since configs arrive from registration data.
 */
export const tenantConfig = (input: TenantConfigBase): Result<ActiveTenantConfig, HostError> => {
  const parsed = parseTenantConfig(input);
  return parsed.ok
    ? parsed
    : err({ kind: "config-invalid", message: `tenant '${input.id}': ${describeTenantConfigFault(parsed.error, input.id)}` });
};

// ── Structural equality (drives idempotency) ─────────────────────────────────

/**
 * Deep structural equality for the config fields that define a tenant's
 * identity-config, INCLUDING the lifecycle discriminant + tombstone. This is what
 * makes `register`/`reconfigure` idempotent: a re-apply of a structurally
 * identical config is a no-op (same-reference return, multi-tenant spec FR-027 / SC-009).
 */
const sameLifecycle = (a: TenantConfig, b: TenantConfig): boolean =>
  match<[TenantConfig, TenantConfig]>([a, b])
    .with([{ status: "active" }, { status: "active" }], () => true)
    .with(
      [{ status: "deregistered" }, { status: "deregistered" }],
      ([left, right]) => left.deregisteredAt === right.deregisteredAt,
    )
    .otherwise(() => false);

const configEquals = (a: TenantConfig, b: TenantConfig): boolean =>
  sameLifecycle(a, b) &&
  a.id === b.id &&
  a.team === b.team &&
  a.fsRoot === b.fsRoot &&
  a.dagsRoot === b.dagsRoot &&
  a.secretsRef === b.secretsRef &&
  a.eagerPin === b.eagerPin &&
  a.admission.maxConcurrentRuns === b.admission.maxConcurrentRuns &&
  a.admission.maxQueuedRuns === b.admission.maxQueuedRuns &&
  a.keycloakClientMapping.realm === b.keycloakClientMapping.realm &&
  a.keycloakClientMapping.clientId === b.keycloakClientMapping.clientId &&
  agentMapEquals(a.keycloakClientMapping.agentClientIdsByDag, b.keycloakClientMapping.agentClientIdsByDag);

const agentMapEquals = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  }
  return true;
};

/** Insert/replace an entry, returning a new registry (input never mutated). */
const withEntry = (registry: TenantRegistry, cfg: TenantConfig): TenantRegistry => {
  const next = new Map(registry.entries);
  next.set(cfg.id, cfg);
  return registryWithEntries(next);
};

/**
 * Remove a retained entry entirely, rebuilding the same runtime-read-only facade
 * as every other registry transition. Absent removal is an idempotent no-op.
 */
export const removeRetainedEntry = (
  registry: TenantRegistry,
  id: TenantId,
): TenantRegistry => {
  if (!registry.entries.has(id)) return registry;
  const next = new Map(registry.entries);
  next.delete(id);
  return registryWithEntries(next);
};

/**
 * The id of a DIFFERENT active tenant that already owns `team`, or `undefined`
 * if the team is free. team→tenant is 1:1 (ADR-0064/0068 — the supervisor +
 * tenant-registry decision): the supervisor's
 * team→tenant routing index is security-load-bearing and resolves a team token
 * by registry order, so two active tenants sharing a team would route that
 * token NONDETERMINISTICALLY (first-writer-wins, silently denying the other).
 * The registration boundary enforces the 1:1 invariant here so the index can
 * never face an ambiguous team. A DEREGISTERED tenant holding the team does not
 * block reuse — only active owners count (so deregister-then-register a fresh
 * tenant on the same team is allowed).
 */
const teamOwnedByOther = (
  registry: TenantRegistry,
  team: Team,
  selfId: TenantId,
): TenantId | undefined => {
  for (const cfg of activeTenants(registry)) {
    if (cfg.team === team && cfg.id !== selfId) return cfg.id;
  }
  return undefined;
};

// ── Transitions (pure, total, idempotent) ────────────────────────────────────

/**
 * Register (or re-register) a tenant (multi-tenant spec FR-024, FR-027, SC-009).
 *
 * Always lands the config in its ACTIVE shape — the `cfg` argument is an
 * `ActiveTenantConfig` by construction (the union forbids passing a tombstone
 * through register), so a register can never persist a deregistered state.
 *
 * IDEMPOTENT: if an entry with the same id and a STRUCTURALLY identical config
 * already exists, this is a no-op and returns the SAME registry reference — so
 * repeating an identical register produces an identical end state (multi-tenant spec SC-009). A
 * register of a previously-deregistered tenant REVIVES it: registration is the
 * canonical way to bring a tenant back.
 *
 * `now` is accepted for signature symmetry with `deregister`/`reconfigure` and
 * future audit needs; register itself stamps no timestamp.
 */
export const register = (
  registry: TenantRegistry,
  cfg: ActiveTenantConfig,
  _now: number,
): Result<TenantRegistry, HostError> => {
  const existing = registry.entries.get(cfg.id);
  if (existing !== undefined && configEquals(existing, cfg)) {
    // No-op: identical end state. Return the same reference (multi-tenant spec SC-009).
    return ok(registry);
  }
  // Enforce team↔tenant 1:1 (fail-closed) so the supervisor's team→tenant routing
  // index is never ambiguous. A re-register of THIS same tenant (selfId) never
  // conflicts with itself.
  const conflict = teamOwnedByOther(registry, cfg.team, cfg.id);
  if (conflict !== undefined) {
    // A team conflict is a CALLER error (a bad register body), not a host
    // config-LOAD fault: `tenant-config-invalid` → 400, never `config-invalid` → 500.
    return err(tenantConfigInvalid(`tenant '${cfg.id}': team '${cfg.team}' is already owned by active tenant '${conflict}'`));
  }
  return ok(withEntry(registry, cfg));
};

/**
 * Deregister a tenant (multi-tenant spec FR-024, FR-027, SC-009).
 *
 * Transitions the entry to the `DeregisteredTenantConfig` variant
 * (`status:"deregistered"`, `deregisteredAt = now`) and RETAINS it
 * (deregistered-then-retained state) so already-running workers keep serving
 * in-flight work; the grace-window purge later RECLAIMS the footprint once the
 * window elapses — the registry never hard-deletes here.
 *
 * IDEMPOTENT + total: deregistering an ABSENT tenant is a no-op SUCCESS (returns
 * the same registry, NOT an error). Deregistering an ALREADY-deregistered tenant
 * preserves the ORIGINAL `deregisteredAt` and returns the same registry — a
 * retried deregister never bumps the grace-window clock, so repeating it yields
 * an identical end state (multi-tenant spec SC-009).
 */
export const deregister = (
  registry: TenantRegistry,
  id: TenantId,
  now: number,
): Result<TenantRegistry, HostError> => {
  const existing = registry.entries.get(id);
  if (existing === undefined) {
    // Absent → no-op success (idempotent, never an error).
    return ok(registry);
  }
  return match(existing)
    .returnType<Result<TenantRegistry, HostError>>()
    .with({ status: "deregistered" }, () =>
      // Already deregistered → preserve the original instant; no-op.
      ok(registry),
    )
    .with({ status: "active" }, (active) => {
      const tombstoned: DeregisteredTenantConfig = {
        ...active,
        status: "deregistered",
        deregisteredAt: now,
      };
      return ok(withEntry(registry, tombstoned));
    })
    .exhaustive();
};

/**
 * Reconfigure a registered, ACTIVE tenant (multi-tenant spec FR-024).
 *
 * Replaces the config in place (immutably). Per AD-5 the new config takes effect
 * on the tenant's NEXT worker spawn — this function ONLY updates registry state;
 * it does NOT drain/respawn or hot-swap a running worker (that orchestration is
 * the supervisor's, applied on next spawn). Reconfiguring an unknown OR
 * deregistered tenant fails closed with `tenant-unknown` (you cannot reconfigure
 * what does not actively exist — never resurrect via reconfigure; use register).
 *
 * The `cfg` argument is an `ActiveTenantConfig` by construction, so the result
 * is always active — a reconfigure can never carry a tombstone in.
 *
 * IDEMPOTENT: reconfiguring with the structurally identical config is a no-op
 * that returns the same registry reference.
 */
export const reconfigure = (
  registry: TenantRegistry,
  cfg: ActiveTenantConfig,
  _now: number,
): Result<TenantRegistry, HostError> => {
  const existing = registry.entries.get(cfg.id);
  if (existing === undefined) {
    return err(tenantUnknown());
  }
  return match(existing)
    .returnType<Result<TenantRegistry, HostError>>()
    .with({ status: "deregistered" }, () =>
      // Never resurrect a deregistered tenant via reconfigure — fail closed.
      err(tenantUnknown()),
    )
    .with({ status: "active" }, (active) => {
      if (configEquals(active, cfg)) return ok(registry);
      // A reconfigure that MOVES this tenant onto a team owned by a different
      // active tenant would break the 1:1 routing invariant — fail closed.
      const conflict = teamOwnedByOther(registry, cfg.team, cfg.id);
      if (conflict !== undefined) {
        // Caller error (a bad reconfigure body), not a host config-LOAD fault:
        // `tenant-config-invalid` → 400, never `config-invalid` → 500.
        return err(tenantConfigInvalid(`tenant '${cfg.id}': team '${cfg.team}' is already owned by active tenant '${conflict}'`));
      }
      return ok(withEntry(registry, cfg));
    })
    .exhaustive();
};

// ── Queries (fail-closed) ────────────────────────────────────────────────────

/**
 * Resolve a tenant's ACTIVE config (multi-tenant spec FR-022 fail-closed).
 *
 * Returns `Result.err(tenantUnknown())` for an unknown OR a
 * deregistered-but-retained tenant — never a guessed config, never the retained
 * tombstone. A deregistered tenant resolves as unknown so the supervisor refuses
 * NEW runs for it while in-flight work continues against the retained entry.
 */
export const lookup = (
  registry: TenantRegistry,
  id: TenantId,
): Result<ActiveTenantConfig, HostError> => {
  const cfg = registry.entries.get(id);
  if (cfg === undefined) {
    return err(tenantUnknown());
  }
  return match(cfg)
    .returnType<Result<ActiveTenantConfig, HostError>>()
    .with({ status: "active" }, (active) => ok(active))
    .with({ status: "deregistered" }, () => err(tenantUnknown()))
    .exhaustive();
};

/**
 * The RAW retained entry for a tenant, including a deregistered tombstone, or
 * `undefined` if never registered. Used by the grace-window purge and by
 * the supervisor's in-flight-drain logic, which legitimately needs to see a
 * deregistered entry that `lookup` deliberately hides.
 */
export const retainedEntry = (
  registry: TenantRegistry,
  id: TenantId,
): TenantConfig | undefined => registry.entries.get(id);

/** All ACTIVE (non-deregistered) tenant configs. */
export const activeTenants = (registry: TenantRegistry): readonly ActiveTenantConfig[] =>
  Array.from(registry.entries.values()).filter(
    (c): c is ActiveTenantConfig => c.status === "active",
  );

/** Whether a tenant resolves to an active config (mirrors `lookup` success). */
export const isActive = (registry: TenantRegistry, id: TenantId): boolean => {
  const cfg = registry.entries.get(id);
  return cfg !== undefined && cfg.status === "active";
};
