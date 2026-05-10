# `@ai-summary/framework` — UX & architecture deep-dive

How the library actually works from a caller's perspective, with and without
the state-machine path, and a precise account of every place Redis touches
the system.

---

## 1. The author UX — building a DAG

Regardless of which execution path runs, the user always defines:

```ts
const node: NodeDef<I, O, E> = {
  id: "fetch",
  kind: "fetch" | "transform" | "llm" | "guardrail" | "eval-judge",
  inputSchema: z.object({ /* … */ }),     // Zod, runtime-checked
  outputSchema: z.object({ /* … */ }),
  deps: ["upstream-id"],
  run: async (input, ctx) => Result.ok(...) | Result.err(...),
  // optional, opt-in features:
  humanReview?: { prompt: "Approve?" },
  retry?: { backoffMs: [1000, 2000, 4000], jitterRatio: 0.2 },
};

// LLM nodes can also declare tools the model may call mid-completion.
// See §7 for details — the framework owns the LLM↔TOOL loop and emits the
// trace tree automatically.

const dag: DagDef = {
  id: "summarize",
  nodes: [...],
  edges: [{ from: "fetch", to: "summarize" }],
  outputNodeId: "summarize",
  evalJudges?: [...],
  defaultRetryLimit?: 3,
  retryLimits?: { summarize: 5 },
};
```

Then they call:

```ts
const result: Result<O, FrameworkError> = await runDag(dag, input, nodeCtx, opts);
```

`Result` is an algebraic `Ok | Err` — no thrown errors at the boundary.
`nodeCtx` (`packages/framework/src/types/node.ts`) carries `runId`, `dagId`,
observer, LLM client, prompts, logger, optional cache/checkpointer, OTel
tracer, and an `AbortSignal`.

---

## 2. The two paths — and the routing rule

`runDag` (`packages/framework/src/executor/executor.ts:66`) inspects the DAG
and the opts to decide:

```text
useStateMachinePath =
   any node has humanReview              // HITL declared
|| dag.defaultRetryLimit !== undefined   // retry policy declared
|| dag.retryLimits has entries           // per-node retry policy
|| opts.jobLike !== undefined            // caller wants durability
|| opts.retryLimits !== undefined        // call-time retry override
```

Otherwise it takes the **legacy fast path**.

There is also a strict bidirectional contract: declaring `humanReview` on a
node **requires** `opts.onHumanReview`, and supplying that hook without a HITL
node also returns an error. Illegal states are unrepresentable at the call
boundary.

---

## 3. Path A — Legacy fast path (no state machine)

This is what runs for the simple summarize-a-customer DAG with no retries and
no human review (e.g. the current `apps/customer-summary` HTTP handler).

### Loop
`runDagInner` (`executor.ts:223`):

1. **Validate DAG shape** (cycles, dup ids, deps↔edges consistency, output
   node exists).
2. **Topo-sort into waves** — sets of nodes whose deps have all been
   satisfied. All nodes in the same wave run via `Promise.all`.
3. For each wave:
   - Build each node's input from upstream outputs (single dep → unwrapped;
     multi-dep → `{ depId: out }` object).
   - `validateInput` (Zod) → `node.run(input, ctx)` → `validateOutput` (Zod)
     → store output in an in-memory `Map<nodeId, unknown>`.
   - Wrap each node call in an OTel span via `withNodeSpan`.
   - Optionally write a checkpoint via `ctx.cache.writeCheckpoint(runId,
     nodeId, value)` — a **hint**, used only for resume, not for retry.
4. Emit observer events: `run-start`, `node-start`, `node-end`, `node-error`,
   `node-skipped`, `run-end`.
5. After the last wave: pick `outputNodeId` (or last node in the last wave),
   return its output.
6. **Eval-judges** (LLM-as-judge) run *after* the result is resolved to the
   caller — "background" work that finalizes the root span asynchronously.
   Caller passes `onBackground(p)` to hold the request open until they
   finish.

### Resume (legacy only)
You pass `opts.resume = { runId, checkpoint: Map<string, unknown> }`. For
each node, if `checkpoint.has(nodeId)`, the framework re-validates the cached
output against the *current* `outputSchema` (catches schema evolution since
the snapshot was taken) and skips execution.

Note that the framework receives the checkpoint as a plain `Map` — it has
no idea where the entries came from. The customer-summary HTTP handler is
the one that reads `chkpt:{runId}` from Redis via `RedisCheckpointer`,
materializes it into a `Map`, and hands it to `runDag`. Redis is the
storage for the resume hint; the executor only sees the in-memory `Map`.

### Failure
First node failure short-circuits the whole run with `Err(FrameworkError)`.
**There is no retry on this path.** Crash = error returned to caller.

### Redis on this path
The framework is Redis-agnostic: `executor.ts` only ever calls
`ctx.cache.writeCheckpoint(...)` against a structural `Cache` /
`Checkpointer` interface — there is no `import 'ioredis'` anywhere in the
fast-path executor. Whether Redis is involved is entirely up to the caller.

The customer-summary app *does* wire Redis: it instantiates
`RedisCheckpointer` (see §5.5) in `apps/customer-summary/src/server.ts` and
passes it as `ctx.cache`. So at runtime, every successful node write hits
`HSET chkpt:{runId}`, and a process restart can reload that hash and pass
it back to `runDag` as `opts.resume`. If a different app passed an
in-memory `Map` adapter or omitted `ctx.cache` entirely, the same fast-path
code would run with zero Redis traffic.

Tracing goes to the OTel collector / MLflow exporter if one is configured,
not Redis — on either path.

---

## 4. Path B — State-machine path

Triggered by retries, HITL, or a durable `JobLike`. The behavior is
fundamentally different: the run becomes a *typed finite-state machine*
whose only side effects are mediated through a `JobLike` checkpoint surface.

### The kernel (`state-machine/runner.ts`)

A pure machine `Machine<S, E, C>`:

```ts
transition(state, event, context) => { state, context }
isTerminal(state) => boolean
isFailed(state) => boolean
stateProgress(state) => 0..100
```

…driven by `runStateMachine(job, machine, executor, opts)` in a loop:

1. If terminal → return.
2. Check `beforeExecute(state, context)` — if it returns false, emit a
   `skipped` trace and **throw** (cooperative abort, e.g. queue shutdown).
3. Call `executor(state, context)` — the executor returns a *typed event*,
   not a state. Any thrown error is caught and converted via
   `errorEventOf(classifyError(raw))` into a typed `ERROR` event.
