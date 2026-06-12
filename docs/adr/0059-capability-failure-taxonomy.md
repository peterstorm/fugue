# ADR-0059: Capability Failure Taxonomy — Distinct Typed `FrameworkError` Variants, Fail-Closed Before Entra

## Status

Accepted

## Context

Identity-scoped capabilities (ADR-0051's registry, the `CapabilityBroker` port,
the Keycloak service-account mint, and the Entra Workload Identity Federation
exchange) introduced a new class of runtime failures along the path from a node
declaring `requires: ["graph"]` to a usable downstream token. A single scoped
resolution can fail for four operationally distinct reasons:

- the run hit its per-run LLM token budget before the call (a deliberate stop),
- the identity provider or token endpoint could not be reached (a transient
  outage — Keycloak down, DNS/socket error, a 5xx or 429 from a mint endpoint),
- the agent client was never assigned the requested scope (a settled
  authorization "no" that the broker can decide locally, before any egress),
- a downstream identity authority (Entra) rejected the exchange — a FIC
  subject/issuer mismatch, a WIF rejection, or a resource-scoping denial.

Each demands a *different* caller response. A transient reach failure is
retry-worthy; an authorization refusal must never be retried (retrying hammers a
provider that has already said no, and a fail-closed gate exists precisely so
the system does not behave as if access might appear on a second attempt); a
budget stop is neither — it is a settled accounting decision. SC-013 requires
that the framework's typed error channel preserve the **retry vs. authorization
vs. budget** distinction so the DAG runtime and downstream consumers can branch
on the failure *kind* alone, without parsing message strings.

There is a further forcing constraint (FR-X-003): a token-cache miss is **not** a
failure at all. It is the normal trigger for a mint/exchange. The taxonomy must
not represent a cache miss as an error, or every cold path would surface a
spurious failure.

The problem is the shape of the error channel: how many variants, where the
authorization/reachability boundary is drawn, and at which point in the broker
pipeline each is raised — not whether scoped capabilities should exist (that is
settled upstream by ADR-0051 and the broker-port ADRs).

## Options Considered

1. **Single generic `capability-error` variant.**
   - Pros: one case to add to `formatFrameworkError`; trivial to emit at every
     failure site; no decisions about where boundaries fall.
   - Cons: collapses retry, authorization, and budget into one undiscriminable
     blob. Consumers must reconstruct intent by string-matching a `message`
     field — exactly the representable-but-illegal-state pattern the codebase
     forbids. Violates SC-013: a retry loop cannot tell a transient blip from a
     settled denial, so it either retries refusals (hammering Entra) or
     fail-closes on outages (denying access a retry would have cleared). The
     fail-closed-before-Entra ordering becomes invisible in the type.

2. **Distinct, discriminable typed variants — one per operational response
   class (chosen).**
   - Pros: each failure class is a `ts-pattern`-matchable `kind`; retry policy,
     audit, and the metering shell branch on the discriminant with no string
     parsing. The authorization/reachability boundary is encoded in the type, so
     "never retry a denial" and "may retry an outage" are enforceable. Adding a
     variant without handling it is a compile error via `.exhaustive()`.
   - Cons: more variants to define and to keep mapped consistently across the two
     host egress hops (Keycloak mint, Entra WIF) and the Graph capability; the
     authorization-vs-reachability boundary must be drawn deliberately and held
     by every HTTP-status mapper.

3. **Per-mechanism downstream variants (separate `fic-mismatch`,
   `wif-rejected`, `resource-denied`).**
   - Pros: maximally precise about *which* Entra mechanism refused.
   - Cons: the node's response to all three is identical — fail-closed, no retry,
     audit the denial. The extra discriminants buy no behavioural difference for
     v1 and force every consumer to enumerate three cases that are handled the
     same way. FR-X-002 explicitly permits collapsing them into one
     authorization category; the provider's stated cause is preserved in a
     `reason` string for the audit record without a type-level explosion.

## Decision

**Model capability failures as four distinct, `ts-pattern`-matchable
`FrameworkError` variants — `llm-budget-exceeded`, `infra-unreachable`,
`policy-refusal`, `downstream-denied` — each added to `formatFrameworkError`'s
`.exhaustive()` switch; a token-cache miss is never an error.**

