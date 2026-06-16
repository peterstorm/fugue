# ADR-0060: Durable Human-in-the-Loop — A First-Class Suspend/Resume Primitive

## Status

Accepted

## Context

Human-in-the-loop (HITL) is already modelled in the DAG runtime: a node may
declare `humanReview`, and when it completes the machine transitions to
`awaiting-human` and dispatches the caller-supplied `onHumanReview` hook
(ADR-0013, ADR-0025). The hook returns a `HumanAction`
(`approve` / `approve-with-edit` / `reject` / `reroute`) and the run continues.

The state-machine kernel (`runStateMachine`) drives a machine to a **terminal**
state (`succeeded` / `failed`), checkpointing after every transition. The loop
condition is `while (!isTerminal(state))`. Crucially:

- `awaiting-human` is **not** terminal, so the kernel stays in the loop and
  **awaits the hook to completion** before the next transition.
- A hook that throws does **not** release the loop — it transitions to
  `retrying-hook`, an *in-process* retry with backoff (ADR-0013), and after the
  retry budget is spent the node fails.

This is correct for crash recovery: `awaiting-human` is persisted durably via
the `JobLike`, so a re-run with the same job resumes there and re-dispatches the
hook. But it means there is **no way for a paused run to release its worker and
resume later**. The only way to satisfy a hook is to block until a decision
exists — holding the worker (and, in the host, the HTTP connection and a
concurrency permit) for the entire human delay, which may be hours or days, and
losing the in-flight run on process restart unless something external keeps the
job alive.

The host needs the opposite: when a run reaches a human gate and no decision is
available yet, **park the run durably, free the worker, and let an out-of-band
approval (e.g. a Microsoft Teams card action) re-enqueue the job to resume from
the parked point.** This is the durable-requeue model: it survives restarts,
holds no connections, and scales to arbitrary human latency.

Nothing in the kernel expresses "paused but not finished". A run is either
running (loop active) or terminal. We must add that third outcome.

## Decision

Introduce a first-class **suspend** state to the DAG runtime and a **halt**
concept to the kernel, so a run can durably pause at a human gate without
holding a worker.

### 1. The hook may decline to decide

`onHumanReview` now returns `HumanReviewOutcome = HumanAction | { kind: "pending" }`.

- A `HumanAction` resolves the gate exactly as before.
- `{ kind: "pending" }` means *"no decision yet — suspend this run."* The hook
  is expected to have recorded the pending review and emitted whatever
  notification it owns (e.g. posted a Teams card) **before** returning `pending`.

`pending` is deliberately **not** a `HumanAction`: the exhaustive
`handleHumanResponse` (approve/edit/reject/reroute) stays closed over genuine
decisions, and the suspend path is a separate, earlier branch. Illegal states
(a "decision" that is really an absence of one) remain unrepresentable in the
resolution layer.

### 2. A `suspended` DAG phase

A new `DagPhase` variant `suspended` carries the **identical payload** to
`awaiting-human` (`nodeId`, `output`, `prompt`, `pendingReviews`, `wave`). It is
the durable parking spot. On resume, the executor treats `suspended` exactly
like `awaiting-human` — it re-dispatches the hook — so a resumed run either
proceeds (decision now present) or re-parks (still `pending`). The transition
`awaiting-human → suspended` is driven by a new `human-suspend` event the
executor emits when the hook returns `pending`.

`suspended` is **not** terminal and **not** failed, so the kernel checkpoints it
(durability) and never reports it as an error.

### 3. The kernel can *halt* (not just terminate)

`Machine` gains an optional `isHalted(state)` predicate. After each transition,
`runStateMachine` checkpoints as usual and then breaks the loop when
`isHalted(state)` is true — returning the (non-terminal) state to the caller.

The halt check is **post-transition only**. A loop that *starts* in `suspended`
(a resumed job) sees `!isTerminal` and re-enters, dispatching the hook; the halt
break fires only when a transition *produces* `suspended` during this run. This
is what makes "start suspended → re-evaluate; transition into suspended → park"
work with one predicate and no extra bookkeeping.

### 4. A resumable run outcome distinct from the synchronous `Result<O>`

