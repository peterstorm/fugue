# Identity-scoped capabilities — scoping LLM/tool nodes with Keycloak + one Entra app — Design

> Status: **proposal / direction, not committed scope.** Concretizes the
> "Forward-looking: authorizing LLM nodes & agents" section of
> [2026-06-09-lead-desk-bff-dashboard.md](./2026-06-09-lead-desk-bff-dashboard.md)
> into a buildable design with a wave plan. The `fugue-platform` realm decided
> there is the substrate. Sources verified 2026-06-10; re-verify GA status
> against the target Keycloak/Entra state before building waves 3–4.
>
> This plan **supersedes** the lead-desk plan's "per-agent(-type) Entra app
> registration" wording: the Entra unit is **one app**, not one per agent type.

## Summary

When fugue grows agent semantics, the capability a node receives must become
**narrowly-scoped, per-invocation authority** instead of a shared host
singleton. Two design questions were open; this plan answers both:

1. **How much Entra surface do we need?** **One Entra app registration**
   (`fugue-agents`) — explicitly *not* one app per agent. All per-agent policy
   lives in Keycloak; Entra is reduced to a dumb token vendor reached via
   workload identity federation. Entra involvement is one app registration, a
   list of federated-credential entries inside it, and resource-scoping
   policies — everything that changes per agent changes only in
   `keycloakConfigAsCode`.
2. **Where does enforcement live?** The **host's capability broker** — the
   only component that ever holds a token. Nodes receive typed,
   operation-narrowed capability handles; the functional core never sees a
   credential. The broker refuses before Entra is ever contacted if Keycloak
   policy says no.

The plan also schedules the cheapest first instance of the pattern — per-agent
**LLM usage metering and budgets** — which needs no Keycloak/Entra at all and
serves as the dry run for the per-invocation capability axis.

## The flow

```
LLM node                fugue host (imperative shell)         Keycloak (fugue-platform)        Entra
────────                ─────────────────────────────         ─────────────────────────        ─────
requires:               capability broker (mintFor):
["msgraph:mail.send"] ─▶ 1. client_credentials as the    ───▶ grants ONLY if the optional
                            agent's client,                   scope is assigned to that
                            scope=msgraph:mail.send           client — the policy lives here
                         2. present that token as        ─────────────────────────────────▶ FIC match
                            client_assertion (WIF)                                           (issuer+sub+aud)
                         3. receive app-only Graph token ◀─────────────────────────────────  ONE app:
                         4. wrap in a typed handle                                           "fugue-agents"
                            exposing ONLY sendMail();
                            hand the handle to the node
```

The node never sees a token — it receives a capability handle whose *operation
surface* is narrowed in code. Keycloak makes every per-agent decision; Entra
only ever answers "is this assertion from the realm I trust?"

## Trust model — why one Entra app is sound

The instinct against a shared downstream identity is blast-radius bounding.
But **the trust boundary here is the host process, not the agent**: every DAG
runs inside the same fugue host, so whether there are one or twenty Entra
apps, a host compromise yields all of their federation paths anyway. Per-agent
Entra apps would buy almost nothing at the layer where compromise actually
happens, while costing an app registration + admin-consent ceremony per agent.

The honest trade-off accepted: **app-only tokens cannot be downscoped per
request.** `client_credentials` against Entra is `scope=.default` — the token
carries *all* granted app roles, every time, regardless of which agent asked.
Entra-side least-privilege per agent is simply unavailable with one app.
Therefore:

- per-agent least privilege is enforced **before** the Entra hop (Keycloak
  scopes + the broker), and
- the union permission set is bounded **at** Entra with resource-scoping
  policies (below), which narrow *where* the broad token can act without
  adding apps.

## Entra side — one app, minimal surface

### The app

One app registration, **`fugue-agents`**, holding the **union** of application
permissions any agent needs (e.g. `Mail.Send`, `Sites.Selected`,
Dynamics scopes), admin-consented once. Granting a *new* permission to the
union is the only recurring Entra ceremony.

