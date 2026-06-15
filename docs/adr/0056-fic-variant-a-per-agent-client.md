# ADR-0056: FIC Variant A — one federated identity credential per agent-type Keycloak client

> **Consolidated reference:** the live, end-to-end team-security picture this decision feeds into lives in [`docs/team-security-and-capabilities.md`](../team-security-and-capabilities.md). This ADR remains the immutable "why".

## Status

Accepted

## Context

The Wave-4 Entra bridge gives a node app-only access to Microsoft Graph / Dynamics
without storing any Entra secret. A single Entra app registration, `fugue-agents`,
holds the union of application permissions any agent needs (FR-W4-001), and trusts
the `fugue-platform` Keycloak realm as an external OIDC issuer via Workload Identity
Federation. The credential is the Keycloak service-account token itself, presented as
the `client_assertion` in a `client_credentials` request to the tenant token endpoint
(FR-W4-004, US7). Entra accepts the assertion only if its `iss` / `sub` / `aud` match a
**federated identity credential (FIC)** declared on the `fugue-agents` app, case-
sensitively (FR-W4-002).

The open question this ADR settles is the *granularity* of those FIC entries — how many
FICs the one app carries, and what each one trusts. The forces in tension:

- **Per-agent attribution.** When a Graph call is made, "which agent did this?" must be
  answerable. The Graph token is app-only — its `appId` is always `fugue-agents`, so the
  Graph resource server cannot tell agents apart. The only Entra-side fork where agents
  *can* be distinguished is the **federated sign-in event** that minted the token, and
  only if that event records which FIC matched.
- **The 20-FIC/app cap.** Entra limits an app to 20 federated identity credentials.
  Any scheme keyed on a *dynamic* identity (per running instance) blows the cap; a scheme
  keyed on agent *type* sits comfortably under it.
- **Config-as-code provisioning.** A FIC `subject` must be written before the assertion is
  minted. A service-account `sub` is a random UUID assigned at client creation, so FIC
  subjects can only be pre-written if the `sub` is made predictable.
- **Replay containment.** The federation assertion must not be replayable against internal
  services — it carries a dedicated `aud: api://AzureADTokenExchange` (FR-W4-003) minted by
  the `entra-exchange` scope and pinned in every FIC's `audience`.

Two of these forces are empirical and were carved out as MUST-PASS gating spikes ahead of
this decision: **spike #1** (FR-SPK-001 — does the sign-in log name the matched FIC?) and
**spike #2** (FR-SPK-002 — does Keycloak's `sub` mapper survive Entra's case-sensitive
match, enabling ahead-of-time FIC config?). The attribution argument for a fine-grained FIC
scheme rests entirely on spike #1; its config-as-code feasibility rests on spike #2.

## Decision