The variants are defined in
`packages/framework/src/types/errors.ts` on the `FrameworkError` union:

- **`llm-budget-exceeded`** `{ runId, nodeId, cumulative, budget }` (FR-W1-003).
  Emitted by the host's metered LLM decorator when a per-run token budget is
  reached. The check runs *before* the call against the cumulative-so-far
  counter plus a concurrency reservation (`metered-llm.ts` reserves a learned
  per-call estimate, the largest single call observed so far, for every
  admitted-but-unsettled call). Overshoot is bounded accordingly: the very
  first parallel burst — while the estimate is still 0, before any call has
  settled — can overshoot by N concurrent calls; thereafter the learned
  reservation bounds overshoot to ~one call (the FR-W1-004 "at most one call"
  allowance, generalised for concurrency). The error refuses the *next* call
  once `cumulative` plus the in-flight reservation has reached `budget`.

- **`infra-unreachable`** `{ operation, message }` (FR-X-001). The broker could
  not reach the IdP / token endpoint — a **transient** infrastructure failure
  (Keycloak down, DNS/socket error, 5xx or 429 from the mint endpoint), *not* an
  authorization decision. Callers may retry. `operation` names the failing hop
  (`"client-credentials"`, `"token-exchange"`, `"entra-wif"`, `"graph"`);
  `message` carries the diagnostic (status line, socket error).

- **`policy-refusal`** `{ scope, agentClientId? }` (FR-X-001). A required scope is
  not assigned to the agent's client in the IdP policy — an **authorization**
  refusal raised **fail-closed by the broker's local policy gate BEFORE any
  downstream (Entra) call, and before any cache read**. Because it precedes every
  network call it is never transient and must never be retried. An unrecognised
  `requires` name is *not* policy-refused: the broker skips it as a static
  (non-downstream) capability, and if no static capability of that name exists
  it surfaces at run-start validation as `missing-capability` — so every
  `policy-refusal` the broker actually emits is an assignment-time refusal (a
  known client whose policy lacks the scope) and carries `agentClientId`. The
  field stays optional in the type for brokers without a resolved client id;
  absence is an absent field, not an empty string.

- **`downstream-denied`** `{ resource, reason }` (FR-X-002). A downstream identity
  decision rejected the invocation: an Entra FIC subject/issuer mismatch, a WIF
  rejection, or a resource-scoping denial — **collapsed into one authorization
  category**. From the node's perspective these are all "the downstream said no",
  handled identically (fail-closed, no retry) regardless of mechanism. Kept
  **distinct from `infra-unreachable`**: a denial is a settled answer, an outage
  is the absence of one, so retry policy branches on the kind alone. `resource`
  is the refused audience/resource id; `reason` carries the provider's stated
  cause for the audit trail.

### Where the boundary is drawn (host mapping)

The authorization/reachability boundary is enforced at every HTTP-outcome
mapper. The invariant is: **transport rejection or an unhandled status →
`infra-unreachable`; a settled 4xx authorization status → `downstream-denied`;
429/503 throttling → `infra-unreachable` (named as a throttle).**

- **`packages/host/src/adapters/keycloak-broker.ts`** is the ordering authority.
  The local policy gate in `mintFor` runs first: an unassigned scope returns
  `policy-refusal` with **zero egress and without reading any cache** (SC-006 /
  FR-W3-003). Only an assigned scope proceeds to the app-only cache check, the
  SA mint (first egress), and the WIF exchange (second egress); mint/exchange
  failures are surfaced verbatim on the `Result` channel and audited as
  `mint-failed:<kind>`.

- **`packages/host/src/adapters/entra-wif.ts`** maps the WIF token response:
  `400`/`401`/`403` → `downstream-denied` (FIC mismatch / WIF rejection /
  resource denial collapsed, FR-X-002); `429`/`503` → `infra-unreachable` (named
  as a throttle); any other status (other 5xx, surprising) and any transport-level
  rejection → `infra-unreachable`.

- **`packages/host/src/adapters/graph-capability.ts`** maps the Graph response the
  same way, with one deliberate divergence: a `404` is also `downstream-denied`,
  because on a resource-scoped Graph path (e.g. `Sites.Selected`) Graph returns
  404 rather than 403 to avoid leaking existence — an authorization-shaped "no".