### FIC wiring — two variants

**Variant A — one federated identity credential per agent-type Keycloak client
(recommended).** Each agent client's service-account token is itself the
federated assertion. One app, up to 20 FICs (the hard Entra cap per app), each
matching:

- `issuer` = the `fugue-platform` realm issuer URL
- `subject` = that client's service-account `sub` (case-sensitive exact match)
- `audience` = `api://AzureADTokenExchange`

This preserves per-agent attribution at Entra's sign-in-log level (which
credential matched) at the cost of one FIC entry per agent type — which also
reinforces the per-agent-*type* identity decision: 20 FICs is plenty for agent
types, untenable for dynamic agent instances.

**Variant B — one funnel client, one FIC.** A single `entra-bridge` Keycloak
client performs all WIF exchanges; agents never touch the Entra path directly.
Absolute minimum Entra config (one FIC, forever), but Entra-side attribution
collapses entirely — all Graph activity traces to one identity and the only
forensics are host logs + `traceparent`. Choose only if even 20 FICs is too
much Entra surface. Default to **A**.

### Mechanics (both variants)

- Keycloak must mint the assertion with `aud: api://AzureADTokenExchange` — a
  dedicated client scope carrying a hardcoded-audience protocol mapper
  (`entra-exchange`). Useful side effect: a token audience-pinned to
  `AzureADTokenExchange` is rejected by every internal service, so the
  assertion cannot be replayed inside the platform.
- The service-account `sub` is a UUID assigned at client creation, so FIC
  subjects cannot be written ahead of time. Either read-then-pin after the
  `ClientStep` runs, or use Keycloak's sub-claim mapper to make `sub` the
  predictable `service-account-<client_id>` — **verify the mapper output
  against FIC's case-sensitive match before committing** (open verification
  item #2).

### Bounding the union — resource-scoping policies, not more apps

Two Entra-native mechanisms narrow *where* the union-permission token can act,
at zero additional apps:

- **`Sites.Selected`** instead of `Sites.Read.All` / `Sites.ReadWrite.All` —
  the app touches only SharePoint sites explicitly granted to it.
- **Exchange application access policies** — restrict `Mail.Send` /
  `Mail.Read` to specific mailboxes (e.g. only the lead-desk shared mailbox),
  not the whole tenant.

### Escalation path — apps per permission *tier*, never per agent

If the permission union ever grows uncomfortable (read-only agents sharing an
identity that can send mail), split by **sensitivity tier**:
`fugue-agents-read` / `fugue-agents-act` — two or three apps total. That
bounds the worst case while staying an order of magnitude below per-agent
registrations. This is the *only* sanctioned reason to add an Entra app.

## Keycloak side — policy as optional client scopes

- **Mirror each downstream permission as a Keycloak optional client scope**:
  `msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`, … Assigning a
  scope to an agent's client in the `fugue-platform` `ClientStep` *is* the
  policy grant — config-as-code, PR-reviewed, golden-export-tested, the same
  governance gate as the agent code itself.
- **Keycloak is the refusal point.** The broker requests exactly the scopes a
  node's `requires` names. If the agent's client lacks an assignment, the
  token request fails and **the broker never reaches Entra**. The
  over-privileged Graph token only ever exists after Keycloak said yes — and
  it never leaves the host shell.
