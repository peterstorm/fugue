// CLI result types — stable JSON shapes consumed by both human readers and
// machine harnesses (LLM authoring tools). These are intentionally simple
// discriminated unions so callers can pattern-match on `ok` and either
// proceed or surface the structured `errors` payload.

import type { FrameworkError } from "../types/errors.js";
import type {
  DescribedDag,
  DescribedNode,
  DescribedEdge,
} from "../describe/index.js";
import type { Shape } from "./new-templates.js";

// Re-export the shared describe shapes so existing CLI consumers keep their
// import path. The canonical home is `@fuguejs/framework`'s `describe` module —
// the host's `GET /dags/:id/manifest` handler imports from there directly.
export type { DescribedDag, DescribedNode, DescribedEdge };

/**
 * Lint outcome: either the DAG file imports cleanly and validates, or one or
 * more errors were captured. The error payload is always an array even when
 * exactly one error fires, so consumers don't branch on cardinality.
 */
export type LintResult =
  | {
      readonly ok: true;
      readonly path: string;
      /** Non-fatal hints (e.g. a manual DAG that matches a shape helper). */
      readonly advisories?: readonly LintAdvisory[];
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly errors: readonly LintError[];
      readonly advisories?: readonly LintAdvisory[];
    };

/**
 * Non-fatal lint hint. Advisories never set `ok: false` — they nudge the author
 * toward a better shape without blocking. Stable JSON shape for LLM tooling.
 */
export type LintAdvisory =
  | {
      readonly kind: "shape-helper-hint";
      readonly message: string;
      /** The constructor the manual DAG is isomorphic to. */
      readonly helper:
        | "defineLinearDag"
        | "defineFanOut"
        | "defineDiamond"
        | "defineRouter"
        | "defineSources";
    }
  | {
      /**
       * B2 (advisory): a transform node whose input and output schemas are the
       * SAME reference (a pass-through / identity-shaped transform). Pre-0.2.0
       * this was the `read-request` idiom — a node existing only to carry the
       * DAG request past wave 1. The fix is a `DAG_INPUT` edge straight to the
       * consumer; the pass-through node can then be deleted.
       */
      readonly kind: "redundant-passthrough";
      readonly message: string;
      readonly nodeId: string;
    };

/**
 * Discriminated lint error. `kind` is a stable string that machine consumers
 * can switch on; the `dagId` is present when the failure was inside a
 * `defineDag` call (the validator surfaces it on `DagDefinitionError`).
 */
export type LintError =
  | {
      readonly kind: "import-failed";
      readonly message: string;
      readonly stack?: string;
    }
  | {
      readonly kind: "no-default-export";
      readonly message: string;
    }
  | {
      readonly kind: "missing-dag-field";
      readonly message: string;
    }
  | {
      readonly kind: "dag-definition-error";
      readonly dagId: string;
      readonly message: string;
      readonly detail: FrameworkError;
    }
  | {
      /**
       * Surfaced when describe assembles a topologically-invalid registered
       * DAG. The validator should have caught this earlier; reaching this
       * branch indicates a framework invariant violation, not authoring
       * error.
       */
      readonly kind: "describe-failed";
      readonly message: string;
      readonly detail: FrameworkError;
    }
  | {
      /**
       * A fan-in node (≥2 incoming edges, or a conditional/default source) has
       * a `z.object` input schema whose keys don't equal the set of incoming
       * node ids. The runtime builds that node's input as an object keyed by
       * source id, so a missing or typo'd key fails at runtime — this catches
       * it at lint time, the single most likely DAG wiring mistake.
       */
      readonly kind: "fan-in-key-mismatch";
      readonly nodeId: string;
      readonly message: string;
      /** Incoming source ids with no matching schema key. */
      readonly missingKeys: readonly string[];
      /** Schema keys with no matching incoming source. */
      readonly extraKeys: readonly string[];
    };

/**
 * One entry in the built-in capability catalogue emitted by `fugue
 * capabilities`. Stable JSON shape: `name` is what goes in a node's
 * `requires`, `clientType` names the value injected into `ctx[name]`.
 */
export interface CapabilityCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly clientType: string;
  readonly reference: string;
}

/**
 * Outcome of `fugue capabilities`: the framework's built-in capability
 * catalogue plus the mechanism for obtaining custom (adapter-provided) ones.
 *
 * Always `ok: true` — the catalogue is static framework data with no failure
 * mode — but the field is kept so machine consumers branch on `ok` uniformly
 * across all three CLI commands.
 *
 * `builtin` lists capabilities the framework ships. Adapter-provided
 * capabilities (e.g. `documents`, `db`) are deployment-specific: they exist
 * only when the host wires the corresponding `CapabilityHandle`, so they are
 * described via `custom` rather than enumerated here. Use `fugue describe
 * <dag>` to see which capabilities a *specific* DAG requires.
 */
export interface CapabilitiesResult {
  readonly ok: true;
  readonly builtin: readonly CapabilityCatalogEntry[];
  readonly custom: {
    readonly mechanism: string;
    readonly howToDeclare: string;
    readonly discover: string;
    readonly seeAlso: readonly string[];
  };
}

/**
 * `fugue new` outcome: either the scaffold was written (with the file list and
 * next steps), or the request was rejected (bad args, or a non-empty target dir
 * without --force). Stable JSON shape for LLM tooling.
 */
export type NewResult =
  | {
      readonly ok: true;
      /** Absolute path of the generated DAG directory. */
      readonly dir: string;
      readonly shape: Shape;
      readonly team: string;
      readonly name: string;
      readonly llm: boolean;
      /** Files written, relative to the root that contains `dags/`. */
      readonly files: readonly string[];
      /** Ordered, copy-pasteable follow-up commands for the author. */
      readonly nextSteps: readonly string[];
    }
  | {
      readonly ok: false;
      readonly problems: readonly string[];
    };

/**
 * Describe outcome: a structured summary of a valid DAG file. Always wraps
 * a lint pass — a file that fails to lint also fails to describe, surfacing
 * the same `LintError` array.
 */
export type DescribeResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly dag: DescribedDag;
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly errors: readonly LintError[];
    };