### Invariants

- Every variant is reachable from `match(e)` and is a case in
  `formatFrameworkError`'s `.exhaustive()` (`errors.ts`). Adding a kind
  without a case is a compile error.
- A **token-cache miss is not an error** (FR-X-003): in the broker it is the
  normal path that triggers a mint/exchange (the miss/acquire path in
  `doAcquireAppToken`, `keycloak-broker.ts`), never a `FrameworkError`.
- `policy-refusal` is raised strictly before any egress; `infra-unreachable` and
  `downstream-denied` only after a real reach attempt.
- The four variants serialize cleanly through `FrameworkAugmentedError`
  (`frameworkErrorKind` / `frameworkErrorJson`) so queue workers see the
  discriminant after a JSON round-trip.

This taxonomy satisfies US6 (operators and the runtime can tell *why* a scoped
capability failed) and SC-013 (the retry/authorization/budget distinction is
preserved in the type, not the message).

## Consequences

**Positive:**

- Retry policy, audit, and metering branch on the discriminant with no string
  parsing; "retry an outage, never retry a denial" is enforceable from the kind
  alone (SC-013).
- The fail-closed-before-Entra ordering is encoded: `policy-refusal` is, by
  construction, raised before any egress or cache read — visible in both the type
  and the broker pipeline (SC-006 / FR-W3-003).
- `.exhaustive()` makes a future variant impossible to add silently — every
  consumer is forced to handle it.
- Collapsing the three Entra denial mechanisms into `downstream-denied` keeps the
  type honest about behaviour (one response) while preserving the precise cause
  in `reason` for audit.
- A cache miss stays off the error channel, so cold paths do not surface spurious
  failures (FR-X-003).

**Negative:**

- The authorization/reachability boundary must be held identically by three
  separate HTTP-status mappers (Keycloak broker, Entra WIF, Graph). A mapper that
  miscategorises a status (e.g. a 403 as `infra-unreachable`) would make a denial
  look retriable; this is guarded by per-mapper unit tests but is not enforced by
  the type system.
- `downstream-denied` is deliberately coarse: the three Entra mechanisms are
  indistinguishable at the type level. If a future requirement needs
  mechanism-specific handling, the variant must be split — an accepted v1
  tradeoff under FR-X-002.
- The Graph 404→`downstream-denied` rule diverges from the WIF mapper (which
  treats other statuses as `infra-unreachable`). The divergence is intentional
  and documented, but it is a per-resource judgement that must be revisited for
  any new resource-scoped downstream.
- Four new variants widen the union every exhaustive consumer must cover; the
  cost of `.exhaustive()` is that adding the next variant touches every switch —
  accepted as the price of compile-time completeness.

## Rejected Alternatives

- **Single generic `capability-error` variant.** Rejected: it collapses the
  retry / authorization / budget distinction that SC-013 requires into one
  undiscriminable error, forcing consumers to string-match `message` to recover
  intent and erasing the fail-closed-before-Entra ordering from the type. A retry
  loop built on it would either hammer Entra on settled denials or fail-close on
  transient blips a retry would clear.
- **Per-mechanism downstream variants** (`fic-mismatch` / `wif-rejected` /
  `resource-denied`). Rejected for v1: all three drive identical node behaviour
  (fail-closed, no retry), so the extra discriminants add no branching value
  while forcing every consumer to enumerate three equivalent cases. FR-X-002
  permits the collapse; the provider's stated cause is retained in `reason`.

## Amendment — `infra-unreachable.operation` generalised to role categories (2026-06-12)

**Status:** Accepted. Refines the `infra-unreachable` variant above.

`infra-unreachable.operation` is being generalised from vendor hop names
(`"client-credentials" | "token-exchange" | "entra-wif" | "graph"`) to role
categories (`"mint" | "exchange" | "federation" | "downstream"`), with a new
free-form `hop: string` field carrying the host-specific hop name for
diagnostics. The mapping is: `client-credentials` → `mint`, `token-exchange` →
`exchange`, `entra-wif` → `federation`, `graph` → `downstream`. This reconciles
this ADR with ADR-0054's provider-agnostic boundary (FR-W2-004 — no vendor
literal crosses into the framework): the framework union carries only role
categories, and vendor hop names travel in the free-form `hop` field.
