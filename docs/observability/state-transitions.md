# State-Transition Observability

Fugue's Level 3 observability model ensures that for any production failure, an operator can answer five questions **from the event log alone**, without grepping source code or asking the original author:

1. **Which step's belief broke down?** → `RouteDecidedEvent.evidence.predicateResults`
2. **Was the model uncertain at the handoff?** → `RouteEvidence.upstreamConfidence` (bucket + source)
3. **What did this run mutate?** → `NodeStartEvent.sideEffects` / `WriteAttemptedEvent`
4. **Did the world change between read and write?** → `FreshnessViolationEvent`
5. **Did a human gate this decision, and what did they see?** → `HumanInterventionEvent.context`

---

## Five Observability Primitives

| # | Primitive | Phase | What it captures |
|---|-----------|-------|------------------|
| 1 | Side-effects taxonomy | Phase 1 | Every node declares `none`, `reads`, `writes`, or `external-call` with a resource identifier |
| 2 | Bucketed confidence with route evidence | Phase 2 | Routing decisions colocate upstream output + confidence bucket/source + per-predicate evaluation |
| 3 | Freshness witness contract | Phase 3 | Reads emit version witnesses, writes declare conditions, framework detects stale-read→write skew |
| 4 | Human intervention telemetry | Phase 4 | Human actions carry full decision context (confidence, side-effects, freshness state) |
| 5 | MLflow exporter polish | Phase 5 | All signals promoted to filterable MLflow tags for dashboard segmentation |

---

## Event Types Reference

### `RouteDecidedEvent`

Emitted after every routing decision. The `evidence` field is the forensic payload.

```ts
interface RouteDecidedEvent {
  type: "route-decided";
  runId: RunId;
  dagId: DagId;
  fromNodeId: NodeId;
  chosenTargets: readonly NodeId[];
  prunedTargets: readonly NodeId[];
  defaultTaken: boolean;
  evidence: {
    upstreamOutput: unknown;
    upstreamConfidence: Confidence | null;
    predicateResults: ReadonlyArray<{
      predicateLabel: string;
      matched: boolean;
      evaluatedConfidence: Confidence | null;
      errorKind?: "malformed" | "threw" | "below-min-confidence";
    }>;
    decidedAtMs: number;
  };
  timestamp: Date;
}
```

### `WitnessCapturedEvent`

Emitted after a `reads` node completes. Records the version state of the external resource.

```ts
interface WitnessCapturedEvent {
  type: "witness-captured";
  runId: RunId;
  dagId: DagId;
  nodeId: NodeId;
  witness: { kind: WitnessKind; resource: string; value: string };
  capturedAtMs: number;
  timestamp: Date;
}
```

### `WriteAttemptedEvent`

Emitted after a `writes` node completes. Records both the precondition witness and the new version.

```ts
interface WriteAttemptedEvent {
  type: "write-attempted";
  runId: RunId;
  dagId: DagId;
  nodeId: NodeId;
  conditionedOn: Witness;
  newWitness: Witness;
  succeededAtMs: number;
  timestamp: Date;
}
```

### `FreshnessViolationEvent`

Emitted when the framework detects a stale-read→write hazard.

```ts
interface FreshnessViolationEvent {
  type: "freshness-violation";
  runId: RunId;
  dagId: DagId;
  nodeId: NodeId;
  resource: string;
  conditionedOnWitness: Witness;
  conflictingWrite: {
    runId: RunId;
    nodeId: NodeId;
    newWitness: Witness;
    succeededAtMs: number;
  };
  detectedAtMs: number;
  timestamp: Date;
}
```

### `HumanInterventionEvent`

Emitted when a human reviewer responds to an `awaiting-human` gate. The `context` field unifies Phases 1–3 at the moment of human decision.

```ts
interface HumanInterventionEvent {
  type: "human-intervention";
  runId: RunId;
  dagId: DagId;
  nodeId: NodeId;
  action: HumanActionDetailed;
  actor: string;
  elapsedMsSinceAwait: number;
  context: {
    nodeConfidence: Confidence | null;
    nodeSideEffects: SideEffectKind;
    priorWitnesses: readonly Witness[];
  };
  timestamp: Date;
}
```