`runDagStatefulOutcome` returns `Result<StatefulOutcome<O>, FrameworkError>` where
`StatefulOutcome<O> = { kind: "completed"; output: O } | { kind: "suspended"; nodeId; prompt; output }`.
(`runDagStateful` is the back-compat flat-`Result<O>` entry — it unwraps
`completed` and maps `suspended` to an invariant `err`; see below.)

- `runDag` (the synchronous public entry, ADR-0021) is **unchanged** for callers:
  it unwraps `completed → ok(output)`. A `suspended` outcome under plain `runDag`
  is a misuse (the caller supplied a `pending`-returning hook to a synchronous
  run) and surfaces as an invariant `err` — the synchronous contract never
  silently swallows a paused run.
- A new worker entry, `runResumableDagJob`, returns
  `WorkerJobOutcome<O> = { kind: "completed"; output } | { kind: "suspended"; nodeId; prompt }`.
  It **throws on a genuine `err`** (so the queue retries real failures, like
  `runDagAsWorkerJob`) but **returns `suspended` without throwing** — so the
  queue acks the job and the run stays parked in its durable `JobLike` until an
  approval re-enqueues it.

### Resume mechanics (host, informative)

1. Worker runs `runResumableDagJob` with a durable (BullMQ-backed) `JobLike`.
2. Gate reached, no decision → host hook records the pending review, sends the
   Teams card, returns `pending` → run parks as `suspended` (persisted) → worker
   acks. No connection or permit is held.
3. The human acts in Teams → the approval endpoint records the decision and
   re-enqueues the job (same `JobLike` key).
4. Worker resumes at `suspended` → hook finds the decision → returns the
   `HumanAction` → run proceeds (or re-parks if more gates remain).

## Consequences

**Positive**

- Durable, connection-free, restart-surviving HITL with arbitrary human latency
  — the model the host needs for Teams approvals.
- The synchronous `runDag` contract is untouched; zero regression for every
  existing non-HITL and block-until-decided caller.
- One small, orthogonal kernel concept (`isHalted`) — reusable by any future
  "pause and wait for the outside world" state, not HITL-specific.
- The decision/absence distinction is preserved in types: `pending` cannot enter
  `handleHumanResponse`; `suspended` cannot be mistaken for terminal.

**Negative / trade-offs**

- A new `DagPhase` variant and `DagEvent` type ripple through every exhaustive
  match (transition, executor, `stateKey`, `stateProgress`, persistence). This is
  intentional: `.exhaustive()` forces each site to handle the new state.
- `HumanInterventionEvent.elapsedMsSinceAwait` measures only the final
  (decision-present) hook dispatch, not the wall-clock park duration across
  re-enqueues. Durable wait-time telemetry is left to the host's pending-review
  store, which has the enqueue/approve timestamps.
- The **in-Teams (Bot Framework) approval path does not yet authorize the
  clicking user against the run's owning team** — v1 keeps a single default
  conversation reference and has no AAD→identity→team mapping, so any member of
  the channel the bot was added to can approve/reject any run. (The HTTP approval
  path *does* enforce team access.) Until per-team conversation routing +
  click-time authorization land, the bot must only be installed in a channel
  whose members are authorised approvers for every team whose runs gate through
  it. Tracked as a follow-up; documented in `../runbooks/azure-bot-hitl-provisioning.md`.