**Adopt Variant A: one FIC per agent-type Keycloak client. Each agent-type client's
service-account token is itself the federated assertion, and the `fugue-agents` app carries
one FIC per agent type (up to Entra's 20-FIC cap).**

Concretely:

- The `fugue-platform` realm holds one service-account client per agent *type*
  (`fugue-agent-mail`, `fugue-agent-sites`, …), each minted via the realm's `ClientStep`.
- The `fugue-agents` Entra app carries **one FIC per such client** — `fugue-agent-mail-fic`,
  `fugue-agent-sites-fic`, … — each with:
  - `issuer` = the `fugue-platform` realm issuer URL, exact scheme/host/port, no trailing
    slash (identical across all FICs);
  - `subject` = that client's service-account `sub`, **`service-account-<client_id>`**,
    written as config-as-code ahead of client creation (spike #2 PASS) or read-then-pinned
    after `ClientStep` if spike #2 records PARTIAL;
  - `audience` = the exact string `api://AzureADTokenExchange` (identical across all FICs),
    minted by the `entra-exchange` scope (FR-W4-003) and not an array.
- The FIC count tracks **agent types**, not dynamic instances — bounded and small, well
  under 20.
- The runtime path is unchanged by this choice: `buildWifFormBody` in
  `packages/host/src/adapters/entra-wif.ts` emits `client_id = fugue-agents` and presents the
  agent's Keycloak SA token as `client_assertion`; Entra selects the matching FIC by the
  assertion's `iss`/`sub`/`aud`. Which FIC matched is the agent-type discriminator.

Spike outcomes that gate this decision (recorded in the wave-4 runbook
`docs/team-security-and-capabilities.md (Appendix A)`, currently
`PENDING-LIVE-VERIFICATION` against a live tenant + realm; the runbook's spike table
carries the expected PASS criteria each step asserts):

- **Spike #1** (`docs/spikes/2026-06-10-spike-1-fic-signin-attribution.md`) — expected PASS:
  the service-principal sign-in log surfaces the matched FIC via `federatedCredentialId`
  (resolving back to the named FIC), making per-agent-type attribution an Entra-side, tamper-
  evident artifact. If spike #1 returns FAIL, Variant A's marginal forensic value over
  Variant B collapses to host logs + `traceparent`, and the A-vs-B choice must be re-weighed.
- **Spike #2** (`docs/spikes/2026-06-10-spike-2-subclaim-fic-matching.md`) — expected PASS:
  the minted `sub` is byte-for-byte `service-account-<client_id>`, survives Entra's case-
  sensitive match (negative control: a single case-flip fails with `AADSTS70021`), and is
  reproducible across client recreation — so FIC subjects are config-as-code with no read-
  then-pin. If PARTIAL, fall back to read-then-pin; Variant A still holds.

These two spikes are MUST-PASS preconditions for the wave-4 Entra bridge. Variant A is the
default and is committed here; the runbook Step 3 is gated on the live spike runs landing PASS.

## Consequences

**Positive:**

- Per-agent-*type* attribution is preserved at Entra's own sign-in-log level (which credential
  matched), independent of, and corroborating, host-side `sub`/`azp`/`runId` audit records
  (FR-X-004). The app-only Graph token, which is otherwise indistinguishable across agents, is
  traced back to a named agent type at the moment of mint.
- Reinforces per-agent-type identity end to end: a distinct Keycloak service-account client and
  a distinct FIC per agent type, rather than a single shared funnel identity.
- One FIC per agent type fits the 20-FIC cap with wide headroom; the cap is only ever a concern
  if agent *types* proliferate past ~20, which is an organizational, not a runtime, bound.
- Zero runtime-code cost: the host's WIF exchange already presents the agent's SA token as the
  assertion; FIC granularity is entirely a provisioning-side (FIC-list) concern. No change to
  `entra-wif.ts`.
- FIC subjects are config-as-code (`service-account-<client_id>`), so the FIC list is declarative
  and reviewable, written ahead of client creation (spike #2 PASS) with no read-then-pin step.

**Negative:**

- More Entra provisioning surface than the single-FIC alternative: one FIC entry to create,
  name, and keep in sync per agent type. Each addition is a manual/portal step captured in the
  runbook (FR-W4-006), and each must match `issuer`/`subject`/`audience` exactly — a case or
  trailing-slash drift is a silent `AADSTS70021` reject.
- The 20-FIC cap is a hard ceiling on agent *types* under one app. Exceeding it forces either a
  second trust-boundary app (AD-3) or a fallback to Variant B's single funnel FIC.
- The attribution benefit is contingent on spike #1 landing PASS against a live tenant. Until the
  spike is run, the forensic value is a documented expectation (Microsoft's `signIns` schema
  includes `federatedCredentialId`), not an observed result — the decision is committed but its
  primary justification carries this verification debt.
- A dynamic/per-instance identity scheme is explicitly out of scope: FICs key on agent type only,
  so instance-level attribution must come from host logs + `traceparent`, not from Entra.

## Rejected Alternatives

1. **Variant B — one funnel `entra-bridge` client, one FIC.**
   A single Keycloak client (`entra-bridge`) fronts all agents; the `fugue-agents` app carries
   exactly one FIC whose `subject` is that client's pinned `sub`.
   - Pros: minimal Entra config (one FIC, one subject pinned once, never near the 20-FIC cap);
     the simplest possible federation surface; `sub` is fixed so spike #2's predictability concern
     is trivially satisfied.
   - Cons: collapses all Graph attribution to one identity — the sign-in log and the assertion
     `sub` are identical for every agent, so "which agent made this Graph call?" is answerable
     only from host logs + `traceparent`, never Entra-side. Loses the tamper-evident, per-agent-
     type forensic artifact that spike #1 targets, and dilutes per-agent-type identity into a
     shared funnel.
   - Verdict: rejected as the default. Variant B is the documented fallback, chosen only if even
     20 FICs is judged too much surface to provision/maintain, or if spike #1 returns FAIL (no
     Entra-side per-FIC attribution) — in which case Variant A's marginal value over B collapses
     and B's simplicity wins.

2. **Per-instance FIC (one FIC per running agent instance).**
   - Pros: finest possible Entra-side attribution — every instance is a distinct federated
     identity.
   - Cons: untenable against the 20-FIC/app cap the moment more than ~20 instances run; instance
     identities are dynamic, so FIC subjects cannot be config-as-code and would require runtime
     FIC churn against the Graph API. A non-starter.
   - Verdict: rejected — violates the 20-FIC cap and the config-as-code provisioning model.
