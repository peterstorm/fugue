/**
 * The per-run LLM budget as an operator DECLARES it, and its translation into
 * the framework's `Ceilings`.
 *
 * Functional core: a schema and one pure translation, no I/O. This is the
 * anti-corruption layer between two vocabularies that are deliberately not the
 * same shape:
 *
 * - **Config speaks in what an operator writes**: optional axes, dollars as a
 *   decimal, and a legacy `llmBudgetTokens` scalar that shipped before the
 *   block existed.
 * - **The domain speaks in `Ceilings`**: non-empty, one limit per axis,
 *   canonically ordered, dollars as integer micro-USD.
 *
 * Keeping the declaration shape in ONE module matters because it is referenced
 * from four places along the registration chain (fugue.yaml, the dag.ts
 * registration schema, the resolved registration, the resolved DAG config). Four
 * hand-copied structural declarations is how an axis added later reaches three
 * of them.
 */

import { z } from "zod";
import type { Ceiling, Ceilings } from "@fuguejs/framework";
import { ceilings, usdToMicros } from "@fuguejs/framework";

/**
 * Per-run LLM budget, on any combination of axes (FR-B-001). A run is refused
 * when ANY declared axis is reached.
 *
 * `usd` is the axis that means what an operator actually meant, and since
 * prompt caching it is the only one that tracks money: a cache read bills at
 * 0.1x of the input rate and a write at 1.25-2.0x, so two runs with equal token
 * counts can differ by an order of magnitude in spend. `calls` is the cheapest
 * circuit-breaker for a tool loop stuck retrying — it catches immediately what
 * a token ceiling only catches expensively.
 */
export interface LlmBudgetConfig {
  readonly tokens?: number;
  /** Whole US dollars as a decimal (e.g. `2.50`); stored internally as integer micro-USD. */
  readonly usd?: number;
  readonly calls?: number;
}

/**
 * An empty block is REJECTED rather than read as "no budget". Writing
 * `llmBudget: {}` expresses an intent to limit something, and honouring it as
 * unlimited would be the most expensive possible misreading of an operator's
 * intent. Absence — omitting the key — is how "no budget" is spelled.
 */
export const LlmBudgetConfigSchema = z
  .object({
    tokens: z.number().int().positive().optional(),
    usd: z.number().positive().optional(),
    calls: z.number().int().positive().optional(),
  })
  .refine((b) => b.tokens !== undefined || b.usd !== undefined || b.calls !== undefined, {
    message: "llmBudget must declare at least one of tokens, usd, calls",
  });

/**
 * The two config surfaces a run's ceilings can be declared on.
 *
 * Every layer of the registration chain that carries a budget declaration
 * EXTENDS this interface rather than restating its fields, and both Zod schemas
 * merge `LlmBudgetDeclarationSchema` below. That is what makes the one-module
 * claim in this file's header real rather than aspirational: adding an axis
 * here becomes a compile error at any layer not updated with it, instead of a
 * field that silently reaches three of the five surfaces.
 */
export interface LlmBudgetDeclaration {
  /**
   * Legacy scalar (FR-W1-001), shipped in v0.5.1 and still honoured. Sugar for
   * `llmBudget: { tokens: N }` — it normalises into the same `Ceilings` value
   * below rather than following a second enforcement path.
   */
  readonly llmBudgetTokens?: number;
  readonly llmBudget?: LlmBudgetConfig;
}

/**
 * Translate a declaration into the ceilings the meter enforces, or `undefined`
 * when nothing is declared (FR-W1-006: no budget, no enforcement).
 *
 * Declaring both `llmBudgetTokens` and `llmBudget.tokens` is legal and takes the
 * TIGHTER of the two. That is not a special case written here — `ceilings`
 * collapses duplicate axes to their minimum, which is the same operation that
 * makes a caller-supplied ceiling incapable of relaxing a DAG's (FR-B-009). One
 * rule, applied wherever two declarations meet.
 */
export const ceilingsOf = (declared: LlmBudgetDeclaration): Ceilings | undefined => {
  const axes: Ceiling[] = [];
  if (declared.llmBudgetTokens !== undefined) {
    axes.push({ kind: "tokens", limit: declared.llmBudgetTokens });
  }
  const budget = declared.llmBudget;
  if (budget?.tokens !== undefined) axes.push({ kind: "tokens", limit: budget.tokens });
  if (budget?.calls !== undefined) axes.push({ kind: "calls", limit: budget.calls });
  if (budget?.usd !== undefined) axes.push({ kind: "usd", limit: usdToMicros(budget.usd) });
  return ceilings(axes);
};

/**
 * Carry a budget declaration from one config layer to the next, omitting the
 * keys the source did not set.
 *
 * The three merge points on the registration chain (`applyFugueYaml`,
 * `resolveDefaults`, and the resolved-config build in `dag-factory`) each
 * hand-listed the same conditional spreads. Absence has to stay absence rather
 * than becoming an explicit `undefined` — `exactOptionalPropertyTypes` aside,
 * a present-but-undefined key would make "declared no budget" and "declared a
 * budget of nothing" different values of the same shape. One carrier means a
 * field added to `LlmBudgetDeclaration` reaches all three sites at once instead
 * of two of them.
 */
export const carryLlmBudget = (source: LlmBudgetDeclaration): LlmBudgetDeclaration => ({
  ...(source.llmBudgetTokens !== undefined ? { llmBudgetTokens: source.llmBudgetTokens } : {}),
  ...(source.llmBudget !== undefined ? { llmBudget: source.llmBudget } : {}),
});

/**
 * The declaration pair as a Zod object, for the config surfaces that parse it.
 *
 * Merged into `FugueYamlSchema` and the `DagRegistrationSchema` config
 * sub-schema rather than re-typed in each, so the wire shape cannot drift from
 * the TS shape or from `LlmBudgetDeclaration`.
 */
export const LlmBudgetDeclarationSchema = z.object({
  llmBudgetTokens: z.number().int().positive().optional(),
  llmBudget: LlmBudgetConfigSchema.optional(),
});
