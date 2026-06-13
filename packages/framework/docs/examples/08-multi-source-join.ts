// Example: multi-source join — N parallel source fetches → keyed fan-in →
// assemble — built with the `defineSources` constructor (the 0.2.0 shape for
// the most common real-world topology, and the one this monorepo's production
// DAGs use).
//
// Three things are durable and worth copying:
//   * the parallel roots are SOURCE NODES (`createSourceNode`, no `inputSchema`):
//     a source produces from the context alone and consumes no DAG input;
//   * the keyed fan-in schemas (`z.object({ "fetch-accounts": …, … })`) whose
//     keys are EXACTLY the incoming node ids — `fugue lint` checks this;
//   * the request reaches `assemble` via a `DAG_INPUT` edge, declared as the
//     `"$input"` key in its fan-in schema. `defineSources` wires that edge
//     automatically because the schema declares the key — no pass-through node.
//
// `frameworkError.*` is used for errors, never raw `err({ kind, … })` literals.

import { z } from "zod";
import {
  createSourceNode,
  createTransformNode,
  defineSources,
  err,
  frameworkError,
  ok,
} from "@fuguejs/framework";
import type { DagRegistration } from "@fuguejs/host/contract";

const RequestSchema = z.object({ region: z.string(), minScore: z.number() });

// --- parallel root SOURCE nodes (no inputSchema → fetch is (ctx) => …) ---

const AccountsSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), region: z.string() })),
});
const fetchAccounts = createSourceNode({
  id: "fetch-accounts",
  outputSchema: AccountsSchema,
  fetch: async () =>
    ok({ accounts: [{ id: "a1", region: "dk" }, { id: "a2", region: "se" }] }),
});

const UsageSchema = z.object({ usage: z.record(z.string(), z.number()) });
const fetchUsage = createSourceNode({
  id: "fetch-usage",
  outputSchema: UsageSchema,
  fetch: async () => ok({ usage: { a1: 12, a2: 3 } }),
});

const WeightsSchema = z.object({ weights: z.object({ usage: z.number() }) });
const fetchWeights = createSourceNode({
  id: "fetch-weights",
  outputSchema: WeightsSchema,
  fetch: async () => ok({ weights: { usage: 2 } }),
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

// --- assemble: fan-in keyed by the join + the request via the "$input" slot ---
// Declaring "$input" here is what makes `defineSources` add the DAG_INPUT edge.
const AssembleFanIn = z.object({
  score: ScoredSchema,
  $input: RequestSchema,
});
const assemble = createTransformNode({
  id: "assemble",
  inputSchema: AssembleFanIn,
  outputSchema: ScoredSchema,
  transform: (input) => {
    const { region, minScore } = input.$input;
    const scored = input.score.scored.filter(
      (s) => s.region === region && s.score >= minScore,
    );
    return ok({ scored });
  },
});

const dag = defineSources({
  id: "multi-source-join",
  sources: [fetchAccounts, fetchUsage, fetchWeights],
  join: score,
  assemble,
});

const registration: DagRegistration = {
  dag,
  inputSchema: RequestSchema,
  meta: {
    description:
      "Multi-source join: parallel source fetches → keyed fan-in → assemble, " +
      "via defineSources. The request reaches assemble over a $input edge.",
    version: "1.0.0",
  },
};

export default registration;