4. Apply `machine.transition(state, event, context)` to compute next state.
5. **Write order is critical** (FR-005, ADR-3):
   - `appendEvent(event)` — to the durable event log first.
   - `updateData({state, context})` — persist the post-transition state.
   - `updateProgress(pct)` — for queue dashboards.
   - **Never checkpoint a `failed` terminal state** — a queue retry must
     restart from the prior good state, not resume into a failed sink.
6. Emit `onTrace` (post-transition: from-state, to-state, outcome ∈
   `success | retry | skipped | failed`).
7. If `failed` → `throw`. The queue layer catches that and re-enqueues per
   its `attempts` policy.

`retryCounters` is a fresh `Map` per invocation (FR-011), so a queue-level
retry never inherits stale counts from a prior worker attempt. The machine
itself enforces the retry cap; the runner just tracks for trace emission.

### The DAG machine (`dag-runtime/`)

`compileDagToMachine(dag, input)` produces `{ machine, initialContext,
initialState: {kind: "pending"} }`.

`DagPhase` is a discriminated union (`dag-runtime/types.ts`):

- `pending` → `running { wave }` → `running { wave: n+1 }` → … →
  `succeeded { output }`
- `running` → `node-failed` → `retrying { wave, nodeId, attempt,
  nextDelayMs }` → `running` (or `failed` if cap exceeded)
- `running` → `awaiting-human { nodeId, output, prompt, pendingReviews,
  wave }` → `running` on `{action: approve}`, branching for
  `approve-with-edit | reject | reroute`
- `awaiting-human` → `retrying-hook` (if `onHumanReview` itself threw) →
  back to `awaiting-human`

`DagEvent` is the input alphabet: `start | wave-done | node-failed |
human-responded | abort | ERROR`. The transition function is pure — given
`(state, event, ctx)` it returns the next `(state, ctx)`.

### What gets persisted: the checkpoint envelope

After each accepted transition the runner persists `{ state, context }` via
`job.updateData(...)`. That envelope is everything a fresh worker needs to
pick up the run from where the last one left off — there is no other
hidden state.

**`state`** — the current `DagPhase` (enumerated above). The *position*
in the run. Two persistence rules apply on top of the enumeration:

- Intermediate failure states (`node-failed`, `retrying`, `retrying-hook`)
  *are* checkpointed — so the next worker attempt sees them and decides
  what to do (e.g. honour the scheduled backoff).
- Terminal `failed` is **never written** (FR-005). A queue retry must
  restart from the prior good state, not resume into a dead end. The
  runner throws on terminal-failed so BullMQ's retry policy fires
  against the *previous* persisted envelope.

**`context`** — the `DagMachineContext`. The *accumulated work*:
- `outputs: Map<nodeId, unknown>` — the bag of intermediate node results.
  This is the "data the graph has gathered so far": the CRM payload from
  `fetch-customer`, the deal list from `fetch-deals`, the cleaned record
  from `transform`, etc. Keyed by node id.
- `retries: Map<nodeId, number>` — per-node attempt counter at the
  machine level. Distinct from BullMQ's `attemptsMade` — that's the
  job-level counter the queue maintains.
- `dag`, `waves`, `initialInput` — read-only setup data, threaded through
  so executors don't need to close over them.

A mid-run checkpoint for a CRM-summarize DAG, after wave 1 (parallel
fetches) succeeded and the worker is about to start wave 2 (transform),
looks like:

```json
{
  "state": { "kind": "running", "wave": 2 },
  "context": {
    "dag": { "id": "summarize", "...": "..." },
    "waves": [
      ["fetch-customer", "fetch-deals"],
      ["transform"],
      ["summarize"]
    ],
    "outputs": { "__map__": [
      ["fetch-customer", { "id": "cust-123", "name": "Acme", "tier": "enterprise" }],
      ["fetch-deals",    [{ "id": "deal-1", "stage": "won", "amount": 50000 }]]
    ]},
    "retries":      { "__map__": [] },
    "initialInput": { "customerId": "cust-123" }
  }
}
```

(The `__map__` tagging is the §5.7 trick — JSON loses Map identity, so
`serializeValue` wraps it on the way out and `deserializeValue` rebuilds
the Map on the way in.)

#### What `running { wave: N }` actually means

A subtle point: `running { wave: N }` does **not** mean "wave N is in
progress with some nodes done and some pending." It means "wave N is the
*next thing to do* — no node in it has started yet from the perspective
of the durable state."

The wave counter only advances via the transition
`running { wave: N }` + `wave-done` → `running { wave: N+1 }`, and
`wave-done` only fires when **every** node in wave N has succeeded and
the executor has returned all their outputs. So when a fresh worker
reads `running { wave: 2 }` from `data`, that is a guarantee: wave 1
finished cleanly and was checkpointed, wave 2 is the first thing to do.

If wave 2 had *partially* failed (one node ok, one node failed), the
envelope wouldn't say `running { wave: 2 }` — it would say
`retrying { wave: 2, nodeId: "failed-one", attempt: 1, nextDelayMs: 1000 }`,
with `context.outputs` containing the succeeded sibling's output (folded
in by the `node-failed` transition's `partialOutputs`).

#### Resume from this envelope

If the worker process dies right here, BullMQ moves the job back to
`bull:summarize:wait` (or `:delayed` with backoff) and a fresh worker
picks it up. That worker:

1. Reads `data` from the BullMQ job hash → gets the envelope above.
2. `runStateMachine` re-enters the loop with
   `state = running { wave: 2 }`, `context.outputs` pre-populated with
   `fetch-customer` and `fetch-deals` results.
3. The executor's `running` branch starts wave 2 (`["transform"]`), runs
   `transform` with its input materialized from
   `context.outputs.get("fetch-customer")`.
4. CRM and deals are **not** re-fetched: those nodes aren't in wave 2 at
   all. The executor only iterates the current wave.
5. On `wave-done`, the transition bumps state to `running { wave: 3 }`
   with `transform`'s output added to `context.outputs`, and `updateData`
   persists the new envelope. Wave 3 (`summarize`) starts next.

#### Re-execution guarantees: at-most-once vs. at-least-once

The framework gives **two different durability guarantees** depending on
whether a node's output made it to a checkpoint:

- **At-most-once** for any node whose output is already in
  `context.outputs`. On resume the executor sees the output present,
  emits `node-skipped`, and never re-invokes `node.run`. Outputs land in
  `context.outputs` at exactly two transition points: `wave-done`
  (whole-wave success) and `node-failed { partialOutputs }`
  (mid-wave partial success).
- **At-least-once** for any node whose output is *not* yet checkpointed.
  If the worker process is killed (`kill -9`, OOM, hardware failure)
  between the node starting and the next transition write, no transition
  ever fires — the last persisted envelope is whatever was there before
  the wave started. When BullMQ's stalled-job watchdog reclaims the job,
  the new worker re-enters `running { wave: N }` and re-runs every node
  in that wave whose output isn't yet in `context.outputs`, including
  ones that may have actually completed in the dead worker.