- Realm roles / UMA stay available for coarser or per-resource gating, per the
  lead-desk plan; they compose with (don't replace) the scope mirror.

## The capability broker — `mintFor(invocation)`

This is the ADR-level change already sized in the lead-desk plan (amending
ADR-0051). Capabilities today are boot-time singletons: `SharedInfra` holds
them, `connectAll` runs once at boot, `extractClients` builds a single static
`name → client` map shared into every `NodeContext`. The broker adds a
**per-invocation factory axis** without disturbing the boot lifecycle:

1. Node declares `requires: ["msgraph:mail.send"]` — the existing typed
   `requires` seam, with capability names now doubling as scope names.
2. At node execution, the broker resolves the declaration:
   `client_credentials` as the agent's Keycloak client with exactly those
   scopes → (for Entra-backed capabilities) WIF exchange → typed handle
   exposing only the operations the declaration named (`sendMail`, not a raw
   Graph client). Parse-don't-validate at the capability boundary.
3. **Connection pools stay boot-scoped; authority becomes invocation-scoped.**
   `connect`/`close`/`healthCheck` are untouched.
4. **Token cache per `(identity, audience, scope)`** with TTL safely under
   token lifetime, living in the shell next to the minting — per-invocation
   authority must not mean per-invocation network calls.
5. The single trust-boundary cast in `extractClients` moves or gains a
   per-request correlation point — the thing its own doc-comment currently
   forbids. That comment is correct *for today's design*; changing it is
   precisely why this lands as an ADR, not a patch.

For **user-initiated runs** (once the host accepts `fugue-platform` JWTs per
the lead-desk plan's migration path), the broker's step 1 becomes Standard
Token Exchange V2 of the *user's* token per hop — `sub` stays the user, `azp`
becomes the agent, and the same scope/audience narrowing applies.
Agent-initiated runs never use exchange (exchanging your own
`client_credentials` token buys nothing).

## The LLM capability — same axis, no OIDC

The LLM client (Anthropic/OpenAI key) rides the same `mintFor` seam but is a
vendor API key, not OIDC — no Keycloak or Entra involvement.

**Per-team is already solved — by deployment, not code.** PR #13 (2026-06-09,
`ce45dff`) made **one-host-per-team** the deployment model: each team's host
brings its own provider + API key via env, models chosen per-node in DAG code.
The host-global singleton is therefore *correct by construction* (host = team).
**Anti-goal: do not build per-team client resolution into the host** — it
would re-create the multi-tenancy the deployment model deliberately rejected.

What remains open is the **per-agent dimension within a team's host**, and it
splits into two deliberately different-sized pieces:

- **Usage attribution (wave 0 — standalone, do soon).** `LlmResponse` already
  returns `tokensIn`/`tokensOut`, and `createNodeContextForDag` already
  receives `dag` and `runId` — the seam exists with zero framework changes.
  Wrap `shared.llm` in a decorator at that factory that stamps
  `dagId`/`runId`/`nodeId` onto every call and aggregates (structured log
  line and/or Redis counter). Per-agent cost attribution in roughly an
  afternoon of host-only work; pairs with the `sub`+`azp`/trace attribution
  spine from the lead-desk plan.
- **Budget enforcement (wave 1 — the first `mintFor` instance).**
  `llmBudgetTokens` in `fugue.yaml`, enforced by the same decorator: refuse
  further calls once a run exceeds its budget. One framework touch — a new
  `FrameworkError` variant (`llm-budget-exceeded`) so the refusal flows
  through the existing `Result` channel. This makes the LLM handle the first
  invocation-scoped capability (budget + model allowlist instead of a token)
  and the low-risk dry run for the OIDC-backed waves.

## Wave plan

| Wave | Deliverable | Touches | Depends on |
|---|---|---|---|
| 0 | LLM usage metering decorator (`dagId`/`runId`/`nodeId` stamped, aggregated) | host only | nothing — buildable now |
| 1 | LLM budget enforcement (`llmBudgetTokens`, `llm-budget-exceeded` error, invocation-scoped LLM handle) | host + one framework error variant | wave 0 |
| 2 | ADR amending ADR-0051: per-invocation capability axis (`mintFor`), token cache, `extractClients` boundary | framework + host | wave 1 (pattern proven) |
| 3 | Keycloak-backed capabilities: scope mirror in `ClientStep`, broker minting for internal downstreams; V2 exchange path for user-initiated runs | host + `keycloakConfigAsCode` | wave 2; host-accepts-realm-JWTs (lead-desk plan) for the user path |
| 4 | Entra bridge: `fugue-agents` app + FICs + `entra-exchange` audience scope + Graph/Dynamics capabilities + resource-scoping policies | host + Entra + `keycloakConfigAsCode` | wave 3 |

Waves 0–1 are useful on their own even if the agent framework never happens —
metering and budgets are just good hosting. Waves 2–4 are the agent-framework
milestone proper.

## Verify before building (waves 3–4)

1. **FIC sign-in attribution** — confirm Entra sign-in logs surface *which*
   federated credential matched; this decides how much forensic value variant
   A has over B.
2. **Sub-claim mapper × FIC matching** — Keycloak's sub mapper producing
   `service-account-<client_id>` must survive Entra's case-sensitive
   issuer/subject/audience match.
3. **Resource-scoping coverage** — `Sites.Selected` and Exchange application
   access policies must actually cover the Graph surfaces the agents need
   (mail send from the lead-desk mailbox, the specific SharePoint sites).
4. **Identity-chaining end-to-end spike on 26.6** (carried over from the
   lead-desk plan) — the constituent features are individually supported; the
   composed flow needs a spike before prod.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Entra app unit | **One app `fugue-agents`** (union permissions) | Trust boundary is the host process; per-agent apps add ceremony, not containment |
| Per-request Entra downscoping | **Accepted as impossible** (`.default` only for app-only tokens) | Enforced instead in Keycloak + broker; bounded at Entra by resource-scoping policies |
| FIC wiring | One FIC per agent-type client (variant A) | Keeps per-agent attribution in Entra sign-in logs; 20-FIC cap fits agent *types* |
| Entra escalation | Apps per permission *tier* (read/act), never per agent | Bounds worst case at the only layer Entra can enforce, stays at 2–3 apps |
| Per-agent policy surface | Keycloak **optional client scopes** mirroring downstream permissions, assigned in `ClientStep` | Policy grant = config-as-code PR, same governance as agent code |
| Enforcement point | Host capability broker (`mintFor`) — refuses before Entra is contacted | Single PEP; tokens never leave the shell; nodes get operation-narrowed typed handles |
| Per-team LLM config | **Out of scope — solved by one-host-per-team (PR #13)** | Host-global singleton is per-team by deployment; rebuilding multi-tenancy is an anti-goal |
| LLM metering/budgets | Wave 0/1, decorator at `createNodeContextForDag` | Seam exists today (`dag`, `runId`, `tokensIn/Out`); first proven instance of `mintFor` |

## References

- Substrate + verified auth constraints: [2026-06-09-lead-desk-bff-dashboard.md](./2026-06-09-lead-desk-bff-dashboard.md)
  (token-exchange V2 semantics, `sub`+`azp` attribution, WIF verification,
  host-accepts-realm-JWTs migration, agent identity per type / per DAG)
- Code seams: `packages/host/src/ports.ts` (`SharedInfra`),
  `packages/host/src/domain/capability-manager.ts` (`extractClients` trust
  boundary), `packages/host/src/adapters/node-context-factory.ts`
  (`createNodeContextForDag`), `packages/framework/src/types/llm.ts`
  (`LlmResponse.tokensIn/tokensOut`)
- ADR-0051 — extensible capability registry (the ADR wave 2 amends)
- [Keycloak token exchange](https://www.keycloak.org/securing-apps/token-exchange) ·
  [identity & authorization chaining guide](https://www.keycloak.org/securing-apps/oauth-identity-authorization-chaining-across-domains)
- [Entra workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation) ·
  [client credentials with a federated credential](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#third-case-access-token-request-with-a-federated-credential)
- [Sites.Selected](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) ·
  [Exchange application access policies](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
