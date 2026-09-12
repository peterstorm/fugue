import type {
  DagDef,
  DagDefInput,
  EdgeDef,
  EdgeDefRawInput,
} from "../types/dag.js";
import type { NodesRecord, MapNodeDef } from "../types/dag.js";
import { isAuthoredCollectGather, isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import { asMaxWidth, asWidthFrom } from "../types/map-width.js";
import { safeErrorMessage } from "../types/safe-error.js";
import type { FrameworkError } from "../types/errors.js";
import type { EvalJudgeNodeDef } from "../types/eval-judge.js";
import { frameworkError } from "../types/error-factories.js";
import type { NodeId } from "../types/ids.js";
import { nodeId, tryNodeId, tryDagId, DAG_INPUT, isDagInput } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { CONFIDENCE_ORDER, type ConfidenceBucket } from "../types/confidence.js";

/** Normalize a shape-checked raw edge with its already-parsed endpoint proofs. */
const normalizeEdge = (e: EdgeDefRawInput, from: NodeId, to: NodeId): EdgeDef => {
  if ("kind" in e && e.kind === "default") {
    return Object.freeze({ from, to, kind: "default" as const });
  }
  if ("when" in e) {
    return Object.freeze({ from, to, kind: "conditional" as const, when: e.when });
  }
  return Object.freeze({ from, to, kind: "unconditional" as const });
};

/** Own the validated routing policy instead of retaining caller-owned state. */
const snapshotEdge = (edge: EdgeDef): EdgeDef =>
  isConditionalEdge(edge)
    ? Object.freeze({
        ...edge,
        when: Object.freeze({ ...edge.when }),
      })
    : edge;

const validationErr = (nodeId: NodeId, message: string): FrameworkError => ({
  kind: "validation" as const,
  nodeId,
  message,
});

/** Own evaluator data, retaining opaque executable references rather than freezing closures. */
const snapshotEvalJudges = (
  input: Pick<DagDefInput, "evalJudges">,
): Result<readonly EvalJudgeNodeDef[] | undefined, FrameworkError> => {
  try {
    const judges = input.evalJudges;
    if (judges === undefined) return ok(undefined);
    return ok(Object.freeze(judges.map((judge) => {
      // Capture each accessor once; all subsequent reads use these own data values.
      const captured = { ...judge };
      const config = { ...captured.config };
      return Object.freeze({
        ...captured,
        config: Object.freeze({
          ...config,
          criteria: Object.freeze([...config.criteria]),
          ...(config.rubric !== undefined ? { rubric: Object.freeze({ ...config.rubric }) } : {}),
        }),
      });
    })));
  } catch (cause) {
    return err(validationErr(nodeId("__dag__"), `invalid evaluator snapshot: ${safeErrorMessage(cause)}`));
  }
};

/** Defensive immutable copy issued only after the node has passed validation. */
const snapshotNode = (
  node: DagDef["nodes"][number],
): Result<DagDef["nodes"][number], FrameworkError> => {
  try {
    const captured = { ...node };
    const mapped = captured.kind === "map" ? snapshotMapping(captured) : ok(undefined);
    if (!mapped.ok) return mapped;
    return ok(Object.freeze({
      ...captured,
      ...(mapped.value !== undefined ? { mapping: mapped.value } : {}),
      requires: captured.kind === "map"
        ? Object.freeze(["checkpointer"] as const)
        : Object.freeze([...captured.requires]),
      sideEffects: Object.freeze({ ...captured.sideEffects }),
      confidence: Object.freeze({ ...captured.confidence }),
      ...(captured.humanReview !== undefined
        ? { humanReview: Object.freeze({ ...captured.humanReview }) }
        : {}),
      ...(captured.retry !== undefined
        ? {
            retry: Object.freeze({
              ...captured.retry,
              ...(captured.retry.backoffMs !== undefined
                ? {
                    backoffMs: Object.freeze([
                      captured.retry.backoffMs[0],
                      ...captured.retry.backoffMs.slice(1),
                    ] as [number, ...number[]]),
                  }
                : {}),
            }),
          }
        : {}),
    }) as DagDef["nodes"][number]);
  } catch (cause) {
    return err(validationErr(node.id, `invalid node snapshot: ${safeErrorMessage(cause)}`));
  }
};

const mappedChildEligibility = (mapNodeId: NodeId, child: DagDef): Result<DagDef, FrameworkError> => {
  for (const node of child.nodes) {
    if (node.kind === "map") return err(validationErr(mapNodeId,
      `map '${mapNodeId}' child '${child.id}' contains nested map '${node.id}'; nested maps are unsupported`));
    if (node.humanReview !== undefined) return err(validationErr(mapNodeId,
      `map '${mapNodeId}' child '${child.id}' declares humanReview on '${node.id}'. Fan, GATHER, then put one humanReview node on the gathered array (FR-F1-011)`));
    const se = node.sideEffects;
    if ((se.kind === "reads" && se.extractWitness !== undefined) ||
        (se.kind === "writes" && (se.extractConditionedOn !== undefined || se.extractNewWitness !== undefined))) {
      return err(validationErr(mapNodeId,
        `map '${mapNodeId}' child '${child.id}' node '${node.id}' declares freshness extractors; indexed/epoch witness identity is unsupported`));
    }
  }
  return ok(child);
};

/** Bounded child snapshot: no recursive map or indexed human/witness semantics. */
export const snapshotMappedChild = (mapNodeId: NodeId, child: DagDef): Result<DagDef, FrameworkError> => {
  try {
    const eligible = mappedChildEligibility(mapNodeId, child);
    if (!eligible.ok) return eligible;
    // Capture discriminants before parsing: a getter must not introduce a map
    // after the early refusal and recurse into an unsupported/cyclic graph.
    const captured = { ...child, nodes: child.nodes.map((node) => ({ ...node })) };
    const bounded = mappedChildEligibility(mapNodeId, captured);
    if (!bounded.ok) return bounded;
    const parsed = validateDagShape({ ...captured, nodes: recordFromNodeArray(captured.nodes) }, captured.provenance);
    if (!parsed.ok) return parsed;
    // Eligibility belongs to this exact owned, frozen execution snapshot, not
    // the caller's earlier observations (including nested profile accessors).
    return mappedChildEligibility(mapNodeId, parsed.value);
  } catch (cause) {
    return err(validationErr(mapNodeId, `invalid mapped child: ${safeErrorMessage(cause)}`));
  }
};

const snapshotMapping = (
  node: MapNodeDef,
): Result<MapNodeDef["mapping"], FrameworkError> => {
  const id = node.id;
  try {
    const requires = node.requires;
    if (!Array.isArray(requires) || requires.length !== 1 || requires[0] !== "checkpointer" || "run" in node) {
      return err(validationErr(id, `map '${id}' must declare only checkpointer and a mapping descriptor, not run`));
    }
    const { child, childOutputSchema, reduce, widthFrom, maxWidth, authoredGather } = node.mapping;
    const validGather = authoredGather === undefined || isAuthoredCollectGather(authoredGather, {
      outputSchema: node.outputSchema,
      childOutputSchema,
      reduce,
    });
    if (typeof widthFrom !== "string" || asWidthFrom(widthFrom) === undefined ||
        asMaxWidth(maxWidth) === undefined || typeof reduce !== "function" ||
        typeof childOutputSchema?.safeParse !== "function" || !validGather) {
      return err(validationErr(id, `map '${id}' requires a valid immutable mapping descriptor`));
    }
    const snapshot = snapshotMappedChild(id, child);
    if (!snapshot.ok) return snapshot;
    return ok(Object.freeze({
      child: snapshot.value,
      childOutputSchema,
      reduce,
      widthFrom,
      maxWidth,
      ...(authoredGather !== undefined ? { authoredGather } : {}),
    }));
  } catch (cause) {
    return err(validationErr(id, `invalid map '${id}' descriptor: ${safeErrorMessage(cause)}`));
  }
};

/**
 * Bucket `edges` by node id, pre-seeding an empty list for every known node so
 * a lookup never returns undefined for a real node. `include` filters which
 * edges participate — the three call sites differ ONLY in the key side and that
 * filter, and hand-rolling the loop each time is how they would drift on the
 * "skip edges pointing at unknown nodes" guard.
 */
const bucketEdgesBy = (
  nodeIds: Iterable<NodeId>,
  edges: readonly EdgeDef[],
  key: (edge: EdgeDef) => string,
  include: (edge: EdgeDef) => boolean = () => true,
): Map<string, EdgeDef[]> => {
  const buckets = new Map<string, EdgeDef[]>();
  for (const id of nodeIds) buckets.set(id, []);
  for (const edge of edges) {
    if (!include(edge)) continue;
    const list = buckets.get(key(edge));
    if (list) list.push(edge);
  }
  return buckets;
};

/**
 * Structural validation of a `DagDefInput`. On success, brands the input as
 * a runtime-shaped `DagDef` (nodes-as-array). The brand is the only path by
 * which `runDag` / `runDagStateful` accept a DAG, so calling this (or
 * `defineDag`) is the single, mandatory soundness gate.
 *
 * Topology rules (ADR 0015 + ADR 0017):
 *   - Edges are the single source of truth for wiring. `deps` /
 *     `optionalDeps` no longer exist on `NodeDef`; the runtime derives
 *     `{ required, optional }` per node at compile time.
 *   - Every node with at least one conditional out-edge MUST have exactly
 *     one `kind: "default"` out-edge (else-totality).
 *   - At most one edge per `(from, to)` pair.
 *   - Conditional `when` must be a well-formed function-based predicate
 *     with `{ label, version, check, minConfidence? }`.
 *   - `outputNodeId` (when set) must be reachable along unconditional +
 *     default edges only — predicates may bypass nodes, never the output.
 *
 * Record/key invariant:
 *   - Every record key matches its node's `id`. This is the only discrepancy
 *     possible when authors construct nodes via factory helpers that take
 *     `id` explicitly.
 */
export const validateDagShape = (
  input: DagDefInput,
  provenance?: DagDef["provenance"],
): Result<DagDef, FrameworkError> => {
  const validationNodeId = nodeId("__dag__");
  const parsedDagId = tryDagId(input.id);
  if (!parsedDagId.ok) {
    return err(validationErr(validationNodeId, parsedDagId.error));
  }

  const entries = Object.entries(input.nodes) as [
    string,
    DagDef["nodes"][number],
  ][];

  if (entries.length === 0) {
    return err(validationErr(validationNodeId, `DAG '${input.id}' has no nodes`));
  }

  // Record-key vs node.id consistency + key format validation.
  for (const [key, node] of entries) {
    const keyValid = tryNodeId(key);
    if (!keyValid.ok) {
      return err(
        validationErr(
          nodeId("__dag__"),
          `nodes['${key}'] has invalid id: ${keyValid.error}`,
        ),
      );
    }
    if (node.id !== key) {
      return err(
        validationErr(
          node.id,
          `nodes['${key}'] has id '${node.id}' — record key and node.id must match`,
        ),
      );
    }

    // Retry-config numeric domains (NodeRetryConfig): backoff delays must be
    // finite non-negative milliseconds, the ladder must NOT be empty (an
    // empty ladder has no attempt-0 delay — `every` would pass it vacuously
    // and the compiled `?? [1000, 2000, 4000]` default never fires for `[]`),
    // and the jitter ratio a finite value in [0, 1]. A NaN/negative delay or
    // out-of-range jitter would otherwise flow unvalidated into `applyJitter`
    // retry scheduling (a NaN/negative delay collapses `setTimeout` to an
    // immediate retry spin; jitter > 1 can invert the delay sign). Validation
    // lives at the single mandatory soundness gate with the same
    // `validation`-kind error naming the offending node.
    if (node.retry !== undefined) {
      const { backoffMs, jitterRatio } = node.retry;
      if (
        backoffMs !== undefined &&
        (backoffMs.length === 0 ||
          !backoffMs.every((ms) => Number.isFinite(ms) && ms >= 0))
      ) {
        return err(
          validationErr(
            node.id,
            `node '${node.id}' retry.backoffMs must be a non-empty ladder of finite non-negative numbers`,
          ),
        );
      }
      if (
        jitterRatio !== undefined &&
        !(Number.isFinite(jitterRatio) && jitterRatio >= 0 && jitterRatio <= 1)
      ) {
        return err(
          validationErr(
            node.id,
            `node '${node.id}' retry.jitterRatio must be a finite number in [0, 1]`,
          ),
        );
      }
    }
  }

  // DAG-level retry budgets (retryLimits / defaultRetryLimit): per-node
  // retry counts are compared against attempt counters, so the domain is the
  // same non-negative-safe-integer class as the node-level numeric gates
  // above. A bare `as Readonly<Record<string, number>>` pass-through (the
  // pre-fix shape) let NaN/negative/infinite limits flow into `getRetryLimit`
  // and corrupt the budget. Same single gate, same `validation`-kind error.
  if (input.retryLimits !== undefined) {
    for (const [key, limit] of Object.entries(input.retryLimits)) {
      // The key must NAME a node in this DAG. `retryLimits` is a raw
      // string-keyed record on the authoring surface — TypeScript erases a
      // branded key type on `Record<NodeId, number>` back to a string index
      // signature, so the only place a typo can be caught is here. Left
      // unchecked it silently no-ops: `getRetryLimit` never finds the entry
      // and the node quietly runs on `defaultRetryLimit ?? 0` instead of the
      // budget its author configured.
      if (!Object.hasOwn(input.nodes, key)) {
        return err(
          validationErr(
            nodeId("__dag__"),
            `retryLimits['${key}'] names no node in DAG '${input.id}' — a retry budget for an unknown node would be silently ignored`,
          ),
        );
      }
      if (limit === undefined) {
        return err(
          validationErr(
            nodeId("__dag__"),
            `retryLimits['${key}'] must be a non-negative safe integer, got undefined`,
          ),
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 0) {
        return err(
          validationErr(
            nodeId("__dag__"),
            `retryLimits['${key}'] must be a non-negative safe integer, got ${String(limit)}`,
          ),
        );
      }
    }
  }
  if (
    input.defaultRetryLimit !== undefined &&
    (!Number.isSafeInteger(input.defaultRetryLimit) || input.defaultRetryLimit < 0)
  ) {
    return err(
      validationErr(
        nodeId("__dag__"),
        `defaultRetryLimit must be a non-negative safe integer, got ${String(input.defaultRetryLimit)}`,
      ),
    );
  }

  const nodeIds = new Set(entries.map(([id]) => nodeId(id)));

  const parsedOutputNodeId = input.outputNodeId === undefined
    ? undefined
    : tryNodeId(input.outputNodeId);
  if (parsedOutputNodeId !== undefined && !parsedOutputNodeId.ok) {
    return err(
      validationErr(
        validationNodeId,
        `outputNodeId '${input.outputNodeId}' has invalid id: ${parsedOutputNodeId.error}`,
      ),
    );
  }
  const outputNodeId = parsedOutputNodeId?.value;

  // DAG_INPUT-edge well-formedness (C0). `$input` is the virtual request
  // source: legal only as an unconditional `from`. Parse every endpoint before
  // normalization so malformed raw identifiers remain in the Result channel.
  const rawEdges = input.edges as readonly EdgeDefRawInput[];
  const edges: EdgeDef[] = [];
  for (const e of rawEdges) {
    const parsedFrom = isDagInput(e.from) ? ok(DAG_INPUT) : tryNodeId(e.from);
    if (!parsedFrom.ok) {
      return err(validationErr(validationNodeId, `edge source '${e.from}' has invalid id: ${parsedFrom.error}`));
    }
    if (isDagInput(e.to)) {
      return err(
        frameworkError.invalidDagInputEdge(
          { from: e.from, to: e.to },
          `DAG_INPUT ('$input') cannot be an edge target — it is the virtual request source, never a node`,
        ),
      );
    }
    const parsedTo = tryNodeId(e.to);
    if (!parsedTo.ok) {
      return err(validationErr(validationNodeId, `edge target '${e.to}' has invalid id: ${parsedTo.error}`));
    }
    if (isDagInput(e.from)) {
      const conditionalOrDefault =
        ("when" in e) || ("kind" in e && e.kind === "default");
      if (conditionalOrDefault) {
        return err(
          frameworkError.invalidDagInputEdge(
            { from: e.from, to: e.to },
            `DAG_INPUT ('$input') edge to '${e.to}' must be unconditional — it carries no routing semantics (no \`when\`, no \`default\`)`,
          ),
        );
      }
    }
    edges.push(normalizeEdge(e, parsedFrom.value, parsedTo.value));
  }

  // Edge endpoints reference known nodes (the literal-typed input guards
  // this at edit time, but defensive at runtime for `as DagDefInput` casts).
  // `DAG_INPUT` is the one legal non-node source.
  for (const e of edges) {
    if (!isDagInput(e.from) && !nodeIds.has(e.from)) {
      return err(validationErr(e.from, `Edge references unknown source node '${e.from}'`));
    }
    if (!nodeIds.has(e.to)) {
      return err(validationErr(e.to, `Edge references unknown target node '${e.to}'`));
    }
  }

  // Edge uniqueness: at most one EdgeDef per (from, to) pair across all variants.
  const seenPairs = new Set<string>();
  for (const e of edges) {
    const key = `${e.from} ${e.to}`;
    if (seenPairs.has(key)) {
      return err({
        kind: "duplicate-edge",
        fromNodeId: e.from,
        toNodeId: e.to,
      });
    }
    seenPairs.add(key);
  }

  // Conditional edges must carry a well-formed function-based predicate with
  // a non-empty `label` and a `check` function.
  for (const e of edges) {
    if (!isConditionalEdge(e)) continue;
    const pred = e.when;
    if (pred === null || typeof pred !== "object" || Array.isArray(pred)) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' has a malformed predicate — expected an object with { label, check }`,
        ),
      );
    }
    const p = pred as { label?: unknown; check?: unknown; version?: unknown; minConfidence?: unknown };
    if (typeof p.label !== "string" || p.label.length === 0) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' predicate is missing a non-empty 'label'`,
        ),
      );
    }
    if (typeof p.version !== "number" || !Number.isInteger(p.version) || p.version < 0) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' predicate is missing a valid 'version' (non-negative integer)`,
        ),
      );
    }
    if (typeof p.check !== "function") {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' predicate is missing a 'check' function`,
        ),
      );
    }
    if (p.minConfidence !== undefined) {
      // Derive from CONFIDENCE_ORDER so adding a new ConfidenceBucket variant
      // automatically widens the accepted set without manual updates here.
      const validBuckets = Object.keys(CONFIDENCE_ORDER) as readonly ConfidenceBucket[];
      const minConfidence = p.minConfidence;
      if (typeof minConfidence !== "string" || !(validBuckets as readonly string[]).includes(minConfidence)) {
        return err({
          kind: "predicate-malformed",
          nodeId: e.from,
          message: `Edge '${e.from}' -> '${e.to}' predicate has invalid minConfidence '${String(minConfidence)}' — must be one of: ${validBuckets.join(", ")}`,
        });
      }
    }
  }

  // Source / root structural invariant (C0 / 0.2.0). No node implicitly
  // receives the DAG input: a node with zero incoming edges is a *source*
  // (built via `createSourceNode`, which sets `isSource: true`), and
  // a source must be a root. `DAG_INPUT` edges count as incoming here — a node
  // fed by `$input` is consuming the request and is therefore not a root.
  const incomingCount = new Map<NodeId, number>();
  for (const id of nodeIds) incomingCount.set(id, 0);
  for (const e of edges) {
    incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
  }
  for (const [, node] of entries) {
    const inDeg = incomingCount.get(node.id) ?? 0;
    if (node.isSource === true && inDeg > 0) {
      return err(
        frameworkError.sourceHasIncoming(
          node.id,
          `Source node '${node.id}' has ${inDeg} incoming edge(s) — a source produces from the context alone and consumes no input. Remove the incoming edge(s), or drop the source form and declare an inputSchema`,
        ),
      );
    }
    // A source consumes no DAG input, so its run always receives `undefined`.
    // The `isSource` flag and the input schema are correlated but not coupled in
    // the `NodeDef` type — `createSourceNode` sets `inputSchema: z.void()`, but a
    // hand- or dynamically-built node could pair `isSource: true` with a non-unit
    // schema that rejects `undefined`. Reject that here so the illegal state
    // fails at definition time instead of surfacing as a confusing runtime parse.
    if (node.isSource === true && !node.inputSchema.safeParse(undefined).success) {
      return err(
        validationErr(
          node.id,
          `Source node '${node.id}' has an inputSchema that rejects \`undefined\` — a source consumes no DAG input, so its inputSchema must be the unit schema (z.void()). Build it with createSourceNode`,
        ),
      );
    }
    if (node.isSource !== true && inDeg === 0) {
      return err(
        frameworkError.rootExpectsInput(
          node.id,
          `Node '${node.id}' has no incoming edges but is not a source node — under 0.2.0 no node implicitly receives the DAG input. Make it a source (build it with createSourceNode) if it needs none, or feed the request explicitly with a { from: DAG_INPUT, to: '${node.id}' } edge`,
        ),
      );
    }
  }

  // Else-totality: every node with any conditional out-edge must have exactly
  // one default out-edge.
  const outgoingByNode = bucketEdgesBy(nodeIds, edges, (e) => e.from);
  for (const id of nodeIds) {
    const out = outgoingByNode.get(id) ?? [];
    const guarded = out.filter(isConditionalEdge);
    const defaults = out.filter(isDefaultEdge);
    if (guarded.length === 0) {
      if (defaults.length > 0) {
        return err(
          validationErr(
            id,
            `Node '${id}' has a default edge but no conditional out-edges — drop the default`,
          ),
        );
      }
      continue;
    }
    if (defaults.length !== 1) {
      return err({ kind: "missing-default-edge", nodeId: id });
    }
  }

  if (outputNodeId !== undefined && !nodeIds.has(outputNodeId)) {
    return err(
      validationErr(
        outputNodeId,
        `outputNodeId '${outputNodeId}' is not a node in DAG '${input.id}'`,
      ),
    );
  }

  // Freshness extractor consistency: writes nodes that declare extractNewWitness
  // must also have extractConditionedOn (partial config is a bug). Reads nodes
  // without extractWitness simply opt out of freshness tracking (valid for
  // non-freshness-participating fetch nodes).
  for (const [, node] of entries) {
    const se = node.sideEffects;
    if (se.kind !== "writes") continue;
    // One XOR, stated once: whichever extractor is present without its twin
    // names itself in the message.
    const missing = se.extractNewWitness && !se.extractConditionedOn
      ? { declared: "extractNewWitness", absent: "extractConditionedOn" }
      : se.extractConditionedOn && !se.extractNewWitness
        ? { declared: "extractConditionedOn", absent: "extractNewWitness" }
        : null;
    if (missing !== null) {
      return err(
        validationErr(
          node.id,
          `Node '${node.id}' declares ${missing.declared} but is missing ${missing.absent}`,
        ),
      );
    }
  }

  if (outputNodeId !== undefined) {
    // `DAG_INPUT` is a virtual wave-(-1) source: always satisfied, imposing no
    // ordering. A node whose only inbound is a `$input` edge is therefore an
    // entry for reachability purposes (skip `$input` edges when counting
    // inbound), and the request flows in regardless of routing.
    const incomingAny = bucketEdgesBy(
      nodeIds,
      edges,
      (e) => e.to,
      (e) => !isDagInput(e.from),
    );
    const entryIds = [...nodeIds].filter(
      (id) => (incomingAny.get(id)?.length ?? 0) === 0,
    );

    const reachable = new Set<NodeId>(entryIds);
    const stack = [...reachable];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const e of outgoingByNode.get(cur) ?? []) {
        if (isConditionalEdge(e)) continue;
        if (!reachable.has(e.to)) {
          reachable.add(e.to);
          stack.push(e.to);
        }
      }
    }

    if (!reachable.has(outputNodeId)) {
      // Walk backward from the output along unconditional + default edges to
      // find the first node that has no unconditional/default inbound. That
      // node is the actual frontier — the place where routing diverged from
      // the output. Reporting the output node itself (the prior behaviour)
      // sent every consumer chasing the symptom rather than the cause.
      const incomingNonConditional = bucketEdgesBy(
        nodeIds,
        edges,
        (e) => e.to,
        (e) => !isConditionalEdge(e) && !isDagInput(e.from),
      );
      const visited = new Set<string>();
      const queue: string[] = [outputNodeId];
      let frontier: string = outputNodeId;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const ins = incomingNonConditional.get(cur) ?? [];
        if (ins.length === 0) {
          frontier = cur;
          break;
        }
        for (const e of ins) {
          if (!visited.has(e.from)) queue.push(e.from);
        }
      }
      return err({
        kind: "output-unreachable-under-routing",
        outputNodeId,
        missedFromNode: nodeId(frontier),
      });
    }
  }

  // This parser is the sole brand issuer. Snapshot every validated collection
  // first so caller-owned objects cannot mutate the proof after it is issued.
  // Predicate functions remain the validated executable values, but their
  // metadata container is parser-owned and frozen.
  const validatedEdges = edges.map(snapshotEdge);
  const nodes: DagDef["nodes"][number][] = [];
  for (const [, node] of entries) {
    const snapshot = snapshotNode(node);
    if (!snapshot.ok) return snapshot;
    nodes.push(snapshot.value);
  }
  const judges = snapshotEvalJudges(input);
  if (!judges.ok) return judges;
  const validated = Object.freeze({
    id: parsedDagId.value,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(validatedEdges),
    ...(outputNodeId !== undefined ? { outputNodeId } : {}),
    ...(judges.value !== undefined ? { evalJudges: judges.value } : {}),
    ...(input.retryLimits !== undefined
      ? { retryLimits: Object.freeze({ ...input.retryLimits }) }
      : {}),
    ...(input.defaultRetryLimit !== undefined
      ? { defaultRetryLimit: input.defaultRetryLimit }
      : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  }) as DagDef;
  return ok(validated);
};

// Exported so test helpers building array-shape inputs can convert. (The
// re-exports live in `executor/validate-dag.ts` and `executor/index.ts`.)
export const recordFromNodeArray = (
  nodes: DagDef["nodes"],
): NodesRecord => Object.fromEntries(nodes.map((node) => [node.id, node]));

/**
 * Re-parse retry overrides through the one DagDef soundness gate. Invalid node
 * names or counts remain typed validation failures; no unchecked rebranding
 * seam exists for callers to bypass the invariant.
 */
export const withRetryLimits = (
  dag: DagDef,
  limits: Readonly<Record<string, number>>,
): Result<DagDef, FrameworkError> => validateDagShape({
  id: dag.id,
  nodes: recordFromNodeArray(dag.nodes),
  edges: dag.edges,
  ...(dag.outputNodeId !== undefined ? { outputNodeId: dag.outputNodeId } : {}),
  ...(dag.evalJudges !== undefined ? { evalJudges: dag.evalJudges } : {}),
  retryLimits: { ...(dag.retryLimits ?? {}), ...limits },
  ...(dag.defaultRetryLimit !== undefined
    ? { defaultRetryLimit: dag.defaultRetryLimit }
    : {}),
}, dag.provenance);