This is fundamental, not a framework bug — without distributed
transactions you cannot promise "exactly once" for an external side
effect across a process crash. So:

- A node that completed in wave 1 will not re-run when wave 2 fails and
  retries — its output is checkpointed.
- A node whose entire wave succeeded will not re-run when a *later* wave
  fails — the wave counter has advanced, the wave isn't visited again.
- A node killed mid-execution may run a second time on resume.

For nodes where re-execution is destructive or expensive, the node
author has to make the node idempotent. Common patterns:

- **LLM calls**: cache by input hash via `ctx.cache` *before* the call
  so a re-run is a cache hit. The framework wires `ctx.cache` for
  exactly this.
- **Paid APIs / charges / emails**: pass an idempotency key derived from
  `(runId, nodeId)` so the downstream service deduplicates the request.
  Stripe, SendGrid, etc. all support this.
- **DB writes**: upsert by `(runId, nodeId)` or use
  `INSERT ... ON CONFLICT DO NOTHING`, so a second invocation is a
  no-op.

The `outputs` Map *is* the resume cache for the read-only / pure side of
the graph. For nodes whose `run` has external side effects, idempotency
is the node author's contract with the framework.

#### Why this is event-sourced too

Every transition that produced this envelope was also `XADD`-ed to
`events:summarize:{jobId}` *before* the `updateData` write (FR-005 order:
`appendEvent` → `updateData` → `updateProgress`). So the envelope and the
event log are redundant by design:

- **Envelope** = "current snapshot, ready to resume in O(1)."
- **Event log** = "full audit trail, replayable from scratch in O(events)."

#### What replay actually does (and doesn't)

The replay function (`state-machine/replay.ts`) is the entire mechanism,
and it's deliberately tiny:

```ts
export const replayEvents = <S, E, C>(
  events: readonly E[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
): { state: S; context: C } => {
  let current = initial;
  for (const event of events) {
    current = machine.transition(current.state, event, current.context);
  }
  return current;
};
```

That's it. A pure fold of the event list through the pure `transition`
function. **`replayEvents` does not call the executor.** It does not
re-run any node. It does no I/O. It touches no database, no LLM, no API.

It can do this because each event already carries the data the
executor produced. Look at `DagEvent`
(`dag-runtime/types.ts`):

```ts
type DagEvent =
  | { type: "start" }
  | { type: "wave-done"; wave: number; outputs: ReadonlyMap<string, unknown> }
  | { type: "node-failed"; nodeId: string; error: FrameworkError;
      partialOutputs?: ReadonlyMap<string, unknown>; coFailedNodeIds?: readonly string[] }
  | { type: "human-responded"; nodeId: string; action: HumanAction }
  | { type: "abort"; reason: string }
  | { type: "ERROR"; retriable: boolean; error: string };
```

A `wave-done` event embeds the outputs the wave produced. A `node-failed`
event embeds the error and any partial outputs from succeeded siblings.
A `human-responded` event embeds the human's decision. So when
`transition` folds `wave-done` into the next state, the `outputs` Map is
populated *from the event payload*, not from re-executing nodes.

#### A worked replay

Every event written via `appendEvent` is wrapped in a `RecordedEvent`
envelope: `{ recordedAtMs, event }` where `recordedAtMs` is the
wall-clock at write time and `event` is the raw `DagEvent`. The
`EventLogReader.readEvents(queueName, jobId)` method returns these
envelopes in insertion order.

Suppose the event stream for `events:summarize:run-abc-123` contains, in
order (Redis entry IDs are pinned to `recordedAtMs` — see §5.2):

```
1715200000000-0  type=start       payload={"recordedAtMs":1715200000000,
                                            "event":{"type":"start"}}
1715200000123-0  type=wave-done   payload={"recordedAtMs":1715200000123,
                                            "event":{"type":"wave-done","wave":0,"outputs":{"__map__":[
                                              ["fetch-customer", {"id":"cust-123","name":"Acme"}],
                                              ["fetch-deals", [{"id":"deal-1","amount":50000}]]
                                            ]}}}
1715200001456-0  type=wave-done   payload={"recordedAtMs":1715200001456,
                                            "event":{"type":"wave-done","wave":1,"outputs":{"__map__":[
                                              ["transform", {"customer":"Acme","totalRevenue":50000}]
                                            ]}}}
1715200002789-0  type=node-failed payload={"recordedAtMs":1715200002789,
                                            "event":{"type":"node-failed","nodeId":"summarize",
                                                     "error":{"kind":"transient","message":"OpenAI 503"}}}
```

Calling `replayEvents(events, machine, { state: pending, context: emptyCtx })`
folds through the transitions (ignoring `recordedAtMs`, which is
metadata):

| Step | Event | Resulting state | `context.outputs` after |
|---|---|---|---|
| 0 | (initial) | `pending` | `{}` |
| 1 | `start` | `running { wave: 0 }` | `{}` |
| 2 | `wave-done { wave: 0 }` | `running { wave: 1 }` | `{ fetch-customer, fetch-deals }` |
| 3 | `wave-done { wave: 1 }` | `running { wave: 2 }` | `{ ..., transform }` |
| 4 | `node-failed { summarize }` | `retrying { wave: 2, nodeId: summarize, attempt: 1 }` | `{ ..., transform }` |

Final return: `{ state: retrying { wave: 2, ... }, context: { outputs: {fetch-customer, fetch-deals, transform}, retries: { summarize: 1 } } }`.

No node was called. No CRM API hit. No LLM token spent. The `summarize`
node that originally failed against OpenAI 503 is *not* re-attempted by
replay — replay only re-derives the *bookkeeping*. Re-execution (calling
`node.run` again with backoff) is what `runStateMachine` does *after*
replay puts the machine back into the right state.

#### When replay is used

Replay is the recovery primitive for the state-machine path, but it's
not the *only* one. The framework has two ways to put a worker back into
the right state:

1. **Envelope-based resume** (default): the new worker reads the
   `data` field from the BullMQ job hash → instantly has
   `{state, context}`. O(1) Redis operations: `HGET data`. This is what
   happens on every normal queue retry. The event log is not consulted.
