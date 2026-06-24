# ADR-0069: Per-tenant secrets — spawn-time env from a non-dereferenceable reference, behind a `SecretsSource` port

## Status

Accepted

## Date

2026-06-19

## Context

The multi-tenant single-host refactor (ADR-0064) splits today's "one process =
one tenant" host into a **supervisor** that owns the single public listener and
routes each request to a per-tenant **worker** (`createHost` bound to exactly one
tenant). The OS process boundary is the isolation mechanism, and the central
security premise (US2) is that a hostile, compromised, or RCE'd worker can reach
*zero bytes* of another tenant's material — and, just as load-bearing, that the
supervisor itself is **not** a place where tenant secrets accumulate.

That second half is a hard requirement, not an aspiration. FR-005 states the
supervisor MUST hold zero tenant secrets at any time, dealing only in
authentication, routing, and registry metadata. FR-006 strengthens it: tenant
secrets MUST NOT transit the supervisor process *even transiently*. SC-002 makes
it falsifiable — inspection of supervisor memory/state across its whole lifetime
must reveal zero tenant secrets, asserted by a dedicated test. The spec's own
risk register names the failure mode this guards against: "Supervisor becomes a
secrets choke point and a high-value target."

The forces in tension: a worker self-evidently *needs* its tenant's secrets
(LLM API keys, the per-tenant Redis ACL credential from ADR-0067, etc.) to run;
the registry — read and written supervisor-side — is the natural place to record
*per-tenant configuration*; yet the registry's owner (the supervisor) must never
be able to turn that configuration into actual secret material. The open question
this ADR settles is FR-031 (deferred from the spec to architecture): **what does
the registry store for a tenant's secrets, and which process — by what
authority — turns it into the real values?** The answer must make
"supervisor holds zero secrets" true by *construction*, so the SC-002 inspection
test cannot fail no matter how the supervisor evolves — not by a convention a
future edit could quietly break.

## Options Considered

1. **Registry stores a non-dereferenceable `SecretsRef`; the worker — and only
   the worker — resolves it at spawn via a `SecretsSource` port (chosen).**
   - Pros: realizes FR-005/FR-006/SC-002 **structurally**. The registry holds an
     opaque branded reference (a path/key pointer), never a value; dereferencing
     requires a concrete adapter that carries real authority (filesystem read
     permission for the env-file adapter, a Vault token later). The supervisor
     imports no concrete `SecretsSource`, so there is *no code path* from
     supervisor state to a tenant secret value via this port — not even
     transiently. A future Vault adapter drops in behind the same port without
     widening the supervisor's authority, mirroring the `AgentClientCredentials`
     port rationale (ADR-0056). The brand keeps "reference" and "secret"
     disjoint in the type system. The worker is the only process holding *both*
     the reference and the authority.
   - Cons: a new port + adapter seam to maintain; the supervisor↛`SecretsSource`
     non-import is a structural property that must be guarded by a test rather
     than enforced by the compiler (TypeScript cannot forbid an import); the
     ref's *availability* to the worker (e.g. a per-tenant env-file mount) is now
     a deployment responsibility outside the type system.

