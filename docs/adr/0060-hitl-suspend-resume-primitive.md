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
  it. Tracked as a follow-up; documented in `packages/host/docs/hitl-teams.md`.

## References

- ADR-0013 — `onHumanReview` hook crash retry (`retrying-hook`)
- ADR-0025 — `HumanInterventionEvent` telemetry
- ADR-0021 — `runDag` as the single runtime entry point
- ADR-0005 — two-layer retry rationale (kernel throw → queue retry)