---

## Worked Example: Refund Pipeline

A DAG with four nodes processing a customer refund:

```
fetch-order → assess-risk → execute-refund → human-review
```

### Node definitions

```ts
const dag = defineDag({
  id: "refund-pipeline",
  nodes: {
    "fetch-order": {
      kind: "fetch",
      sideEffects: {
        kind: "reads",
        resource: "postgres:orders",
        // resource-free: the framework stamps sideEffects.resource
        extractWitness: (output) => witnessValue("version", String(output.xmin)),
      },
      confidence: { mode: "none" },
      run: async (input, ctx) => { /* fetch order by ID */ },
    },
    "assess-risk": {
      kind: "llm",
      sideEffects: { kind: "none" },
      confidence: {
        mode: "value",
        extract: (output) => ({
          bucket: output.riskAssessment.confidence,  // "high" | "medium" | "low"
          source: "self-reported-bucket",
        }),
      },
      run: async (input, ctx) => { /* LLM risk assessment */ },
    },
    "execute-refund": {
      kind: "transform",
      sideEffects: {
        kind: "writes",
        resource: "postgres:orders",
        // conditionedOn keeps a full witness (its resource is a free variable);
        // newWitness is this node's own resource, so it's resource-free.
        extractConditionedOn: (input) => witness("version", resourceName("postgres:orders"), String(input.orderVersion)),
        extractNewWitness: (output) => witnessValue("version", String(output.newXmin)),
      },
      confidence: { mode: "none" },
      run: async (input, ctx) => { /* execute the refund */ },
    },
    "human-review": {
      kind: "transform",
      sideEffects: { kind: "none" },
      confidence: { mode: "none" },
      humanReview: { prompt: "Approve this refund?" },
      run: async (input) => ok(input),
    },
  },
  edges: [
    { from: "fetch-order", to: "assess-risk" },
    {
      from: "assess-risk",
      to: "execute-refund",
      when: { label: "risk-acceptable", check: (v) => v.riskAssessment.level !== "critical" },
    },
    { from: "execute-refund", to: "human-review" },
  ],
});
```

### Event sequence with freshness violation

Another process writes `version=43` to the same order between `fetch-order` completing (version=42) and `execute-refund` starting.

```json
[
  { "type": "run-start", "runId": "run-abc", "dagId": "refund-pipeline" },

  { "type": "node-start", "nodeId": "fetch-order",
    "sideEffects": { "kind": "reads", "resource": "postgres:orders" } },
  { "type": "node-end", "nodeId": "fetch-order", "output": { "orderId": 555, "xmin": 42 } },
  { "type": "witness-captured", "nodeId": "fetch-order",
    "witness": { "kind": "version", "resource": "postgres:orders", "value": "42" },
    "capturedAtMs": 1715800000000 },

  { "type": "node-start", "nodeId": "assess-risk",
    "sideEffects": { "kind": "none" } },
  { "type": "node-end", "nodeId": "assess-risk",
    "output": { "riskAssessment": { "level": "medium", "confidence": "medium" } } },
  { "type": "route-decided", "fromNodeId": "assess-risk",
    "chosenTargets": ["execute-refund"], "defaultTaken": false,
    "evidence": {
      "upstreamConfidence": { "bucket": "medium", "source": "self-reported-bucket" },
      "predicateResults": [
        { "predicateLabel": "risk-acceptable", "matched": true,
          "evaluatedConfidence": { "bucket": "medium", "source": "self-reported-bucket" } }
      ],
      "decidedAtMs": 1715800001500
    } },

  { "type": "node-start", "nodeId": "execute-refund",
    "sideEffects": { "kind": "writes", "resource": "postgres:orders" } },
  { "type": "freshness-violation", "nodeId": "execute-refund",
    "resource": "postgres:orders",
    "conditionedOnWitness": { "kind": "version", "resource": "postgres:orders", "value": "42" },
    "conflictingWrite": {
      "runId": "run-xyz", "nodeId": "update-shipping",
      "newWitness": { "kind": "version", "resource": "postgres:orders", "value": "43" },
      "succeededAtMs": 1715800001200
    },
    "detectedAtMs": 1715800002000 },
  { "type": "node-end", "nodeId": "execute-refund",
    "output": { "refunded": true, "newXmin": 44 } },
  { "type": "write-attempted", "nodeId": "execute-refund",
    "conditionedOn": { "kind": "version", "resource": "postgres:orders", "value": "42" },
    "newWitness": { "kind": "version", "resource": "postgres:orders", "value": "44" },
    "succeededAtMs": 1715800002500 },

  { "type": "human-intervention", "nodeId": "human-review",
    "action": { "kind": "approve" },
    "actor": "alice",
    "elapsedMsSinceAwait": 12500,
    "context": {
      "nodeConfidence": null,
      "nodeSideEffects": "none",
      "priorWitnesses": [
        { "kind": "version", "resource": "postgres:orders", "value": "42" }
      ]
    } },

  { "type": "run-end", "runId": "run-abc", "status": "ok" }
]
```