2. **Supervisor reads the secrets and injects them into the worker's spawn env.**
   - Pros: simplest data flow — the supervisor already builds the spawn spec, so
     it could read each tenant's secrets and pass them down directly; one process
     touches the source of truth.
   - Cons: makes the supervisor a **secrets choke point and a high-value
     target** — the exact risk the spec's risk register calls out. It directly
     violates FR-005 (supervisor would hold every tenant's secrets) and FR-006
     (they would transit the supervisor), and the SC-002 inspection test would
     find them. One supervisor compromise becomes every tenant's compromise —
     the antithesis of US2.

3. **Encrypted secrets blob in the registry, decryptable by the supervisor.**
   - Pros: keeps secrets "at rest" inside the registry the supervisor already
     manages; no separate per-tenant mount.
   - Cons: the supervisor must hold the decryption key to make the blob useful at
     spawn — and *supervisor holds the decryption key = supervisor holds the
     secret*. The plaintext materializes supervisor-side at decrypt time,
     violating FR-005/FR-006/SC-002 identically to option 2, merely later in the
     pipeline.

4. **Bake each tenant's secrets into the worker image at build time.**
   - Pros: no runtime secret resolution at all; the worker has its secrets the
     moment it boots.
   - Cons: no runtime onboarding (a new tenant requires a fresh image build and
     redeploy, defeating the registry-driven onboarding US2/US3 assume); painful
     rotation (every rotation is an image rebuild); and secrets baked into a
     layer leak through image distribution and registry caches. Incompatible with
     the dynamic per-tenant lifecycle (ADR-0064).

There was a genuine choice here — options 2–4 are all workable secret-delivery
schemes — so this is not a forced decision. It is a deliberate placement of the
*dereference authority* so the supervisor structurally cannot exercise it.

## Decision

**The supervisor holds ZERO tenant secrets. The tenant registry stores only a
non-dereferenceable `SecretsRef` (a branded pointer, not the secret). At worker
spawn time the worker — and only the worker — resolves that ref into actual
secrets via a `SecretsSource` port (default: a per-tenant env-file adapter) and
injects them as process env. The supervisor imports no concrete `SecretsSource`,
so it structurally cannot dereference a ref.**

Concrete shape in code:

- **The reference is a branded, value-free pointer.**
  `SecretsRef = string & { readonly [__secretsRefBrand]: void }` in
  `packages/host/src/domain/tenant.ts`. Its sole producer is `markSecretsRef`,
  the single greppable seam where a raw string becomes a `SecretsRef`. The brand
  keeps "reference" and "resolved secret" type-disjoint: a `SecretsRef` can never
  be passed where a `ResolvedSecrets` value is required, nor coerced from one.
  Branding a string grants the holder **no** dereference authority.

- **The port is a pure type — it constructs nothing.**
  `SecretsSource = (ref: SecretsRef) => Result<ResolvedSecrets, HostError>` in
  `packages/host/src/supervisor/secrets/secrets-source.ts`. This module defines
  only the contract; the type is the *only* thing the supervisor ever sees of the
  port, and a type cannot dereference anything. `ResolvedSecrets` is a bare
  `Readonly<Record<string, string>>` with no `toString`/`toJSON`, so an
  accidental coercion does not conveniently surface a value.

- **The default adapter carries the authority, and lives in a module the
  supervisor never imports.**
  `createEnvFileSecretsSource()` in
  `packages/host/src/supervisor/secrets/env-file-secrets-source.ts` interprets a
  `SecretsRef` as a mounted per-tenant env-file path, reads and parses it, and
  fails **closed** on any problem — missing/unreadable file, malformed line,
  duplicate key — never a partial or silently-empty map. It never logs a secret
  value (only the ref/path, a key name, or a line number). A future Vault adapter
  drops in behind the same port with no caller change.

- **Resolution happens only inside the owning worker, at spawn.**
  The worker entrypoint `packages/host/src/worker-main.ts` constructs the
  env-file `SecretsSource` *in its own `main`* — the sole site that carries
  filesystem-read authority — and the pure planner `buildWorkerBootstrap(env,
  secrets)` resolves the ref, merges the resolved secrets over the worker's base
  env, and `parseHostConfig`s the union. Defense-in-depth: the bootstrap
  re-asserts that the resolved config's `TENANT_ID` matches the env-bound tenant,
  so a secrets file can never rebind the worker to a different tenant.

Key invariants:

- **Ref ≠ secret.** The registry and every `WorkerSpawnSpec` carry only the
  branded `SecretsRef`; the actual secret bytes exist nowhere supervisor-side.
- **Resolution only inside the owning worker.** A concrete `SecretsSource` is
  constructed exactly once, in `worker-main.ts`'s `main`. The secret value
  therefore exists only in that one worker's memory.
- **Supervisor zero-secrets, enforced structurally.** No supervisor module
  imports a concrete `SecretsSource` (or names `createEnvFileSecretsSource`).
  This is asserted, not trusted: the supervisor-secrets-absence test
  `packages/host/src/__tests__/integration/isolation-supervisor-secrets.test.ts`
  reads the actual supervisor sources (`supervisor.ts`, `routing.ts`,
  `uds-proxy.ts`, `admission.ts`, `main-supervisor.ts`) and asserts none contains
  `secrets-source` / `env-file-secrets` / `createEnvFileSecretsSource`, proving
  no `SupervisorDeps`-reachable dereference path exists (SC-002, NFR-011). It also
  drives the real lifecycle, sweeps every spawn spec, and asserts each carries
  only a `vault://`-style ref and **never** the actual secret bytes, and that a
  `SecretsRef` fed to the env-file source for a non-existent path fails closed
  with zero secret bytes.
- **ACL credential handoff is a distinct channel — the spawn env, NOT this port.**
  The per-tenant Redis ACL credential (ADR-0067) is the *one* secret deliberately
  minted supervisor-side, but it is never *retained*: `apply` mints it on the admin
  connection and the worker-lifecycle manager injects it into the owning worker's
  **spawn env** (`FUGUE_REDIS_ACL_USERNAME`/`PASSWORD`), keeping no copy. (This is
  separate from the `SecretsSource` port, which resolves a `vault://`-style
  `SecretsRef` to env-file bytes *inside* the worker — the ACL credential does not
  transit that port.) That bounded, unretained, never-logged handoff
  is complementary to — not a violation of — the zero-secrets guarantee, which is
  scoped to *tenant env-file secrets resolved through this port*; the same
  isolation test asserts the minted password materializes only as a transient
  `>password` SETUSER token and is retained on no long-lived supervisor handle.
  (Status, 2026-06-19: this handoff is WIRED behind `SUPERVISOR_REDIS_ACL_ENABLED`
  — see ADR-0067's Implementation-status note. With the flag on, `apply` mints the
  credential at worker spawn and it is handed into the owning worker via the spawn
  env; with the flag off it is not minted. The `SecretsSource` port and its
  non-dereferenceability guarantee are the live design for tenant env-file secrets
  in both cases.)

## Consequences

**Positive:**

- FR-005/FR-006/SC-002/NFR-011 hold by **construction**, not convention: the
  supervisor cannot dereference a ref because it imports no concrete
  `SecretsSource`, and the type system keeps ref and secret disjoint. The
  supervisor-secrets-absence test makes any future regression (an accidental
  supervisor import of a dereferencer) a red test, not a silent compromise.
- The "secrets choke point" risk the spec calls out is structurally eliminated —
  a supervisor compromise yields opaque pointers, not tenant secrets, so one
  tenant's breach cannot cascade into another's (US2).
- The worker is the sole process holding both the reference and the authority, so
  the resolved secret exists only in that one worker's memory — directly
  satisfying the per-worker single-tenant inspection scenarios (SC-003).
- The `SecretsSource` port makes a Vault (or other) adapter droppable later
  *without* widening the supervisor's authority, exactly mirroring the
  `AgentClientCredentials` port (ADR-0056).
- Config and secrets stay cleanly separated: non-secret config is parsed via Zod
  at the config boundary (ADR-0042), while secret *values* arrive only through
  this port and are merged into env at worker spawn — the two never blur.

**Negative:**

- The "supervisor imports no concrete `SecretsSource`" guarantee cannot be
  expressed in the type system (TypeScript has no "this module may not import
  X"); it rests on the isolation test reading supervisor sources. If a new
  supervisor source file is added, the test's source list must be extended or the
  guard silently stops covering it — a maintenance obligation.
- A new seam (port + adapter + worker wiring) exists where previously a
  single-tenant host simply read its own env; the indirection is justified by the
  isolation requirement but is real surface to keep correct.
- The reference's *availability* to the worker (e.g. a correctly-mounted
  per-tenant env-file, or a reachable Vault path) is now a deployment
  responsibility outside the type system. A misconfigured mount surfaces as a
  fail-closed worker boot (the env-file adapter returns a `config-invalid` Left
  and the worker exits 1) rather than a type error — the safe failure direction,
  but one that moves a class of error from compile time to deploy time.
- The default env-file adapter trusts filesystem permissions to scope a tenant's
  ref to its own worker; the isolation property at the OS layer (mount/uid
  scoping) is assumed by this ADR and owned by deployment, not enforced by this
  code.

## Related

- ADR-0064 — multi-tenant single-host supervisor/worker split: the overall
  approach this secrets decision serves.
- ADR-0067 — per-tenant Redis ACL: the ACL credential is minted at apply time and
  handed off to the owning worker through the spawn-env channel (SEPARATE from the
  `SecretsSource` env-file port), never retained supervisor-side.
- ADR-0042 — config via Zod env/YAML: establishes the config boundary, keeping
  non-secret configuration parsing separate from the secret-value channel this
  ADR defines.
- ADR-0056 — FIC variant A / per-agent client (`AgentClientCredentials` port):
  the port-with-substitutable-adapter rationale this decision mirrors for
  secretless supervisor context.
- ADR-0055 — one Entra app per trust boundary: the broader secretless-identity
  posture this fits into.
- `packages/host/src/domain/tenant.ts` — the `SecretsRef` brand and
  `markSecretsRef` producer.
- `packages/host/src/supervisor/secrets/secrets-source.ts` — the `SecretsSource`
  port (a pure type that constructs nothing).
- `packages/host/src/supervisor/secrets/env-file-secrets-source.ts` — the default
  fail-closed env-file adapter (a worker concern).
- `packages/host/src/worker-main.ts` — `buildWorkerBootstrap`: resolves the ref
  inside the owning worker at spawn.
- `packages/host/src/__tests__/integration/isolation-supervisor-secrets.test.ts`
  — the supervisor-secrets-absence test proving SC-002/NFR-011 structurally.
- `packages/host/src/__tests__/supervisor/secrets/env-file-secrets-source.test.ts`
  — the adapter's fail-closed parse tests.