2. **Replay-based resume** (debugging / disaster recovery / SC-004
   verification / forensic queries): read the event stream via
   `EventLogReader`, fold through `replayEvents` from a known initial
   state. Currently used for:
   - **Corruption recovery.** The `data` field is suspect or corrupt
     and you want to reconstruct state from the immutable audit trail.
   - **SC-004 verification.** Run a job, capture its event log + final
     envelope, run `replayEvents` from scratch, assert the result equals
     the envelope. If it doesn't, either `transition` isn't pure or the
     event log is missing transitions — either is a bug.
   - **Replay-to-cursor (by index).** `replayEvents` is just a fold,
     so you can pass any prefix of the events array
     (e.g. `events.slice(0, n)`) to reconstruct state after the first
     `n` transitions.
   - **Replay-to-timestamp (by wall-clock).** `replayEventsUntil(events,
     machine, initial, untilMs)` answers "what was the state just before
     `untilMs`?". Server-side variant: `reader.readEventsBetween(
     queueName, jobId, fromMs, toMs)` pushes the filter into Redis
     (`XRANGE` with ms-prefixed bounds) so large logs don't transit the
     wire just to be discarded.

   ##### How to address a stream

   To replay anything you need exactly two identifiers:

   - **`queueName`** — the BullMQ queue (e.g. `"summarize"`). Static.
   - **`jobId`** — the per-job id you assigned when enqueueing
     (`queue.enqueue("run-abc-123", …)`). The HTTP handler that enqueued
     the run typically returns this to its caller as `runId`; persist it.

   Three ways to get a `jobId`:

   1. You already have it — a `runId` returned to the API caller.
   2. `await queue.getJobs(['failed', 'completed'])` enumerates jobs
      with their `.id` populated. Useful for ad-hoc debugging.
   3. `KEYS events:summarize:*` against Redis returns stream keys; strip
      the prefix. Slow on large keyspaces; last-resort forensics.

   With both in hand:

   ```ts
   const reader = createRedisStreamReader(redis);

   // Full log → final state (== what's in job.data already)
   const events = await reader.readEvents("summarize", jobId);
   const final  = replayEvents(events, machine, initialFromCheckpoint);

   // "What was the state at noon?" — client-side filter
   const atNoon = replayEventsUntil(events, machine, initial, noonMs);

   // Same question, server-side filter (cheaper for long logs)
   const slice          = await reader.readEventsBetween("summarize", jobId, 0, noonMs);
   const atNoonViaSlice = replayEvents(slice, machine, initial);
   ```

   The runtime never replays automatically — it's something *you* invoke
   from a debugging tool, REPL, admin endpoint, or test. Resume during
   normal queue retries uses the envelope (`job.data`), not the event
   log; replay is the audit/forensic path.

   #### What replay can't do today (remaining gaps)

   - **Cross-machine-version replay.** If the `Machine` definition has
     changed since the events were written (new event variants, removed
     phases, modified transition semantics), replay through the *current*
     machine is not guaranteed to produce a meaningful state. The event
     stream is stable; the transition function is not. Migrations need
     bespoke handling — there's no built-in versioning of machines yet.
   - **Replay of side effects.** Replay reconstructs machine state, not
     external effects. See "What replay can't do" below.

So in normal operation replay is dormant. Its existence is what makes
the envelope *trustworthy* — the envelope is "just a cache" in the sense
that it can always be rebuilt from the log. SC-004 is the regression
test that keeps this property honest.

#### What replay can't do

Replay reconstructs **machine state**, not **side effects**. If the
original run sent an email at wave 2, replaying the event stream does
not re-send that email — there's no executor invocation. Conversely, if
you want to *resume* the run (continue from where it left off and
actually execute the next wave), replay alone is not enough; you need
`runStateMachine` to take the replayed `{state, context}` and drive the
executor forward. Replay is "rewind to here," not "fast-forward through
side effects."

### The executor (`buildDagExecutor`)
The side-effect side. Switches on `state.kind`:

- `pending` → returns `{ type: "start" }`.
- `running { wave }` → runs all wave nodes via `Promise.all`. Already-
  completed nodes (output present in `ctx.outputs` from a prior attempt) are
  skipped — emits `node-skipped`. Returns `wave-done` with new outputs, or
  `node-failed` carrying the primary failure plus `partialOutputs`
  (succeeded siblings to persist) and `coFailedNodeIds` (for correct
  retry-counter accounting on simultaneous failures).
- `retrying` → sleeps `nextDelayMs * (1 + jitterRatio * random())`, then
  re-runs the wave. Successful siblings short-circuit because their outputs
  are already in `ctx.outputs`.
- `awaiting-human` → calls `opts.onHumanReview({nodeId, output, prompt})`.
  Hook can be async and arbitrarily long. Returns `human-responded
  { action }`. If the hook *throws*, that failure is itself retried
  (`retrying-hook`) — node output is preserved, only the hook is re-called.
- `succeeded | failed` → unreachable; runner's `isTerminal` guards.

### Output

`runDagStateful` (`run-dag-stateful.ts:77`) wraps the run, opens an OTel
root span, emits `run-start`/`run-end` observer events even for compile
failures, runs eval-judges either inline or via `onBackground` (legacy
parity), and `match`es on the terminal state to return `Ok(output)` or
`Err(error)`.

`runDagAsWorkerJob` is the BullMQ worker entrypoint — **same as
`runDagStateful`, but rethrows on `Err`** so BullMQ sees the failure and
applies its retry/DLQ policy. Without this, a worker would silently ack
failed jobs.

---

## 5. Redis — exactly where and how

The framework has a hard architectural rule (FR-082): **only files under
`queue-bullmq/**`, `cache/redis-cache.ts`, and
`checkpoint/redis-checkpointer.ts` may import `bullmq` or `ioredis`.**
Everything else — the executor, the state machine, the DAG runtime, the
queue interfaces — talks to opaque structural interfaces (`JobLike`,
`MarkerStore`, `EventLogReader`, `Cache`, `Checkpointer`). Whether Redis
is involved at runtime is a wiring decision the caller makes, not
something the framework assumes. Redis usage is split across **five
distinct concerns**, each with its own key namespace, data type, and
lifecycle.

### Architectural boundary

```
┌─────────────────────────────────────────────────────────┐
│  state-machine/**, dag-runtime/**, executor/**, queue/  │  ← pure, no Redis imports
├─────────────────────────────────────────────────────────┤
│  queue-bullmq/**       │  cache/redis-cache.ts          │  ← only files allowed
│                        │  checkpoint/redis-checkpointer │     to import ioredis
└─────────────────────────────────────────────────────────┘
```

Core code only ever sees opaque interfaces: `JobLike`, `MarkerStore`,
`EventLogReader`, `ContextCacheAdapter`, `Checkpointer`. Swapping Redis for
something else is an adapter change, not a core rewrite.

### Redis usage at a glance

| Concern | Key shape | Redis primitive | Owner |
|---|---|---|---|
| Job queue | `bull:{queueName}:*` | Lists, ZSets, Hashes (BullMQ-managed) | BullMQ |
| Job state checkpoint | inside the BullMQ job hash | `HSET` (via `Job.updateData`) | BullMQ |
| Per-job event log | `events:{queueName}:{jobId}` | **Stream** (`XADD`/`XRANGE`) | `adaptBullMQJob` |
| Idempotency markers | `scheduler:{taskId}:fired` etc. | String w/ TTL (`SET EX`) | `createRedisMarkerStore` |
| App-level cache | caller-defined | String w/ TTL | `RedisCache` |
| Resume checkpoints | `chkpt:{runId}`, `chkpt:{runId}:meta` | Hash + String, TTL 24h | `RedisCheckpointer` |

The first three are framework-managed. The last three are caller-wired
adapters that the framework consumes through structural interfaces.

---

### 5.1 Job queue & worker (BullMQ)

**File:** `packages/framework/src/queue-bullmq/adapter.ts`

`createBullMQBackend(connection, eventLogOpts)` returns a `QueueBackend`. It
opens **two** logical Redis usages:

1. **A shared `ioredis` client** — used directly by `adaptBullMQJob` for
   `XADD`/`XRANGE` against the per-job event log. Configured with
   `maxRetriesPerRequest: null`, `enableReadyCheck: false`,
   `lazyConnect: false` (BullMQ's recommended settings for a long-lived
   client used inside workers).
2. **BullMQ's internal connection pool** — created when you instantiate
   `new Queue` and `new Worker`. BullMQ manages this internally; it uses
   blocking commands (`BRPOPLPUSH`, `BZPOPMIN`) which is why it needs its
   own pool.

#### Producer side
```ts
const q = backend.createQueue<DagPhase, DagMachineContext>("summarize");
await q.enqueue(jobId, { state: initialState, context: initialContext },
                { attempts: 3, jobId, priority: 1, delayMs: 0 });
```

Internally `queue.add(name, serializeValue(data), opts)` — `serializeValue`
tags Map/Set values for safe JSON round-trip (see §5.7).

BullMQ stores the envelope in standard BullMQ keys (`bull:summarize:wait`,
`bull:summarize:active`, `bull:summarize:delayed`, `bull:summarize:id`,
plus per-job hashes). Dedup via `jobId` is BullMQ-native: `queue.add` with
the same `jobId` is silently ignored.

#### Worker side
```ts
backend.createWorker("summarize", async (jobLike) => {
  await runDagAsWorkerJob(dag, input, ctx, { jobLike });
}, { concurrency: 4 });
```

`adaptBullMQJob` wraps the BullMQ `Job` as a `JobLike`:

| `JobLike` method | BullMQ / Redis call |
|---|---|
| `data` (getter) | `deserializeValue(job.data)` — no Redis hit; the worker already fetched the job's hash into memory when it picked the job up. Returns the `{state, context}` envelope (see §4 "checkpoint envelope") |
| `updateData(d)` | `job.updateData(serializeValue(d))` → `HSET bull:{queueName}:{jobId} data <json>` — overwrites the `data` field on the per-job hash with the new envelope |
| `updateProgress(pct)` | `job.updateProgress(pct)` → `HSET bull:{queueName}:{jobId} progress <pct>` — surfaces in BullMQ Board and `QueueEvents` listeners |
| `appendEvent(e)` | direct `redis.xadd` against the shared connection: `XADD events:{queueName}:{jobId} MAXLEN ~ N * type <t> payload <json>` (see §5.2) |

A real BullMQ job hash mid-run might look like:

```
HGETALL bull:summarize:run-abc-123
  name         → "summarize"
  data         → '{"state":{"kind":"running","wave":2},"context":{...}}'
  progress     → 50
  attemptsMade → 0
  opts         → '{"attempts":3,"jobId":"run-abc-123","priority":1}'
  timestamp    → 1715200000000
  ...
```

The `data` field is the entire checkpoint envelope. `updateData` is a
single-field overwrite — BullMQ doesn't merge, the runner sends the full
new envelope every transition. That's why the envelope must be
self-contained and why `serialize/deserialize` has to round-trip every
field type the context can carry.

#### Failure path
When `runStateMachine` throws (terminal-failed), `runDagAsWorkerJob`
rethrows. BullMQ catches the rejected promise, increments `attemptsMade`,
and either:
- Re-enqueues onto the delayed set with backoff (`bull:summarize:delayed`),
  invoking the worker again with the **last persisted** `{state, context}`
  envelope (NOT the failed state — failed states are never checkpointed).
- Or, when `attemptsMade >= max`, moves the job to `bull:summarize:failed`
  and fires the `failed` event.

`WorkerHandle.onFailed(handler)` fires on every failure (including
mid-retry) with `(id, err, attemptsMade, max)`. `attachDeadLetterHandler`
filters for `attemptsMade >= max` and delegates to a `DeadLetterNotifier`
(Slack/email/PagerDuty — caller-supplied).

#### Connection error handling
`adapter.ts` attaches default `error` listeners to both the shared client
and the worker so transient Redis connectivity errors don't crash Node with
unhandled rejections. Callers can override `worker.onError(handler)` for
custom alerting.

---

### 5.2 Per-job durable event log — Redis Streams

**File:** `packages/framework/src/queue-bullmq/job.ts`
**ADRs:** `docs/adr/0003-event-sourcing-redis-streams.md`,
`docs/adr/0008-event-envelope-and-time.md`

This is the heart of event-sourced replay (SC-003 crash-resume,
SC-004 replay-equivalence) and the substrate for forensic replay-to-
timestamp queries.

#### Key shape
`events:{queueName}:{jobId}` — one stream per job. Per-job key isolation
means:
- A chatty job cannot evict a quiet job's history (per-stream `MAXLEN`).
- Reading a single job's history is `XRANGE one-key` instead of a global
  scan-with-filter.
- Cleanup of a finished job is `DEL one-key`.

#### The event envelope (`RecordedEvent<E>`)

Every event is wrapped at write time in a transport-independent envelope:

```ts
interface RecordedEvent<E> {
  readonly recordedAtMs: number;  // wall-clock at appendEvent boundary
  readonly event: E;              // raw DagEvent (or whatever the runner produced)
}
```

The envelope is added by the `JobLike.appendEvent` implementation, so
the contract works identically for the BullMQ adapter, the in-memory
adapter, and any future backend. Domain `DagEvent` types stay
unchanged — `transition` keeps consuming raw events. Time-of-recording
is metadata, not state.

#### Append (`appendEvent`)
Every accepted machine transition writes one stream entry:

```
XADD events:{queueName}:{jobId} MAXLEN ~ 10000 ${recordedAtMs}-* type <type> payload <json>
```

- **`MAXLEN ~ 10000`** — approximate trimming so XADD stays O(1).
  Configurable via `EventLogOpts.maxLen`. `approximate=false` switches to
  exact `MAXLEN 10000` (slower; rarely needed).
- **`${recordedAtMs}-*`** — entry ID. The millisecond portion is **pinned
  to the envelope's `recordedAtMs`**; Redis auto-assigns the seq portion
  (`-0`, `-1`, …) on collision. This ensures `XRANGE` bounds (used by
  `readEventsBetween`, see below) align exactly with `recordedAtMs` —
  filtering by entry ID *is* filtering by `recordedAtMs`.
- **Two fields**: `type` (string, derived from `event.type` for cheap
  filtering) and `payload` (full envelope `{recordedAtMs, event}` as JSON
  via `serializeValue` → `JSON.stringify`).
- **`now()` injection.** `EventLogOpts.now` defaults to `Date.now`; tests
  inject deterministic clocks. The clock must be monotonic non-decreasing
  per stream — if `now()` goes backwards, Redis rejects the `XADD`
  (entry IDs must be strictly increasing).

#### Read (`createRedisStreamReader`)
**File:** `packages/framework/src/queue-bullmq/event-log.ts`

```ts
interface EventLogReader {
  readEvents(queueName: string, jobId: string)
    : Promise<readonly RecordedEvent<unknown>[]>;
  readEventsBetween(queueName: string, jobId: string, fromMs: number, toMs: number)
    : Promise<readonly RecordedEvent<unknown>[]>;
}
```

`readEvents` issues `XRANGE events:{queueName}:{jobId} - +` and returns
every entry in insertion order, parsed back into envelopes.

`readEventsBetween` issues `XRANGE events:{queueName}:{jobId} ${fromMs}-0 ${toMs - 1}-<MAX_SEQ>`
and returns only the entries whose `recordedAtMs` falls in the half-open
window `[fromMs, toMs)`. The filter runs server-side on Redis — important
for long event streams where transferring everything just to discard most
of it would be wasteful.

The reader extracts the `payload` field, `JSON.parse`s it, and runs
`deserializeValue` to restore Map/Set instances. Corrupt JSON throws with
the stream key + entry id so it's debuggable.

##### Backward compatibility for legacy bare-payload entries

Streams written before the envelope contract existed (entries where
`payload` is the raw event, not `{recordedAtMs, event}`) remain readable
without any backfill. The reader detects bare payloads via shape check
and synthesizes an envelope with `recordedAtMs` parsed from the Redis
Stream entry ID's millisecond prefix. So:

- A stream that is entirely pre-envelope reads as if every entry had been
  envelope-wrapped using the original write-time clock.
- A stream that is partly old / partly new (a job that ran across the
  rollout) reads cleanly — each entry is detected independently.

#### Replay flow
```ts
const reader = createRedisStreamReader(redis);
const events = await reader.readEvents("summarize", jobId);
const { state, context } = replayEvents(events, machine, initialFromCheckpoint);
```

Because `transition` is pure, replay is deterministic. SC-004 is the
regression guard: replaying the recorded events must yield the same final
state as the original run.

#### Time-bounded replay flow

Two equivalent ways to answer "what was the state at noon?":

```ts
// Client-side filter (full log over the wire, then filtered locally).
const events = await reader.readEvents("summarize", jobId);
const atNoon = replayEventsUntil(events, machine, initial, noonMs);

// Server-side filter (only matching entries leave Redis).
const slice  = await reader.readEventsBetween("summarize", jobId, 0, noonMs);
const atNoon = replayEvents(slice, machine, initial);
```

Both produce the same `{state, context}`. Prefer `readEventsBetween` when
the log is large or the window is narrow — for an admin endpoint scanning
20 jobs to render a timeline, the server-side variant cuts Redis→app
bandwidth by orders of magnitude.

`replayEventsBetween(events, machine, initial, fromMs, toMs)` is also
available — note its semantic: it folds *only* the events in the window
starting from `initial`, which is **not** the same as "fast-forward from
the state at `fromMs`." Useful for diff-style queries paired with two
`replayEventsUntil` calls.

#### Bounding & TTL
- `MAXLEN ~ N` caps growth at insert time — no separate trim job.
- ADR-3 specifies an `EXPIRE` on terminal phase (default 7d) to release
  Redis memory after job success. This is the documented intent; if not
  yet wired in code, the stream simply persists until evicted by `MAXLEN`
  rotation or a manual `DEL`.

#### Why Streams (not Lists, not Pub/Sub)
- `LPUSH`/`LRANGE` doesn't give server-assigned ordered IDs — we'd have to
  invent them and risk clock skew.
- Pub/Sub is fire-and-forget — no replay possible for a worker that just
  came online.
- Streams give append + ordered range scan + bounded retention + (future)
  consumer groups for fan-out observability — exactly the four properties
  the runtime needs.

---

### 5.3 Idempotency markers — `SET key 1 EX <ttl>`

**File:** `packages/framework/src/queue-bullmq/markers.ts`

`createRedisMarkerStore(redis)` exposes the structural `MarkerStore`:

```ts
set(key, ttlSeconds): Promise<void>     // SET key 1 EX <ttl>  (re-set resets TTL)
exists(key):           Promise<boolean>  // EXISTS key
delete(key):           Promise<void>     // DEL key
```

Used by `CronScheduler` (`scheduler/scheduler.ts`) for two key families:

- **`scheduler:{taskId}:fired`** — set when the scheduler enqueues a task.
  Prevents duplicate enqueue when timers race after worker restarts or
  clock skew. The TTL is the cron interval; the marker dies before the next
  fire window.
- **`scheduler:{taskId}:completed`** — set when a scheduled task finishes
  successfully. Used by `resolveDependents` to gate downstream tasks: a
  dependent fires only if every upstream task is `completed` within its
  validity window (TTL = upstream completion freshness).

This is "leases via Redis" — the simplest possible distributed mutex
substrate. No SETNX races because we use plain `SET EX` (the marker
existing is the lease; resetting it just extends it).

---

### 5.4 App-level cache — `RedisCache`

**File:** `packages/framework/src/cache/redis-cache.ts`

A trivial `Cache` adapter:

```ts
get<T>(key)            → GET key   → JSON.parse
set<T>(key, val, ttl)  → SET key <json> EX <ttl>
```

This is what nodes use through `ctx.cache` for memoizing LLM calls and
similar read-mostly content. Errors are returned as
`Err({kind: "cache-error", operation, message})` — the framework never
throws across this boundary, so a Redis outage degrades to "cache miss",
not "request failure", at the caller's discretion.

---

### 5.5 Resume checkpoints — `RedisCheckpointer`

**File:** `packages/framework/src/checkpoint/redis-checkpointer.ts`

Used by the **legacy fast path** for crash-resume. Two key families per run:

| Key | Type | Contents |
|---|---|---|
| `chkpt:{runId}:meta` | String | JSON: `dagId`, `startedAt`, `nodeCount`, `subject`, `dagFingerprint`, `frameworkVersion`, `createdAt` |
| `chkpt:{runId}` | Hash | field=`nodeId`, value=JSON `{nodeId, output, completedAt}` |

**TTL = 24h.** Set with `SET … EX 86400` for meta and renewed via `EXPIRE`
on every `saveNode` call so meta + nodes always expire together.

Reads use `HGETALL` to load every completed node in a single round-trip,
plus a `GET` for meta. The handler in `apps/customer-summary/src/server.ts`
applies these guards before resuming:

- `meta.subject !== customer_id` → 404 (IDOR protection — prevents resuming
  another customer's run with a guessed `runId`).
- `meta.dagFingerprint !== dagFingerprint(currentDag)` → 409 (DAG shape has
  changed since the snapshot; cached outputs may not satisfy evolved
  schemas).
- `meta.frameworkVersion !== FRAMEWORK_VERSION` → 409 (semantics may have
  changed across framework versions).

This is **independent of the state-machine path** — the SM path uses BullMQ
job state + the Streams event log instead.

---

### 5.6 Checkpoint vs. event log — two different "durability" answers

The library has **two answers to "how do we recover from a crash"**, which
correspond to the two paths:

| Question | Legacy fast path | State-machine path |
|---|---|---|
| Where is the durable state? | `chkpt:{runId}` hash | BullMQ job hash (`updateData`) |
| Where is the audit/history? | Nowhere (just observer events) | `events:{queueName}:{jobId}` Stream |
| Recovery primitive | Re-validate cached node outputs against current schemas | Replay events through pure `transition` from last checkpoint |
| Survives schema evolution? | Yes — Zod re-validates each cached output | Yes — terminal states are never checkpointed; replay re-runs through current code |
| Survives DAG topology change? | No — fingerprint guard rejects mismatches | No — same; producer must enqueue with current shape |
| Used by | The HTTP `/summarize` resume flow | BullMQ workers |

---

### 5.7 Map/Set safety across Redis

**File:** `packages/framework/src/state-machine/serialize.ts`

The `DagMachineContext.outputs` is a `Map<string, unknown>` and other parts
of state may carry `Set` instances. JSON loses these. `serializeValue`
recursively tags them:

```js
new Map([["a", 1]])  →  { "__map__": [["a", 1]] }
new Set([1, 2])      →  { "__set__": [1, 2] }
```

`deserializeValue` inverts the tagging. This is applied on **every** Redis
write path that takes typed state or events:

- `adaptBullMQJob.updateData` — `serializeValue(d)` before `job.updateData`.
- `adaptBullMQJob.appendEvent` — `serializeValue(event)` before
  `JSON.stringify`.
- `createRedisStreamReader.readEvents` — `deserializeValue` after
  `JSON.parse`.
- Producer-side `queue.enqueue` — `serializeValue(data)` before
  `queue.add`.

Without this, a `state.context.outputs` Map silently becomes `{}` on the
next worker hop. The tag scheme is invisible to downstream consumers
because the boundary is sealed by these adapters.

---

### 5.8 What Redis does **not** do

- The pure `Machine` lives entirely in memory inside a worker. State
  transitions are computed locally; Redis is only the *checkpoint sink* and
  *event log sink* (via `JobLike`) plus the *queue substrate* (via BullMQ).
- Tracing does not go through Redis. Spans are emitted via OTel to whatever
  exporter is configured (MLflow in the customer-summary app).
- The framework does **not** store the `Machine` definition in Redis.
  Workers must boot with the same compiled DAG; ADR-3 calls out that
  topology change requires producer-side handling, not server-side
  migration.

---

## 6. End-to-end UX comparison

### Without state machine — one-shot DAG, no retries, no HITL
```ts
const result = await runDag(dag, input, ctx);  // synchronous w.r.t. caller
// → result.ok ? render : surface error
```
- Caller awaits the whole pipeline.
- Crash mid-run = lost work unless the caller wired a `Checkpointer` into
  `ctx.cache` *and* passes `opts.resume` with the reloaded checkpoint on
  retry. The executor never persists anything itself; it just calls
  `ctx.cache.writeCheckpoint(...)` if the adapter is present.
- Redis: only if you wired `RedisCheckpointer` (or any other Redis-backed
  adapter) yourself. The fast-path executor has no Redis dependency.
- Latency: best case (LLM I/O dominates).

### With state machine — durable, retried, HITL-capable
```ts
// Producer side (HTTP handler):
await queue.enqueue(jobId, { state: initialState, context: initialContext });
return c.json({ runId: jobId, status: "queued" }, 202);

// Worker side:
backend.createWorker("summarize", async (job) =>
  runDagAsWorkerJob(dag, input, ctx, {
    jobLike: job,
    onHumanReview: async ({ nodeId, output, prompt }) => {
      // park to DB, await ticket resolution (could be days)
      return { action: "approve" };
    },
  })
);
```
- Caller's request returns immediately with a runId.
- Worker drives the machine; every transition is an `XADD` +
  `updateData` + `updateProgress` round-trip to Redis. Progress is
  observable in BullMQ Board and audit-replayable from Streams.
- Failures retry per-node (machine-level: `retrying` with backoff+jitter)
  **and** per-job (queue-level: BullMQ `attempts`). `runDagAsWorkerJob`
  rethrows so both layers cooperate — machine failure exhausts node retries
  → job throws → BullMQ moves to retry → fresh invocation starts with
  `retryCounters` reset (FR-011). Eventually `onFailed` fires → DLQ
  notifier.
- `awaiting-human` parks the machine; the worker thread is free as soon as
  the hook resolves. For long-poll HITL (hours/days), the typical pattern
  is:
  1. The runner reaches `awaiting-human { nodeId, output, prompt, wave }`
     and persists that envelope via `updateData` *before* invoking the
     hook (so the parked state is durable even if the worker dies during
     the hook call).
  2. `onHumanReview` writes a row to a "pending reviews" table keyed by
     `(jobId, nodeId)` with the prompt and a webhook to call when a
     human responds, then *throws* (or returns a sentinel) to release the
     worker.
  3. When the human responds, the webhook handler re-enqueues the job
     with the same `jobId`. BullMQ dedup is silently a no-op if the job
     is still active, but in this pattern the previous attempt failed
     out, so the new enqueue takes effect.
  4. A worker picks the job up, reads `data` → sees
     `state: awaiting-human`, calls `onHumanReview` again. This time the
     hook looks up the (now-resolved) review row and immediately returns
     `{ action: "approve" }` (or whichever).
  5. Machine transitions back to `running` with the original output
     already in `context.outputs`, and continues from the next wave.

  The output produced by the gated node is preserved across all of this
  because it lives in the persisted `awaiting-human` state itself
  (`state.output`) and gets folded into `context.outputs` on transition,
  not re-computed.
- Eval-judges still run; under `onBackground` they finalize the trace span
  without blocking the run's `Ok(output)` resolution.

The two paths share the *same node abstraction, same Zod validation, same
observer events, same root-span structure* — the difference is purely in
how state and failures are persisted and replayed. The legacy path is a
degenerate special case of the durable one, kept as a fast path for SC-001
(no behavioral change for trivial DAGs).

---

## 7. Tool calls in LLM nodes

`LlmClient.sendWithTools` lets an LLM node declare tools the model can call
mid-completion. The framework owns the `LLM → TOOL → LLM → TOOL → …` loop:
tool calls are dispatched, results re-fed to the model, and the loop ends
when the model emits a parseable answer matching the request schema. The
full trace tree appears in MLflow (or any OTel consumer) automatically —
no per-tool span wiring on the caller's side.

### 7.1 The shape of a tool

```ts
import { z } from "zod";
import type { ToolDef } from "@ai-summary/framework";

const lookupDealsByCustomer: ToolDef<
  { customerId: string; limit?: number },
  { deals: Array<{ id: string; amount: number; closedAt: string }> }
> = {
  name: "lookup_deals_by_customer",          // ^[A-Za-z0-9_-]{1,64}$
  description: "Fetch closed deals for a customer (most recent first).",
  inputSchema: z.object({
    customerId: z.string(),
    limit: z.number().int().positive().max(50).default(20),
  }),
  outputSchema: z.object({
    deals: z.array(z.object({
      id: z.string(),
      amount: z.number(),
      closedAt: z.string(),
    })),
  }),
  run: async ({ customerId, limit }, ctx) => {
    // Any async I/O. ctx.cache, ctx.logger, ctx.signal are all in scope.
    const deals = await crm.deals(customerId, limit);
    return { deals };
  },
};
```

`inputSchema` translates to JSON Schema for the provider; `outputSchema`
is validated *after* `run` returns. Validation failures and thrown errors
both become `is_error: true` results that the model sees and can react to
— they don't crash the node.

### 7.2 Calling `sendWithTools` from an LLM node

```ts
import { z } from "zod";
import { createLlmNode } from "@ai-summary/framework";

const Summary = z.object({
  summary: z.string(),
  totalDealValue: z.number(),
});

const enrichSummaryNode = createLlmNode({
  id: "enrich-summary",
  inputSchema: z.object({ customerId: z.string() }),
  outputSchema: Summary,
  deps: ["fetch-customer"],
  promptName: "enrich-summary",
  model: "claude-sonnet-4-5",
  buildInput: (i) => i,
  // Custom run override — uses the framework's tool surface directly.
  run: async (input, ctx) => {
    if (!ctx.llm) return err({ kind: "node-crash", nodeId: "enrich-summary", message: "no llm" });
    const result = await ctx.llm.sendWithTools(
      {
        system: "You are a CRM analyst. Use tools to gather facts before summarizing.",
        user: `Summarize customer ${input.customerId}.`,
        model: "claude-sonnet-4-5",
        tools: [lookupDealsByCustomer],
        schema: Summary,
        maxIterations: 5,
      },
      ctx,
    );
    if (!result.ok) return result;
    return ok(result.value.output);
  },
});
```

Two argument shapes deserve attention:

- `req` — data the *caller* curated (prompts, tools, schema, iteration cap).
- `ctx` — the *node-runtime* surface (tracer, logger, cache, signal). Tools
  receive this same `ctx` so they can memoize via `ctx.cache.set` or honor
  `ctx.signal` for long I/O.

### 7.3 What gets traced

The trace tree under the parent node span looks like:

```
node:enrich-summary [CHAIN]
├── chat claude-sonnet-4-5 [CHAT_MODEL]
│       gen_ai.system="anthropic"
│       gen_ai.usage.input_tokens=412
│       gen_ai.usage.output_tokens=87
├── execute_tool lookup_deals_by_customer [TOOL]
│       gen_ai.tool.name="lookup_deals_by_customer"
│       gen_ai.tool.call.id="toolu_01..."
│       gen_ai.tool.is_error=false
├── chat claude-sonnet-4-5 [CHAT_MODEL]
│       gen_ai.usage.input_tokens=520
│       gen_ai.usage.output_tokens=140
└── (final answer parsed against schema)
```

All attributes follow OpenTelemetry GenAI semantic conventions, so MLflow's
typed-span renderer picks them up natively.

### 7.4 Error policy

| What                                         | What the model sees             | What the caller sees              |
| -------------------------------------------- | ------------------------------- | --------------------------------- |
| Tool body throws                             | `tool_result` with `is_error`   | Loop continues; final answer Ok   |
| Tool returns Zod-invalid output              | `tool_result` with `is_error`   | Loop continues; final answer Ok   |
| Model calls a tool name that wasn't declared | `tool_result` with `is_error`   | Loop continues; final answer Ok   |
| Iteration cap (`maxIterations`) reached      | n/a                             | `Err({ kind: "transient" })`      |
| `req.signal` aborted between turns           | n/a                             | `Err({ kind: "aborted" })`        |
| Final answer not valid JSON for `schema`     | n/a                             | `Err({ kind: "node-crash" })`     |

The `transient` error variant is meant to be retried by the LLM-node retry
policy (per ADR 0005); `node-crash` is treated as terminal unless the
node's retry config says otherwise.

### 7.5 Idempotency

Same advice as §4: **the loop runs all tools at least once per node retry**.
If a node retries (because the final answer failed schema validation, or
because of a queue-level retry), every tool inside the loop runs again
with the same inputs. For tools whose result isn't already memoized
upstream, use `ctx.cache` to deduplicate:

```ts
run: async (input, ctx) => {
  const key = `crm:deals:${input.customerId}:${input.limit}`;
  const cached = await ctx.cache?.get(key);
  if (cached) return cached as { deals: ... };
  const fresh = await crm.deals(input.customerId, input.limit);
  await ctx.cache?.set(key, fresh, 300);
  return fresh;
},
```

`maxIterations` is a hard stop — defaults to 10. Lower it for trivial
flows, raise it for agentic ones, but always bound it. A buggy tool that
never converges is the simplest way to burn an unbounded number of tokens.