**What an operator sees:** The `freshness-violation` event immediately shows that `execute-refund` acted on stale data (version 42, superseded by version 43 from `run-xyz`). The `human-intervention` event shows Alice approved despite the violation, seeing the stale witness in her `priorWitnesses` context.

---

## MLflow Tags

All state-transition signals are promoted to filterable MLflow tags by the `MlflowOtlpExporter`:

| MLflow Tag | Source | Values |
|---|---|---|
| `mlflow.side_effects` | Phase 1 — `AI_NODE_SIDE_EFFECTS_KIND` | `writes` \| `external-call` (only for mutation nodes) |
| `mlflow.route.confidence_bucket` | Phase 2 — `AI_ROUTE_CONFIDENCE_BUCKET` | `high` \| `medium` \| `low` \| `unknown` |
| `mlflow.route.confidence_source` | Phase 2 — `AI_ROUTE_CONFIDENCE_SOURCE` | `self-reported-bucket` \| `self-reported-numeric` \| `logprob` \| `classifier-probability` \| `ensemble-agreement` \| `heuristic` |
| `mlflow.freshness.violation` | Phase 3 — `AI_FRESHNESS_VIOLATION` | `true` (only when detected) |
| `mlflow.freshness.resource` | Phase 3 — `AI_FRESHNESS_WITNESS_RESOURCE` | Resource identifier string |
| `mlflow.human.action` | Phase 4 — `AI_HUMAN_ACTION` | `approve` \| `approve-with-edit` \| `reject` \| `reroute` |
| `mlflow.human.actor` | Phase 4 — `AI_HUMAN_ACTOR` | Actor identifier string |
| `mlflow.human.confidence_bucket_at_intervention` | Phase 4 — `AI_HUMAN_CONFIDENCE_BUCKET` | Confidence bucket at decision time |
| `mlflow.human.confidence_source_at_intervention` | Phase 4 — `AI_HUMAN_CONFIDENCE_SOURCE` | Confidence source at decision time |

---

## Dashboard Queries

### Find runs with freshness violations

```sql
SELECT
  r.run_id,
  r.start_time,
  t_resource.value AS resource,
  t_violation.value AS violation
FROM runs r
JOIN tags t_violation ON r.run_id = t_violation.run_id
  AND t_violation.key = 'mlflow.freshness.violation'
  AND t_violation.value = 'true'
LEFT JOIN tags t_resource ON r.run_id = t_resource.run_id
  AND t_resource.key = 'mlflow.freshness.resource'
ORDER BY r.start_time DESC;
```

### Find human interventions where confidence was low

```sql
SELECT
  r.run_id,
  t_action.value AS human_action,
  t_actor.value AS actor,
  t_bucket.value AS confidence_bucket,
  t_source.value AS confidence_source
FROM runs r
JOIN tags t_action ON r.run_id = t_action.run_id
  AND t_action.key = 'mlflow.human.action'
JOIN tags t_bucket ON r.run_id = t_bucket.run_id
  AND t_bucket.key = 'mlflow.human.confidence_bucket_at_intervention'
  AND t_bucket.value = 'low'
LEFT JOIN tags t_actor ON r.run_id = t_actor.run_id
  AND t_actor.key = 'mlflow.human.actor'
LEFT JOIN tags t_source ON r.run_id = t_source.run_id
  AND t_source.key = 'mlflow.human.confidence_source_at_intervention'
ORDER BY r.start_time DESC;
```

