// Example: multi-source join — N parallel root fetches → keyed fan-in → assemble.
//
// This is the most common real-world shape and the one with NO dedicated shape
// helper today: several independent sources are fetched in parallel, a `score`
// node fans them in (an object keyed by source id), and an `assemble` node
// applies the request. It falls back to raw `defineDag`.
//
// Two parts are durable and worth copying:
//   * the keyed fan-in schemas (`z.object({ "fetch-accounts": …, … })`) whose
//     keys are EXACTLY the incoming node ids — `fugue lint` checks this;
//   * `frameworkError.*` for errors, never raw `err({ kind, … })` literals.
//
// Two parts are TRANSITIONAL — framework 0.2.0 deletes them (flagged inline):
//   * `read-request` is a pass-through root that exists only to carry the DAG
//     input past wave 1 to `assemble`. 0.2.0 replaces it with a `$input` edge
//     (`{ from: DAG_INPUT, to: "assemble" }`) and deletes the node.
//   * the shared fetch roots declare `inputSchema: z.unknown()` because every
//     root implicitly receives the DAG input even when it ignores it. 0.2.0
//     makes roots *source nodes* — `createFetchNode` with no `inputSchema`.

import {
  z,
} from "zod";
import {
  createFetchNode,
  createTransformNode,
  defineDag,
  err,
  frameworkError,
  ok,
} from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

const RequestSchema = z.object({ region: z.string(), minScore: z.number() });

// --- parallel root fetches (each ignores the DAG input → z.unknown, transitional) ---

const AccountsSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), region: z.string() })),
});
const fetchAccounts = createFetchNode({
  id: "fetch-accounts",
  inputSchema: z.unknown(), // transitional: 0.2.0 source nodes drop inputSchema
  outputSchema: AccountsSchema,
  fetch: async () =>
    ok({ accounts: [{ id: "a1", region: "dk" }, { id: "a2", region: "se" }] }),
});

const UsageSchema = z.object({ usage: z.record(z.string(), z.number()) });
const fetchUsage = createFetchNode({
  id: "fetch-usage",
  inputSchema: z.unknown(),
  outputSchema: UsageSchema,
  fetch: async () => ok({ usage: { a1: 12, a2: 3 } }),
});

const WeightsSchema = z.object({ weights: z.object({ usage: z.number() }) });
const fetchWeights = createFetchNode({
  id: "fetch-weights",
  inputSchema: z.unknown(),
  outputSchema: WeightsSchema,
  fetch: async () => ok({ weights: { usage: 2 } }),
});

// --- pass-through root carrying the request to the assembler (transitional) ---
// 0.2.0: delete this node and wire `{ from: DAG_INPUT, to: "assemble" }`.
const readRequest = createTransformNode({
  id: "read-request",
  inputSchema: RequestSchema,
  outputSchema: RequestSchema,
  transform: (req) => ok(req),
});

// --- join: fan-in keyed by the THREE source node ids ---
const ScoreFanIn = z.object({
  "fetch-accounts": AccountsSchema,
  "fetch-usage": UsageSchema,
  "fetch-weights": WeightsSchema,
});
const ScoredSchema = z.object({
  scored: z.array(z.object({ id: z.string(), region: z.string(), score: z.number() })),
});
const score = createTransformNode({
  id: "score",
  inputSchema: ScoreFanIn,
  outputSchema: ScoredSchema,
  transform: (input) => {
    const { weights } = input["fetch-weights"];
    const { usage } = input["fetch-usage"];
    // Deterministic bad-config failure — built with a factory, not a literal.
    if (weights.usage <= 0) {
      return err(
        frameworkError.validation("score", "usage weight must be positive", "weights.usage"),
      );
    }
    const scored = input["fetch-accounts"].accounts.map((a) => ({
      id: a.id,
      region: a.region,
      score: (usage[a.id] ?? 0) * weights.usage,
    }));
    return ok({ scored });
  },
});

// --- assemble: fan-in keyed by the join + the request pass-through ---
const AssembleFanIn = z.object({
  score: ScoredSchema,
  "read-request": RequestSchema,
});
const assemble = createTransformNode({
  id: "assemble",
  inputSchema: AssembleFanIn,
  outputSchema: ScoredSchema,
  transform: (input) => {
    const { region, minScore } = input["read-request"];
    const scored = input.score.scored.filter(
      (s) => s.region === region && s.score >= minScore,
    );
    return ok({ scored });
  },
});

const dag = defineDag({
  id: "multi-source-join",
  nodes: {
    "fetch-accounts": fetchAccounts,
    "fetch-usage": fetchUsage,
    "fetch-weights": fetchWeights,
    "read-request": readRequest,
    score,
    assemble,
  },
  edges: [
    { from: "fetch-accounts", to: "score" },
    { from: "fetch-usage", to: "score" },
    { from: "fetch-weights", to: "score" },
    { from: "score", to: "assemble" },
    { from: "read-request", to: "assemble" },
  ],
  outputNodeId: "assemble",
});

const registration: DagRegistration = {
  dag,
  inputSchema: RequestSchema,
  meta: {
    description:
      "Multi-source join: parallel root fetches → keyed fan-in → assemble. " +
      "Current idiom; framework 0.2.0 replaces the pass-through root with a $input edge.",
    version: "1.0.0",
  },
};

export default registration;