- The host's run-store-backed `JobLike.appendEvent` is a **no-op**: the durable
  run record carries the latest `{state, context}` checkpoint (sufficient for
  suspend/resume correctness) but **not** the kernel's per-transition event
  journal. So HITL runs have no at-most-once event audit trail the way a
  Redis-Streams-backed durable job would. Acceptable for v1 (the status record +
  the host's decision/pending store cover the operational questions), but wiring
  the event journal for HITL runs is a tracked follow-up.

### Effectively-once decision consumption (the read/consume split)

A consumed decision is cleared only AFTER the post-gate state is durably
checkpointed, not the moment the hook reads it. This closes a lost-approval
window: if the hook cleared on read, a worker crash between the clear and the
kernel's `updateData` would leave the durable checkpoint at `suspended` with the
decision gone — the resumed run would re-park and a human would have to decide
again. The mechanism:

- The host `onHumanReview` hook is **read-only**: it returns a recorded decision
  without consuming it.
- A new kernel hook, `KernelRunOpts.onCommitted`, fires after each transition's
  post-state is persisted (`updateData` resolved). The DAG layer exposes it as
  `onDecisionConsumed(nodeId)`, called only for the `human-responded` event that
  consumed the decision.
- The host wires `onDecisionConsumed` to clear the decision + pending marker.

So a crash before the durable checkpoint re-reads the same decision on resume
(safe direction); the clear runs strictly after durability. This is also safe
under `reroute` (which re-gates the same node within a run): the clear runs in
the same kernel iteration as the post-reroute checkpoint, many iterations before
any re-gate, so a re-gate never sees a stale decision. **Residual (documented):**
a crash landing in the tiny window between `updateData` and `onCommitted`, *and*
a later `reroute` re-gate of that exact node, could let the un-cleared decision
auto-resolve the re-review. This is far narrower than the original window (it
needs reroute + a crash in an adjacent-await gap) and no worse than a tolerated
`clear` failure; fully closing it would require a decision-store transaction
spanning the checkpoint write.

### Known timing window (accepted for v1)

One narrow, recoverable race is accepted rather than fixed; recorded here so it
is a conscious decision, not an oversight.

- **Transient `running`-window 409 at the approve pre-checks.** `recordDecision`
  is the authority and gates on the decision-store *pending marker* (present for
  the whole window a reviewer can respond), so the engine never drops an approval
  that lands after `notify` but before `processRun` folds `suspended` back into
  the store. The HTTP (`runs.ts`) and bot (`messages-handler.ts`) handlers,
  however, pre-check the *lagging* run status to derive the gate node id and
  render distinct UX before delegating — so a decision that arrives in that
  sub-second window is rejected at the boundary (HTTP 409 / "already running")
  even though the engine would accept it. **Recoverable:** no decision is
  recorded, so a retry once the status settles succeeds; the run is not stranded.
  The clean fix is a redesign (the HTTP body carries no node id, so accepting in
  the window needs either a body `nodeId` — a breaking API change — or a
  "list pending markers for run" store/port operation), disproportionate to a
  sub-second recoverable window. Deferred to a dedicated design cycle.

- **Duplicate approval → redundant resume slice.** `recordDecision` is a
  read-check-write (`isPending` → `putDecision` → `enqueue`) that is not a single
  atomic compare-and-set. Two valid approvals racing the *same* open gate (e.g. an
  HTTP call and a Teams click landing together) can both pass `isPending` and both
  `enqueue`. This does **not** double-execute the gated node nor emit a duplicate
  card for the resolved gate: the worker's single-flight Redis lock
  (`run-queue.ts`) serializes execution, and the second job hits the
  terminal/already-advanced guards in `processRun` (the first job consumed the
  decision and advanced past the gate before releasing the lock). The only cost is
  one redundant worker slice. `putDecision` is last-writer-wins on the decision
  *value*, so two *different* actions (approve then reject) within the window
  resolve to whichever wrote last — acceptable for v1; a true CAS (`SET` with a
  pending-marker guard, or making the enqueue idempotent per `(runId, nodeId)`)
  would tighten it if approve/reject contention ever becomes a concern.

- **Best-effort `running` status write asserts meta-key health only at settle.**
  `processRun` writes `setStatus(running)` best-effort (logs and proceeds on
  failure) because the *checkpoint* (`ckpt` key) is the durability authority, not
  the *status* (`meta` key). Under a narrow partial-failure mode where the meta
  key specifically is failing writes while the ckpt key succeeds, a (possibly
  side-effecting) resume slice runs before the meta-write fault surfaces — the
  *settle* `setStatus` is checked and returns `err`, triggering a queue retry from
  the last durable checkpoint. Bounded by the single-flight lock; the trade-off is
  that meta-write health is asserted at settle time, not slice entry. Accepted:
  treating the early write as fatal would fail-fast a run whose checkpoint is
  perfectly durable.

## References

- ADR-0013 — `onHumanReview` hook crash retry (`retrying-hook`)
- ADR-0025 — `HumanInterventionEvent` telemetry
- ADR-0021 — `runDag` as the single runtime entry point
- ADR-0005 — two-layer retry rationale (kernel throw → queue retry)