### Find runs where humans edited model output, grouped by confidence source

```sql
SELECT
  t_source.value AS confidence_source,
  COUNT(*) AS edit_count
FROM runs r
JOIN tags t_action ON r.run_id = t_action.run_id
  AND t_action.key = 'mlflow.human.action'
  AND t_action.value = 'approve-with-edit'
LEFT JOIN tags t_source ON r.run_id = t_source.run_id
  AND t_source.key = 'mlflow.human.confidence_source_at_intervention'
GROUP BY t_source.value
ORDER BY edit_count DESC;
```

### Find all writes to a specific resource

```sql
SELECT
  r.run_id,
  r.start_time,
  t_se.value AS side_effect_kind
FROM runs r
JOIN tags t_resource ON r.run_id = t_resource.run_id
  AND t_resource.key = 'mlflow.freshness.resource'
  AND t_resource.value = 'postgres:orders'
JOIN tags t_se ON r.run_id = t_se.run_id
  AND t_se.key = 'mlflow.side_effects'
  AND t_se.value = 'writes'
ORDER BY r.start_time DESC;
```

### Calibration query: human rejection rate by confidence bucket and source

```sql
SELECT
  t_bucket.value AS confidence_bucket,
  t_source.value AS confidence_source,
  COUNT(*) AS total_interventions,
  SUM(CASE WHEN t_action.value = 'reject' THEN 1 ELSE 0 END) AS rejections,
  ROUND(
    SUM(CASE WHEN t_action.value = 'reject' THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
    1
  ) AS rejection_rate_pct
FROM runs r
JOIN tags t_action ON r.run_id = t_action.run_id
  AND t_action.key = 'mlflow.human.action'
JOIN tags t_bucket ON r.run_id = t_bucket.run_id
  AND t_bucket.key = 'mlflow.human.confidence_bucket_at_intervention'
LEFT JOIN tags t_source ON r.run_id = t_source.run_id
  AND t_source.key = 'mlflow.human.confidence_source_at_intervention'
GROUP BY t_bucket.value, t_source.value
ORDER BY rejection_rate_pct DESC;
```

This is the **calibration segmentation payoff**: you can see which confidence sources are well-calibrated (low rejection rate at `high` bucket) and which are systematically miscalibrated (high rejection rate despite `high` bucket). Nodes using `self-reported-numeric` with bad thresholds will show up here.

---

## Patterns for Node Authors

### Declaring `sideEffects`

Every `NodeDef` requires a `sideEffects` field. Use the `defineSimpleNode()` helper for pure transforms, or declare explicitly:

```ts
// Pure computation — no external interactions
const transformNode = {
  sideEffects: { kind: "none" },
  // ...
};

// Reads from an external resource
const fetchNode = {
  sideEffects: { kind: "reads", resource: "postgres:customers" },
  // ...
};

// Writes to an external resource
const writeNode = {
  sideEffects: {
    kind: "writes",
    resource: "postgres:orders",
    idempotencyKey: (input) => `refund-${input.orderId}`,
  },
  // ...
};

// Calls an external API (non-idempotent)
const apiNode = {
  sideEffects: {
    kind: "external-call",
    resource: "stripe:charges",
    idempotencyKey: (input) => input.chargeId,
  },
  // ...
};
```

The `resource` string should be a stable identifier matching the pattern `{system}:{entity}` — e.g. `postgres:orders`, `s3:receipts`, `stripe:charges`. This enables cross-run freshness detection and MLflow filtering.

### Declaring `confidence`

Every `NodeDef` requires a `confidence` field. Opt out explicitly with `{ mode: "none" }` or declare an extractor:

