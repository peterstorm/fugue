# Fugue — Feature Guide

Fugue is a DAG-shaped, durable runtime for LLM-bearing workflows. This document explains every major feature with concrete examples showing what each feature **catches** — the bugs, failures, and operational hazards that would slip through without it.

---

## Table of Contents

1. [Typed DAG Definition](#1-typed-dag-definition)
2. [Branded Identifiers](#2-branded-identifiers)
3. [Result Type (Either Pattern)](#3-result-type-either-pattern)
4. [Capability-Typed Node Context](#4-capability-typed-node-context)
5. [Wave-Based Concurrent Execution](#5-wave-based-concurrent-execution)
6. [Retry with Exponential Backoff + Jitter](#6-retry-with-exponential-backoff--jitter)
7. [Conditional Routing with Confidence Gating](#7-conditional-routing-with-confidence-gating)
8. [Human-in-the-Loop Review Gates](#8-human-in-the-loop-review-gates)
9. [Freshness Witness Contracts](#9-freshness-witness-contracts)
10. [Crash-Resume via Checkpointing](#10-crash-resume-via-checkpointing)
11. [Observer Pattern (Domain Events)](#11-observer-pattern-domain-events)
12. [Tail-Sampling Persistence Policies](#12-tail-sampling-persistence-policies)
13. [LLM Client Abstraction](#13-llm-client-abstraction)
14. [Tool-Use Loop](#14-tool-use-loop)
15. [Eval-Judge Quality Gates](#15-eval-judge-quality-gates)
16. [Guardrail Nodes](#16-guardrail-nodes)
17. [OpenTelemetry Tracing + MLflow Export](#17-opentelemetry-tracing--mlflow-export)
18. [Durable Queue Integration (BullMQ)](#18-durable-queue-integration-bullmq)
19. [Cron Scheduler with Dependencies](#19-cron-scheduler-with-dependencies)
20. [Architecture Enforcement](#20-architecture-enforcement)
21. [Prompt Caching](#21-prompt-caching)

---

## 1. Typed DAG Definition

### What It Does

`defineDag` validates your DAG at **module load time** — not at first request. It enforces:

- All edge endpoints reference known nodes
- Every node with conditional out-edges has exactly one default edge (else-totality)
- The output node is reachable along unconditional + default edges
- No duplicate `(from, to)` edge pairs
- Predicates have `label`, `version`, and `check` function
- Writes nodes declare both freshness extractors or neither (never one without the other)
- Every entry node receives the request explicitly: no node implicitly gets the DAG input (0.2.0). A request-consuming root needs an edge from the `DAG_INPUT` (`"$input"`) sentinel; a root that consumes nothing is built with `createSourceNode` (or declared via `defineSources`). The validator rejects an input-less non-source root with `root-expects-input`.

### What It Catches

```typescript
// ❌ CAUGHT AT BOOT: Edge references non-existent node
const dag = defineDag({
  id: "broken",
  nodes: { "fetch": fetchNode, "transform": transformNode },
  edges: [
    { from: "fetch", to: "transform" },
    { from: "transform", to: "summarize" },  // 💥 DagDefinitionError: unknown target node 'summarize'
  ],
});

// ❌ CAUGHT AT BOOT: Conditional edge without default
const dag = defineDag({
  id: "missing-default",
  nodes: { "router": routerNode, "branch-a": branchA, "branch-b": branchB },
  edges: [
    { from: "router", to: "branch-a", when: highConfPredicate },
    { from: "router", to: "branch-b", when: lowConfPredicate },
    // 💥 Missing default edge — what happens when NO predicate matches?
    // DagDefinitionError: node 'router' has conditional out-edges but no default edge
  ],
});

// ❌ CAUGHT AT BOOT: Output node unreachable under routing
const dag = defineDag({
  id: "unreachable-output",
  nodes: { "a": nodeA, "b": nodeB, "c": nodeC, "sink": sinkNode },
  edges: [
    { from: "a", to: "b", when: predicate },
    { from: "a", to: "c", kind: "default" },
    { from: "b", to: "sink" },
    // 💥 'sink' is only reachable via a conditional edge — not guaranteed
    // DagDefinitionError: outputNodeId 'sink' is not reachable along unconditional + default edges
  ],
  outputNodeId: "sink",
});
```

### Why It Matters

Without boot-time validation, these bugs manifest as **silent runtime failures** on the first user request — possibly minutes or hours after deployment. With `defineDag`, they crash the process at startup, making them impossible to ship.

---

## 2. Branded Identifiers

### What It Does

`RunId`, `NodeId`, and `DagId` are **hard-branded newtypes** over `string`. A plain `string` does NOT satisfy these types at compile time. You must use smart constructors (`runId()`, `nodeId()`, `dagId()`) that validate against the regex `[A-Za-z0-9_:-]{1,128}`.

### What It Catches

```typescript
// ❌ COMPILE ERROR: Type 'string' is not assignable to type 'RunId'
const id: RunId = "my-run";

// ✅ Only through the smart constructor
const id: RunId = runId("my-run");

// ❌ COMPILE ERROR: Can't swap a NodeId where a RunId is expected
function getCheckpoint(rid: RunId): Checkpoint { ... }
const nid = nodeId("fetch-data");
getCheckpoint(nid);  // 💥 Type 'NodeId' is not assignable to type 'RunId'

// ❌ RUNTIME ERROR: Smart constructor rejects bad input
const bad = nodeId("../../etc/passwd");  // 💥 Invalid nodeId: must match [A-Za-z0-9_:-]{1,128}
const tooLong = nodeId("a".repeat(200)); // 💥 Invalid nodeId: must match...

// ✅ Result-returning variant for parse boundaries
const parsed = tryRunId(userInput);
if (!parsed.ok) return err({ kind: "validation", message: parsed.error });
```

### Why It Matters

Without branded IDs, argument-swap bugs are **invisible at compile time**. A function that takes `(runId, nodeId)` would happily accept `(nodeId, runId)` since both are `string`. With branding, this is a type error. The regex validation also prevents path-traversal injection via IDs that end up in Redis keys or file paths.

---

## 3. Result Type (Either Pattern)

### What It Does

Every function that can fail returns `Result<T, FrameworkError>` instead of throwing. The `FrameworkError` is a discriminated union of 27 kinds, each with typed fields. A `never` guard in `formatFrameworkError` ensures adding a new error kind without handling it is a **compile error**.

### What It Catches

```typescript
// ❌ WITHOUT RESULT: Silent swallowing
async function processOrder(order: Order) {
  const summary = await generateSummary(order); // What if this fails?
  await saveSummary(summary);                    // This runs with undefined/garbage
}

// ✅ WITH RESULT: Forced handling
async function processOrder(order: Order): Promise<Result<void, FrameworkError>> {
  const summaryResult = await generateSummary(order);
  if (!summaryResult.ok) return summaryResult;  // Error propagates — can't ignore it

  const saveResult = await saveSummary(summaryResult.value);
  if (!saveResult.ok) return saveResult;

  return ok(undefined);
}

// ✅ EVEN BETTER: Combinator chaining
const result = await andThenAsync(
  await generateSummary(order),
  (summary) => saveSummary(summary),
);
// `result` is Err if EITHER step failed — no silent swallowing possible

// ❌ CAUGHT: Adding a new error kind without handling it
// In formatFrameworkError:
switch (e.kind) {
  case "validation": return ...;
  case "node-crash": return ...;
  // ... all 27 kinds ...
  default: {
    const _exhaustive: never = e;  // 💥 COMPILE ERROR if you add a kind above without a case
    return `unhandled: ${JSON.stringify(_exhaustive)}`;
  }
}
```

### Why It Matters

Exceptions are **invisible in the type system**. Any function can throw anything; callers don't know what to catch. `Result<T, E>` makes failure visible in the signature and **forces** the caller to handle it. Combined with the exhaustive `FrameworkError` union, the compiler verifies you handle every failure mode.

---

## 4. Capability-Typed Node Context

### What It Does

Each node declares `requires: readonly Capability[]` (e.g., `["llm", "prompts"]`). At run start — **before any node executes** — the runtime validates that the wired context satisfies all declared capabilities. The node's `run` function receives a narrowed `TypedNodeContext<R>` where required fields are guaranteed non-null.

The capability set is **extensible** (ADR-0051): beyond the built-ins (`llm`, `cache`, `prompts`, `judgeLlm`, `http`, `clock`, `budget`), adapter packages register new capabilities — e.g. `documents` (file I/O), `db` (Postgres) — by augmenting `CapabilityRegistry`. A node then declares `requires: ["db"] as const` and gets a typed, non-null `ctx.db`. Run `fugue capabilities` for the live built-in list; see `adapter-authoring.md` to write an adapter and `llm-document-source.md` for reading files.

### What It Catches

```typescript
// LLM nodes auto-declare their capabilities — createLlmNode fixes
// requires: ["llm", "prompts"], so you never pass `requires` to it.
// Inside the framework, ctx.llm / ctx.prompts are non-null.
const synthesize = createLlmNode({
  id: "synthesize",
  inputSchema: UserSchema,
  outputSchema: SummarySchema,
  promptName: "summary",
  model: "claude-sonnet-4-6",
  buildInput: (u) => ({ name: u.name }),
});

// Fetch nodes declare what THEY need — here the built-in `http` capability.
const loadProfile = createFetchNode({
  id: "load-profile",
  inputSchema: InputSchema,
  outputSchema: UserSchema,
  requires: ["http"] as const,             // ctx.http is non-null below
  fetch: async (input, ctx) =>
    ctx.http.get(`https://api.example.com/users/${input.id}`, { schema: UserSchema }),
});

// ❌ CAUGHT AT RUN START: Missing capability
const result = await runDag(dag, input, {
  runId: runId("r1"),
  dagId: dagId("d1"),
  logger: consoleLogger,
  tracer: noopTracer,
  observer: noopObserver,
  llm: null,        // 💥 "synthesize" declares requires: ["llm"]
  prompts: null,    // 💥 "synthesize" declares requires: ["prompts"]
  cache: null,
});
// Err({ kind: "missing-capability", nodeId: "synthesize", capability: "llm",
//        missing: [{ nodeId: "synthesize", capability: "llm" },
//                  { nodeId: "synthesize", capability: "prompts" }] })

// The run NEVER starts — no node.run() is called with a null ctx.llm
```

### Why It Matters

Without capability validation, a node that calls `ctx.llm.sendStructured()` with `ctx.llm === null` crashes with an opaque `Cannot read properties of null` error **deep inside execution**, after other nodes have already run and possibly mutated state. With pre-flight validation, the problem surfaces immediately with a clear error listing every gap.

---

## 5. Wave-Based Concurrent Execution

### What It Does

The DAG is compiled into an ordered sequence of **waves** (topological depth layers). Nodes within the same wave execute concurrently via `Promise.all`. Nodes in later waves see a **snapshot** of prior outputs — they cannot observe each other mid-execution.

### What It Catches

```typescript
// DAG: A → B, A → C, B → D, C → D
// Waves: [[A], [B, C], [D]]
//
// Wave 0: A runs alone
// Wave 1: B and C run concurrently (both see A's output, neither sees the other's)
// Wave 2: D runs alone (sees A + B + C outputs)

// ❌ WITHOUT WAVES: Race condition
// If B and C both write to a shared context, B might see C's half-written output
// or vice versa. Results are non-deterministic.

// ✅ WITH WAVES: Deterministic execution
// B and C receive the same immutable snapshot of prior outputs.
// D sees the complete, final outputs of both B and C.
// No race conditions possible within the same wave.
```

### Why It Matters

Concurrent execution of independent nodes is essential for performance (don't serialize things that don't depend on each other). But naive concurrency introduces race conditions. Waves give you both: parallelism where safe, serialization where required, with zero developer effort.

---

## 6. Retry with Exponential Backoff + Jitter

### What It Does

Each node can declare `retry: { backoffMs: [1000, 2000, 4000], jitterRatio: 0.2 }`. On transient failures, the executor sleeps for `backoffMs[attempt] * (1 ± jitterRatio)` then re-runs the failed node. The retry counter is per-invocation (fresh on each queue-level attempt). Non-retriable errors (`retriability: "non-retriable"`) fast-fail without consuming the retry budget.

### What It Catches

```typescript
// LLM rate-limit (HTTP 429) → classified as "transient" → retries
// LLM timeout → classified as "transient" → retries
// Schema validation failure → classified as "non-retriable" → fast-fails

// ❌ WITHOUT JITTER: Thundering herd
// 100 workers all hit a rate limit at t=0
// All retry at t=1000ms exactly → another rate limit wave
// All retry at t=2000ms exactly → another rate limit wave

// ✅ WITH JITTER: Spread the load
// Worker 1 retries at 820ms, Worker 2 at 1150ms, Worker 3 at 960ms...
// The rate-limit window clears before the next batch hits

// ❌ WITHOUT retriability DISCRIMINATION:
// A schema validation failure (deterministic) wastes 3 retry attempts
// doing the exact same thing that will never succeed.

// ✅ WITH retriability:
// { kind: "node-crash", retriability: "non-retriable" } → immediately fails
// Only transient errors (rate limits, timeouts) consume the retry budget
```

### Why It Matters

LLM APIs are inherently unreliable (rate limits, timeouts, transient 500s). Without retry, a single transient failure aborts the entire run. Without jitter, retries create thundering herds that worsen the rate limit. Without retriability discrimination, the retry budget is wasted on deterministic failures.

---

## 7. Conditional Routing with Confidence Gating

### What It Does

Edges can carry **predicates** — functions that evaluate a node's output and decide which downstream path to take. Predicates can be gated on a **confidence bucket** (`high`, `medium`, `low`, `unknown`). The confidence is never a bare number — it's a branded type with `{ bucket, source, raw? }`.

### What It Catches

```typescript
// Define a confidence-gated predicate
const highConfRoute: Predicate<SynthesisOutput> = {
  label: "high-confidence-synthesis",
  version: 1,
  minConfidence: "high",  // Only fires when confidence ≥ high
  check: (output, confidence) => output.keyTopics.length >= 3,
};

// ❌ WITHOUT CONFIDENCE GATING:
// A self-reported "high confidence" from GPT-3.5 is treated the same as
// a calibrated ensemble score. Routes fire on miscalibrated signals.

// ✅ WITH CONFIDENCE GATING:
// Confidence carries provenance: "self-reported-numeric" vs "logprob" vs
// "ensemble-agreement". The framework never compares raw numbers.
// Dashboards segment calibration by source.

// ❌ WITHOUT PREDICATE VERSIONING:
// You change a predicate's logic but resume a checkpointed run.
// The old routing decisions in the checkpoint conflict with the new logic.

// ✅ WITH PREDICATE VERSIONING:
// `version: 2` bumps the DAG fingerprint → checkpoint mismatch detected →
// stale checkpoint rejected at resume time, not silently replayed.

// ❌ CAUGHT: Predicate throws at runtime
const buggyPredicate: Predicate<unknown> = {
  label: "buggy",
  version: 1,
  check: (output) => (output as any).nonExistent.field > 0,  // throws TypeError
};
// Result: { kind: "predicate-malformed", message: "Predicate 'buggy' threw..." }
// NOT silently falling to the default edge — the bug is surfaced.
```

### Why It Matters

LLM outputs have variable quality. Routing should depend on confidence, but confidence signals from different sources have different calibration. Without typed confidence, you'd compare raw numbers from a logprob vs a self-assessment. Without predicate versioning, a changed routing rule silently corrupts resumed runs. Without exception handling, a predicate bug silently takes the default path.

---

## 8. Human-in-the-Loop Review Gates

### What It Does

Any node can declare `humanReview: { prompt: "Review this summary for accuracy" }`. After the node completes, the run **durably pauses** in `awaiting-human`. A reviewer can `approve`, `approve-with-edit`, `reject`, or `reroute`. The framework:

- Validates `approve-with-edit` output against the node's schema
- Generates a JSON Patch diff for forensic analysis
- Emits a `HumanInterventionEvent` capturing full context (confidence, side-effects, prior witnesses)
- Retries the hook if it crashes (separate retry budget from the node)

### What It Catches

```typescript
// ❌ WITHOUT SCHEMA VALIDATION ON EDIT:
// Reviewer edits the output to { "summary": null } — downstream nodes crash
// with a null-pointer error minutes later.

// ✅ WITH SCHEMA VALIDATION:
// approve-with-edit runs the edited output through the node's outputSchema.
// If it fails: Err({ kind: "validation", message: "..." })
// The reviewer gets feedback immediately, not a cryptic downstream crash.

// ❌ WITHOUT DURABLE PAUSE:
// The run is held in memory. If the worker restarts while awaiting review,
// the human's response is lost and the run must restart from scratch.

// ✅ WITH DURABLE PAUSE:
// The state machine serializes to the JobLike. Worker restarts don't lose state.
// The human can respond hours/days later.

// ❌ WITHOUT HOOK CRASH RETRY:
// The onHumanReview hook (e.g., Slack integration) throws due to a network blip.
// The entire run fails. The human never gets the review request.

// ✅ WITH HOOK CRASH RETRY (FR-029a):
// Phase: awaiting-human → retrying-hook (separate retry budget)
// The hook is retried; the node's output is preserved across retries.
```

### Why It Matters

High-stakes LLM outputs (medical, financial, legal) need human oversight. Without durable pausing, human review requires holding a process open indefinitely. Without schema validation on edits, humans can introduce data that crashes downstream. Without hook crash retry, a flaky Slack/email integration blocks the entire pipeline.

---

## 9. Freshness Witness Contracts

### What It Does

Nodes declare their side-effect profile: `"none"`, `"reads"`, `"writes"`, `"external-call"`. For `reads` nodes, the framework extracts a **witness** (version token) after execution. For `writes` nodes, it checks if the witness the write is conditioned on has been **superseded** by another write. Freshness is **fail-closed**: extractor failures abort the wave.

### What It Catches

```typescript
// Scenario: Two concurrent runs updating the same customer record
//
// Run 1: reads customer (version=5) → writes updated customer
// Run 2: reads customer (version=5) → writes updated customer
//
// Without freshness detection: Both writes succeed. Run 2 overwrites Run 1's
// changes silently. Lost update — classic concurrency bug.

// ✅ WITH FRESHNESS WITNESSES:
// extractWitness / extractNewWitness return a resource-free `witnessValue` — the
// framework stamps the profile's `resource`, so a witness can never name a
// different resource than the node it lives on. This mismatch is unrepresentable
// at *compile time* (WitnessValue declares `resource?: never`, so a full
// `witness` is unassignable to these slots), not merely overwritten at runtime.
// extractConditionedOn returns a full `witness` because a write may condition on
// a resource it read upstream.
const fetchCustomer: NodeDef = {
  sideEffects: {
    kind: "reads",
    resource: resourceName("postgres:customers:123"),
    extractWitness: (output) => witnessValue("version", String(output.xmin)),
  },
};

const updateCustomer: NodeDef = {
  sideEffects: {
    kind: "writes",
    resource: resourceName("postgres:customers:123"),
    extractConditionedOn: (input) => witness("version", resourceName("postgres:customers:123"), String(input.customerVersion)),
    extractNewWitness: (output) => witnessValue("version", String(output.newXmin)),
  },
};

// Run 2's write sees: conditionedOn version=5, but Run 1 already wrote version=6.
// Event emitted: { type: "freshness-violation",
//   conditionedOnWitness: { resource: "postgres:customers:123", ... }, ... }
// The operator sees the conflict; the node can react via routing.

// ❌ WITHOUT FAIL-CLOSED SEMANTICS:
// If extractWitness throws (bug in the extractor), the framework could silently
// proceed without the witness. Downstream writes lose conflict detection entirely.

// ✅ WITH FAIL-CLOSED:
// Extractor failure → Err({ kind: "node-crash", retriability: "non-retriable" })
// The wave aborts. The authoring bug must be fixed before writes proceed.
```

### Why It Matters

LLM pipelines that read-then-write to databases need optimistic concurrency control. Without freshness witnesses, concurrent runs silently overwrite each other. The fail-closed design ensures that a broken extractor doesn't silently disable safety — it forces a fix.

---

## 10. Crash-Resume via Checkpointing

### What It Does

After each successful node, the runtime optionally writes a checkpoint (node output keyed by `(runId, nodeId)`). On crash-resume:

1. Load the checkpoint
2. Validate each cached output against the **current** output schema
3. Verify the DAG fingerprint (topology + predicate versions) matches
4. Verify the framework version matches
5. Skip validated nodes (emit `node-skipped`), run remaining nodes normally

### What It Catches

```typescript
// ❌ WITHOUT CHECKPOINT VALIDATION:
// You deploy a new version that tightens a node's output schema.
// Resume replays the old cached output — it doesn't match the new schema.
// Downstream nodes receive garbage and produce wrong results silently.

// ✅ WITH CHECKPOINT VALIDATION:
// Cached output is parsed through the CURRENT outputSchema.
// If it fails: Err({ kind: "checkpoint-corrupt", message: "..." })
// The node re-runs with the new code instead of replaying stale data.

// ❌ WITHOUT DAG FINGERPRINT:
// You add a new node between "fetch" and "transform".
// Resume skips "fetch" (checkpointed) but the new node never ran.
// The output is incomplete.

// ✅ WITH DAG FINGERPRINT:
// Adding/removing nodes or changing predicate versions changes the fingerprint.
// Err({ kind: "checkpoint-version-mismatch", expected: "abc...", actual: "def..." })
// The stale checkpoint is rejected — the run starts fresh.

// ❌ WITHOUT FRAMEWORK VERSION:
// Framework v2 changes how output coercion works.
// Resuming a v1 checkpoint under v2 silently changes behavior.

// ✅ WITH FRAMEWORK VERSION:
// Each checkpoint stamps the writing framework's semantic version hash.
// Cross-version resume: Err({ kind: "checkpoint-version-mismatch" })
```

### Why It Matters

LLM nodes are expensive ($$$) and slow. Re-running a 5-node DAG from scratch because node 4 failed wastes the cost of nodes 1-3. Checkpointing lets you resume from exactly where you left off — but naive checkpointing (just replay the cached value) is dangerous when schemas or topology change between deploys.

---

## 11. Observer Pattern (Domain Events)

### What It Does

A single `Observer` interface with one method: `observe(event: ObserverEvent)`. The `ObserverEvent` is a discriminated union of 13 event types. Consumers branch on `event.type`. Adding a new event type without handling it in an exhaustive observer is a compile error.

### What It Catches

```typescript
// ❌ OLD DESIGN (13-method interface):
interface Observer {
  onRunStart(e: RunStartEvent): void;
  onNodeStart(e: NodeStartEvent): void;
  // ... 11 more methods
}
// Adding a new event type requires updating EVERY observer implementation.
// Implementations that forget a method silently drop events.

// ✅ NEW DESIGN (single-method + discriminated union):
const obs = createExhaustiveObserver({
  "run-start": (e) => metrics.runStarted(e.runId),
  "node-end": (e) => metrics.nodeCompleted(e.nodeId, e.duration),
  "freshness-violation": (e) => alerting.staleWrite(e.conditionedOnWitness.resource),
  "human-intervention": (e) => auditLog.record(e),
  // 💥 COMPILE ERROR if you omit any event type
  // "node-error": ???  ← TypeScript: Property 'node-error' is missing
});

// For partial observers:
const obs = createObserver({
  "run-end": (e) => console.log(`Run ${e.runId}: ${e.status}`),
  // All other event types silently ignored — explicit opt-in
});
```

### Why It Matters

Observability is critical for LLM pipelines (costs, latency, quality). The old N-method pattern doesn't scale: adding a `freshness-violation` event requires updating every observer, even those that don't care. The single-method pattern is extensible without breaking changes; exhaustive observers get compile-time guarantees.

---

## 12. Tail-Sampling Persistence Policies

### What It Does

The `BufferedObserver` accumulates per-run events in memory. On `run-end`, a **persistence policy** decides whether to flush the buffered events to the downstream exporter. Policies are composable: `anyOf(errorOnly(), hadRetry(), ratio(0.01))`.

### What It Catches

```typescript
// ❌ WITHOUT TAIL SAMPLING:
// 10,000 runs/minute → 10,000 full event traces stored
// Cost: $$$. Signal-to-noise: terrible. Most runs are boring successes.

// ✅ WITH TAIL SAMPLING:
const policy = anyOf(
  errorOnly(),      // Always persist failed runs (for debugging)
  hadRetry(),       // Persist runs that had retries (unusual behavior)
  ratio(0.01),     // 1% sample of healthy runs (for baseline metrics)
);
// Only ~2-5% of runs are persisted. Failed runs are ALWAYS captured.

// ❌ WITHOUT BUFFERING:
// You emit events as they happen. A successful run floods storage with
// 50 node-start/node-end pairs that nobody will ever read.

// ✅ WITH BUFFERING:
// Events accumulate per-run. At run-end, the policy sees the full picture
// (duration, retry count, error status) and decides all-or-nothing.
// "Interesting" runs keep full traces; boring runs are dropped.
```

### Why It Matters

Observability backends have capacity limits. Storing every event from every successful run is wasteful and makes it harder to find the interesting failures. Tail sampling captures the decisions that matter (errors, retries, violations) while dropping the noise.

---

## 13. LLM Client Abstraction

### What It Does

`LlmClient` is an interface with two methods: `sendStructured<O>` (schema-enforced output) and `sendWithTools<O>` (tool-calling loop). Implementations exist for OpenAI (Responses API), Anthropic (Messages API), and `FakeLlmClient` (for tests). Error classification is centralized: timeouts, rate limits, and crashes are distinguished.

### What It Catches

```typescript
// ❌ WITHOUT CLASSIFICATION:
// Every LLM error is treated the same. A timeout (retriable) exhausts the
// retry budget alongside a 401 (permanent). 3 retries of an invalid API key.

// ✅ WITH CLASSIFICATION:
// HTTP 429 → { kind: "transient" } → retries with backoff
// HTTP 401 → { kind: "node-crash", retriability: "non-retriable" } → fast-fails
// Timeout → { kind: "transient" } → retries
// AbortSignal → { kind: "aborted" } → run terminates cleanly

// ❌ WITHOUT FakeLlmClient:
// Testing requires mocking fetch, intercepting HTTP, or hitting a real API.
// Tests are slow, flaky, and expensive.

// ✅ WITH FakeLlmClient:
const fake = new FakeLlmClient([
  { output: { summary: "Test output" }, tokensIn: 100, tokensOut: 50 },
]);
// Instant, deterministic, free. Scripted multi-turn tool-call sequences too.

// ❌ WITHOUT STRUCTURED OUTPUT:
// The LLM returns free-text. You JSON.parse it, hope it matches your schema,
// and crash at runtime when it doesn't.

// ✅ WITH STRUCTURED OUTPUT:
// sendStructured passes a JSON Schema to the API, then Zod-validates the response.
// Schema mismatch → { kind: "node-crash", retriability: "retriable" }
// The retry gives the LLM another chance with the same schema constraint.
```

### Why It Matters

LLM APIs are the most failure-prone component in the system. Without proper error classification, retries are wasted on permanent failures. Without structured output validation, schema mismatches cause cryptic downstream crashes. Without a fake client, testing is slow and expensive.

---

## 14. Tool-Use Loop

### What It Does

A provider-agnostic loop that drives multi-turn tool-calling conversations. The loop owns: iteration limits, deadline enforcement, abort signal propagation, token accumulation, tool dispatch with per-call spans, and final-answer parsing.

### What It Catches

```typescript
// ❌ WITHOUT ITERATION LIMIT:
// The model calls tools in a loop forever (recursive tool calls, confusion).
// Your API bill grows unboundedly. The request eventually times out.

// ✅ WITH ITERATION LIMIT:
// maxIterations: 10 → after 10 tool-call turns without a final answer:
// Err({ kind: "node-crash", retriability: "non-retriable",
//        message: "Tool-call iteration limit (10) reached" })
// Non-retriable because the model is clearly confused — retrying won't help.

// ❌ WITHOUT DEADLINE:
// A chain of 8 tool calls each taking 30s = 4 minutes for one node.
// The overall request timeout fires with no useful error.

// ✅ WITH DEADLINE:
// deadlineMs: 60000 → if cumulative time exceeds 60s:
// Err({ kind: "transient", message: "Total deadline of 60000ms exceeded" })
// Transient because the model might succeed with fewer tool calls next time.

// ❌ WITHOUT TOOL NAME VALIDATION:
// You register a tool with name "get weather" (space).
// The OpenAI API rejects it with an opaque 422 on the first call.

// ✅ WITH TOOL NAME VALIDATION:
// ensureToolNames validates against /^[A-Za-z0-9_-]{1,64}$/ at loop start.
// Invalid names fail immediately with a clear error, not at the API boundary.
```

### Why It Matters

Tool-use is the most complex LLM interaction pattern. Without limits, a confused model can loop forever. Without deadline enforcement, slow tool chains block the pipeline. The provider-agnostic design means adding a new LLM provider only requires implementing `ToolLoopProvider` (~50 LOC), not the entire loop.

---

## 15. Eval-Judge Quality Gates

### What It Does

DAGs can declare `evalJudges` — LLM-based quality assessors that score the final output against criteria (factuality, completeness, relevance). Judges run after the DAG succeeds, either inline (blocking) or in the background (via `onBackground`). A judge crash returns `outcome: "crash"` — **never silently passes**.

### What It Catches

```typescript
// ❌ WITHOUT EVAL JUDGES:
// The LLM produces a hallucinated summary. It passes schema validation
// (structurally correct) but is factually wrong. Nobody notices until
// a customer complains.

// ✅ WITH EVAL JUDGES:
const judge = createEvalJudgeNode({
  id: "factuality-judge",
  criteria: ["factuality", "completeness"],
  threshold: 0.8,
  model: "gpt-4o-mini",
});
// After the DAG produces a summary, the judge scores it.
// result.evalJudgeFailed === true → quality gate tripped.
// Operators can route low-quality outputs to human review.

// ❌ WITHOUT CRASH HANDLING:
// The judge's LLM call times out. If we return "passed", quality gates
// are silently disabled. Operators think everything is fine.

// ✅ WITH CRASH HANDLING:
// Judge exception → { outcome: "crash", reason: "..." }
// judgePassed(result) === false for crashes
// The failure is visible in run-end aggregation and gating logic.
```

### Why It Matters

LLM outputs can be structurally correct but semantically wrong. Eval judges provide automated quality scoring. The key insight is crash handling: a broken judge must never silently pass, or it becomes invisible technical debt that disables your quality gates.

---

## 16. Guardrail Nodes

### What It Does

Guardrail nodes run pure validation functions against data flowing through the DAG. They **never block** the pipeline — they attach warnings and emit diagnostics. The output is a discriminated union: `skipped | validated | failed`. A throwing validator is caught and surfaced as `kind: "failed"`.

### What It Catches

```typescript
// Example: grounding guardrail verifies LLM output references source data
const groundingGuardrail = createGuardrailNode({
  id: "grounding-check",
  validate: (input) => {
    const { synthesis, customer } = input;
    if (!customer) return { kind: "skipped", passed: true, ... };

    const checks = [
      checkTopicGrounding(synthesis.keyTopics, customer.conversations),
      checkSentimentConsistency(synthesis.sentiment, customer.conversations),
      checkConversationCount(synthesis.text, customer.conversations.length),
    ];
    return {
      kind: "validated",
      value: synthesis,
      passed: checks.every(c => c.passed),
      warnings: checks.filter(c => !c.passed).map(c => c.detail),
      checks,
    };
  },
});

// ❌ WITHOUT GUARDRAILS:
// LLM claims "customer had 15 conversations" but they only had 3.
// The hallucinated number ships to the customer-facing UI.

// ✅ WITH GUARDRAILS:
// checkConversationCount detects the mismatch.
// warnings: ["Claimed 15 conversations but source shows 3"]
// The assemble-response node includes `groundingWarnings` in the API response.
// The frontend can show a "low confidence" badge.
```

### Why It Matters

Guardrails are non-blocking quality signals. They don't stop the pipeline (unlike eval judges which can gate), but they provide metadata that downstream consumers (UIs, monitoring) can use to flag low-quality outputs. The discriminated union ensures consumers handle all three states (skipped/validated/failed).

---

## 17. OpenTelemetry Tracing + MLflow Export

### What It Does

Every LLM call, tool dispatch, and node execution creates OTel spans. The `MlflowOtlpExporter` transforms framework-neutral spans into MLflow's expected format (span types, token usage, cost attribution). Content filtering (PII scrubbing) is applied before span data is written.

### What It Catches

```typescript
// ❌ WITHOUT TRACING:
// "The pipeline is slow." Which node? Which LLM call? What was the token count?
// You add console.logs, redeploy, wait for reproduction. Days pass.

// ✅ WITH TRACING:
// Each node gets a span with: duration, input/output, token usage, cost.
// Each LLM call gets gen_ai.* attributes: model, tokens, finish reason.
// MLflow UI shows the full DAG trace with per-node drill-down.

// ❌ WITHOUT CONTENT FILTERING:
// Customer PII (SSNs, emails, credit cards) ends up in your trace backend.
// Compliance violation. Data breach risk.

// ✅ WITH CONTENT FILTERING:
const filter = piiScrubber();  // Regex-based: SSN, email, phone, CPR, credit card
// All span content passes through the filter before export.
// Original text: "Customer John (SSN: 123-45-6789) called about..."
// Filtered text: "Customer John (SSN: ***-**-****) called about..."
```

### Why It Matters

Production LLM pipelines need observability for debugging, cost tracking, and compliance. Without tracing, you're flying blind. Without content filtering, tracing becomes a liability. The MLflow integration enables experiment tracking and A/B comparison of prompt versions.

---

## 18. Durable Queue Integration (BullMQ)

### What It Does

The `QueueBackend` port has two adapters: `InMemoryBackend` (for tests/dev) and `BullMQBackend` (for production). The BullMQ adapter provides: durable job persistence, configurable retry attempts, dead-letter handling, event log via Redis Streams, and `FrameworkAugmentedError` for structured error propagation.

### What It Catches

```typescript
// ❌ WITHOUT DURABLE QUEUE:
// Worker crashes mid-run. The run is lost. The customer gets no response.
// No retry. No visibility into what happened.

// ✅ WITH DURABLE QUEUE:
// Worker crashes → BullMQ moves the job to "waiting" after stall timeout.
// Another worker picks it up. Checkpoint resume skips completed nodes.
// Dead-letter handler fires after N attempts → alert sent.

// ❌ WITHOUT FrameworkAugmentedError:
// Job fails with Err({ kind: "retry-exhausted", ... }).
// BullMQ sees a generic Error. Dead-letter handler can't distinguish
// a rate-limit storm from a permanent schema bug.

// ✅ WITH FrameworkAugmentedError:
// throw new FrameworkAugmentedError(message, frameworkError);
// Worker catch sees: error.frameworkErrorKind === "retry-exhausted"
// Dead-letter handler can route differently based on rootErrorKind.

// ❌ WITHOUT EVENT LOG:
// Job failed on attempt 3. What happened on attempts 1 and 2?
// No audit trail. Can't debug intermittent failures.

// ✅ WITH EVENT LOG (Redis Streams):
// appendEvent(event, dedupKey) writes to a per-job Redis Stream.
// After the run: readEvents(runId) returns the full state-machine audit trail.
// replayEventsUntil(events, timestamp) → reconstruct historical state.
```

### Why It Matters

Production LLM pipelines process thousands of requests. Without durable queuing, worker crashes lose work and there's no retry mechanism. Without structured error propagation, dead-letter handlers can't make intelligent routing decisions. Without event logs, debugging intermittent failures requires reproduction.

---

## 19. Cron Scheduler with Dependencies

### What It Does

The `CronScheduler` drives periodic DAG runs via a registry of `TaskConfig` entries. Tasks can declare dependencies on other tasks. The scheduler resolves dependents after completion, detects cycles, and supports catch-up scheduling for missed intervals.

### What It Catches

```typescript
// ❌ WITHOUT CYCLE DETECTION:
// Task A depends on Task B, Task B depends on Task A.
// The scheduler enters an infinite resolution loop on the first tick.

// ✅ WITH CYCLE DETECTION:
// hasCycle(taskId, registry) runs at reconcile time.
// Cyclic tasks are silently skipped with a warning log.
// The rest of the schedule continues unaffected.

// ❌ WITHOUT IDEMPOTENT ENQUEUE:
// Scheduler fires task "daily-summary" at 09:00.
// Worker crashes between enqueue and mark-as-fired.
// On restart, scheduler fires again → duplicate execution.

// ✅ WITH IDEMPOTENT ENQUEUE:
// jobId = `${task.id}-${triggeredAt.getTime()}`
// BullMQ deduplicates by jobId. Same (task, time) pair = same job.
// Crash-restart re-fires the same key → queue rejects the duplicate.
```

### Why It Matters

Periodic LLM pipelines (daily summaries, weekly reports) need reliable scheduling. Without cycle detection, a misconfigured dependency graph hangs the scheduler. Without idempotent enqueue, crash-recovery produces duplicate work.

---

## 20. Architecture Enforcement

### What It Does

`check-imports.ts` is a programmatic boundary checker that runs as a test. It enforces strict import layering:

- `types/` imports nothing (pure domain types)
- `shared/` imports only `types/`
- `dag-runtime/` imports `types/` + `shared/` (never `executor/`)
- `state-machine/` never imports `bullmq`/`ioredis`
- Only `queue-bullmq/` may import `bullmq`/`ioredis`
- The main barrel never pulls `ioredis` into the default bundle

### What It Catches

```typescript
// ❌ WITHOUT ENFORCEMENT:
// A developer adds `import Redis from "ioredis"` to a shared utility.
// Now every consumer of the framework pulls ioredis into their bundle.
// Bundle size grows. Consumers without Redis get a runtime crash on import.

// ✅ WITH ENFORCEMENT:
// `check-imports.ts` detects the violation in the test suite:
// VIOLATION: shared/my-util.ts:3 imports "ioredis"
//   Reason: "shared/** must not import OTel, observer/**, or tracing/**."
// The PR is blocked. The developer moves the code to the Redis adapter.

// ❌ WITHOUT LAYERING:
// dag-runtime/routing.ts imports from executor/run-dag.ts.
// Now dag-runtime depends on executor, which depends on dag-runtime.
// Circular dependency. Build breaks. Or worse: silent runtime import order bugs.

// ✅ WITH LAYERING:
// Rule: dag-runtime/** must not import from executor/**
// Violation caught at test time before merge.
```

### Why It Matters

Architecture degrades over time without enforcement. Import boundaries are the most commonly violated constraint in TypeScript monorepos. Without automated checking, coupling creeps in via convenience imports until the architecture is unrecoverable. The test catches violations the instant they're introduced.

---

## 21. Prompt Caching

### What It Does

Lets a node declare which part of its prompt is **stable**, and caches that prefix provider-side. The framework derives where the cache breakpoints go — callers never place one.

```typescript
// Single-shot: the system prompt and tool spec are shared by every call to
// this node; the per-input user message renders after the breakpoint.
createLlmNode({
  id: "classify",
  model: "claude-sonnet-4-20250514",
  promptName: "classify",
  system: LONG_SHARED_FRAME,
  cache: { kind: "static-prefix", ttl: "5m" },
  // ...
});

// Tool loop: every turn re-sends the system prompt, the tool specs AND the
// whole accumulated history. `conversation` adds a rolling breakpoint on the
// latest turn, so turn N reads the prefix turn N-1 wrote.
createLlmWithToolsNode({
  id: "triage",
  model: "claude-sonnet-4-20250514",
  tools: [lookupTool, escalateTool],
  cache: { kind: "conversation", ttl: "5m" },
  // ...
});
```

Caching is **opt-in everywhere**. Omitting `cache` produces a request byte-identical to one built before the feature existed — adding that field is the only thing that can change what a DAG costs.

### What It Catches

```typescript
// ❌ CAUGHT AT COMPILE TIME: conversation caching on a single-shot call.
// A single call has no second turn to read what the first wrote — asking for
// it would silently pay the write premium and never read it back.
createLlmNode({
  cache: { kind: "conversation", ttl: "5m" },
  //      ^^^ Type '"conversation"' is not assignable to
  //          '"none" | "static-prefix"'
});

// ❌ UNREPRESENTABLE: exceeding the provider's 4-breakpoint cap.
// The two placements are structural (end of system, end of the latest turn),
// and the conversation breakpoint ROLLS rather than accumulating — so a
// 50-turn loop still emits exactly 2, not 51.

// ❌ UNREPRESENTABLE: a breakpoint after volatile content.
// Caching is a prefix match; anything after the last breakpoint is never
// cached. The per-call user message renders into `messages`, which the
// provider renders last — so this holds by construction, not by convention.

// ⚠️ CAUGHT AT RUNTIME, LOUDLY: caching that silently did nothing.
// Below the model's minimum cacheable prefix (512-4096 tokens, model-
// dependent) the provider caches nothing, reads nothing, and raises nothing.
[classify] Prompt cache policy "static-prefix" was declared but the provider
reported no cache write and no cache read (310 prompt tokens). Likely causes:
the cacheable prefix is below this model's minimum, or content before the
breakpoint changes between calls.
```

### The Accounting Trap It Closes

Anthropic reports `usage.input_tokens` as the **uncached remainder** — cached prompt tokens are excluded and reported separately. OpenAI does the opposite: its `input_tokens` **includes** them. Before this feature, `tokensIn` was assigned straight from `input_tokens`, and the host's per-run token budget derives its cumulative from that field:

```typescript
// ❌ WITHOUT NORMALISATION: enabling caching shrinks a run's apparent usage.
// A 10,000-token prompt served 90% from cache reports input_tokens: 1000 on
// Anthropic. The budget under-counts by 9,000 tokens per call — silently,
// with no error raised, until the run overruns its ceiling.

// ✅ WITH IT: `tokensIn` is ALWAYS the complete prompt count, on both
// providers. The uncached remainder is derived, never stored, so a total that
// disagrees with its parts is unrepresentable.
usage.tokensIn            // 10_000  — every prompt token
usage.cacheReadTokens     //  9_000  — billed at ~0.1x
uncachedInputTokens(usage)//  1_000  — derived
```

Cost weights the three classes separately: uncached at 1.0x, cache-write at 1.25x (`5m`) or 2.0x (`1h`), cache-read at 0.1x. Traces carry `gen_ai.usage.cache_read_input_tokens`, `ai.prompt_cache.policy` and `ai.prompt_cache.effective`.

### Why It Matters

A ten-turn tool loop pays for its system prompt, tool specs and history ten times. Cache reads cost roughly a tenth of base input, so the break-even is two requests — but the write premium means always-on caching is *worse* for a single call over a large unique prefix. Making it a declared policy keeps the choice explicit and the cost predictable, while keeping the provider's rules (four-slot cap, prefix ordering, TTL vocabulary) out of every call site. See ADR-0081.

---

## 22. Per-Run Spend Budget

### What It Does

Refuses an LLM call **before** it happens once a run has reached a declared ceiling. Ceilings are declared per DAG, on any combination of three axes:

```yaml
# fugue.yaml
llmBudget:
  usd: 2.50      # dollars — the axis that means what you meant
  tokens: 500000 # every token, both directions
  calls: 40      # settled provider round trips
```

```typescript
// dag.ts — the same block, or the legacy scalar
export default {
  config: { llmBudget: { usd: 2.5 } },
  // `llmBudgetTokens: 500000` still works; it is sugar for `{ tokens: 500000 }`
};
```

A run is refused when **any** declared axis is reached. The refusal is a `llm-budget-exceeded` `FrameworkError` (HTTP 429 with `Retry-After`) whose `cause` names the ceiling, the observed figure, and whether the **settled** total or the **projection** including in-flight concurrent calls drove the decision.

Cost is computed from the prompt-cache split, so a cached run and an uncached one are priced differently even at identical token counts — the reason the budget is denominated in money at all.

**Unpriced models fail closed.** `PRICE_TABLE` is hand-maintained; a model with no entry has an unknown cost, and a `usd` ceiling refuses rather than treating unknown as free. The refusal names the model so the fix is obvious. Token and call ceilings are unaffected — they are perfectly evaluable on any model.

Omitting every ceiling means no enforcement: calls are still metered and logged (`llm.metered`), never refused.

Nodes can declare the read-only Budget Capability and adapt before they fan out:

```ts
const plan = createFetchNode({
  id: "plan",
  requires: ["budget"] as const,
  // `remaining()` uses the SAME projection as admission, including reservations.
  fetch: async (_input, ctx) => {
    const remaining = ctx.budget.remaining();
    const spent = ctx.budget.spent(); // settled, deeply immutable snapshot
    return ok({ remaining, spent });
  },
  // ...schemas/side effects...
});
```

`remaining()` returns `{ kind: "unbudgeted" }` when no ceiling exists. Otherwise
it returns canonical per-axis headroom with `basis: "projected"`; numeric
headroom clamps at zero, while unknown cost under a USD ceiling is an explicit
`{ kind: "unpriced", models, observedAtLeast }` member. Budget reads can affect
retry-time decisions, just like clock reads can affect time-dependent nodes, so
node tests should inject `fixedBudgetCapability` from
`@fuguejs/framework/testing`.

### Why It Matters

Before prompt caching, a token count was a serviceable proxy for money. It no longer is: a cache read bills at 0.1x and a write at up to 2.0x, so three runs reporting the same 110,000 tokens can span **13.8x** in real cost. A ceiling that cannot see that difference is not protecting a budget.

Overshoot is bounded rather than eliminated: the check runs before the call against spend that settles after it, so exactly one call passes a reached ceiling in the sequential case, and a concurrency reservation bounds the parallel case. See ADR-0082.

**Spend is durable.** A resumable run builds a fresh NodeContext per execution slice, so the in-process counter alone would let a run that parks for a human decision resume with its budget refilled — five parks, six budgets. A spend ledger (Redis, file, or in-process for a single-process deployment) is hydrated once when a slice starts and appended to as calls settle, so a run that parked already over its ceiling refuses immediately on resume.

A budgeted run whose ledger cannot be READ refuses the slice: an unreadable ledger is indistinguishable from a spent one, and assuming zero is the refill bug by another name. An unbudgeted run carries on — there is no ceiling to protect. A failed ledger WRITE never fails the call, because the tokens are already spent; it is logged at `error` under a declared budget.

One Run Spend Authority meters `ctx.llm`, `judgeLlm`, and every custom
boot-scoped `CapabilityHandle` marked `clientKind: "llm"`. They share one
reservation gate, spent view, ceiling, and ledger. File-durable embedders can
inject the host's `createFileSpendLedger(root)` adapter; the stock host remains
Redis-first and retains its in-process fallback.

---

## Quick Reference: Error → Feature Mapping

| Failure Mode | Feature That Catches It |
|---|---|
| Edge references non-existent node | Boot-time DAG validation |
| Argument swap (runId ↔ nodeId) | Branded identifiers |
| Unchecked error from LLM call | Result type (forced handling) |
| Node runs without required LLM client | Capability validation |
| Race condition between concurrent nodes | Wave-based execution |
| Thundering herd on rate limit | Jitter on retry backoff |
| Route fires on miscalibrated confidence | Typed confidence with provenance |
| Human edit breaks downstream schema | approve-with-edit validation |
| Concurrent writes overwrite each other | Freshness witness contracts |
| Resume replays stale cached output | Checkpoint schema + fingerprint validation |
| New event type silently dropped | Exhaustive observer pattern |
| Storing traces for boring successful runs | Tail-sampling persistence policies |
| Retrying a permanent API key error | LLM error classification (retriability) |
| Model loops tools forever | Tool-use iteration limit |
| Broken judge silently passes | Crash → `outcome: "crash"` (never passes) |
| LLM hallucinates unsupported claims | Guardrail grounding checks |
| PII leaks into trace backend | Content filter on span export |
| Worker crash loses in-flight work | Durable queue + checkpoint resume |
| Circular task dependency hangs scheduler | Cycle detection at reconcile |
| `ioredis` leaks into consumer bundles | Automated import boundary enforcement |
| Conversation caching on a single-shot call | Split single-shot / conversation policy types |
| Cache breakpoints accumulating past the provider cap | Rolling breakpoint, applied to a copy |
| Enabling caching silently shrinks a run's metered tokens | Provider-normalised inclusive `tokensIn` |
| A cache policy that quietly does nothing | Inert-policy warning + `ai.prompt_cache.effective` |