```ts
import { bucketFromProbability } from "@fuguejs/framework";

// No confidence signal (deterministic node)
const deterministicNode = {
  confidence: { mode: "none" },
  // ...
};

// LLM self-reports a bucket directly (recommended for LLM nodes)
const llmNode = {
  confidence: {
    mode: "value",
    extract: (output) => ({
      bucket: output.confidence,  // LLM outputs "high" | "medium" | "low"
      source: "self-reported-bucket",
    }),
  },
  // ...
};

// Classifier with calibrated probability
const classifierNode = {
  confidence: {
    mode: "value",
    extract: (output) => ({
      bucket: bucketFromProbability(output.score),  // 0.85+ → high, 0.6+ → medium, else → low
      source: "classifier-probability",
      raw: output.score,  // kept for forensics
    }),
  },
  // ...
};

// Deterministic guardrail — always high confidence
const guardrailNode = {
  confidence: {
    mode: "value",
    extract: () => ({ bucket: "high", source: "heuristic" }),
  },
  // ...
};
```

**Bucket thresholds:** `bucketFromProbability` defaults to `{ high: 0.85, medium: 0.6 }`. Override per node:

```ts
bucketFromProbability(score, { high: 0.9, medium: 0.7 })
```

### Declaring freshness extractors (`extractWitness`, `extractConditionedOn`, `extractNewWitness`)

Freshness extractors are **optional** on `reads` and `writes` nodes. Add them when the node interacts with a resource whose version matters for correctness. See [ADR-0025](../adr/0025-freshness-witness-contract.md) for the full contract.

#### `reads` node — `extractWitness`

Called after the node completes. Returns the version state observed.

```ts
const fetchOrderNode = {
  kind: "fetch",
  sideEffects: {
    kind: "reads",
    resource: "postgres:orders",
    // Returns only (kind, value); the framework stamps sideEffects.resource.
    extractWitness: (output) => witnessValue("version", String(output.xmin)), // Postgres xmin is a monotonic integer
  },
  confidence: { mode: "none" },
  run: async (input, ctx) => {
    const order = await db.query("SELECT *, xmin FROM orders WHERE id = $1", [input.orderId]);
    return ok(order);
  },
};
```

#### `writes` node — `extractConditionedOn` + `extractNewWitness`

- `extractConditionedOn(input)`: Called after the node completes. Extracts the version the write assumed was still current (from the node's input, which carries the upstream read's version).
- `extractNewWitness(output)`: Called after execution. Returns the new version produced.

```ts
const executeRefundNode = {
  kind: "transform",
  sideEffects: {
    kind: "writes",
    resource: "postgres:orders",
    // conditionedOn returns a full witness — its resource is a free variable
    // (a write may condition on a resource read upstream).
    extractConditionedOn: (input) => witness("version", resourceName("postgres:orders"), String(input.orderVersion)), // version from upstream fetch
    // newWitness is this node's own resource → resource-free, framework-stamped.
    extractNewWitness: (output) => witnessValue("version", String(output.newXmin)), // version after our write
  },
  confidence: { mode: "none" },
  run: async (input, ctx) => {
    const result = await db.query(
      "UPDATE orders SET status = 'refunded' WHERE id = $1 RETURNING xmin",
      [input.orderId],
    );
    return ok({ refunded: true, newXmin: result.xmin });
  },
};
```

#### Witness kinds

| Kind | Use case | Example value |
|---|---|---|
| `version` | Monotonic integer (Postgres xmin, Hibernate @Version) | `"42"` |
| `etag` | Hash-based (HTTP ETag, S3, DynamoDB) | `"W/\"abc123\""` |
| `timestamp` | Millisecond-precision (poor man's version) | `"1715800000000"` |
| `lsn` | Log sequence number (Postgres WAL) | `"0/16B3748"` |
| `idempotency-key` | Request-scoped (Stripe, Plaid) | `"ikey_abc123"` |
| `custom` | Domain-specific | Any opaque string |

### Sugar helpers

For nodes with no side effects and no confidence, use the constants:

```ts
import { NO_SIDE_EFFECTS, NO_CONFIDENCE } from "@fuguejs/framework";

const simpleNode = {
  sideEffects: NO_SIDE_EFFECTS,  // { kind: "none" }
  confidence: NO_CONFIDENCE,      // { mode: "none" }
  // ...
};
```

---

## Related ADRs

- [ADR-0025 — Freshness Witness Contract](../adr/0025-freshness-witness-contract.md)
- [ADR-0026 — Human Intervention as First-Class Telemetry](../adr/0026-human-intervention-telemetry.md)
