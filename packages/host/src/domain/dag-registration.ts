/**
 * DagRegistration — the contract type that DAG authors export from dag.ts.
 *
 * Wraps a validated DagDef with:
 * - inputSchema: Zod schema validating HTTP payloads before execution
 * - route: optional custom route override (defaults to `/dags/${dag.id}/run`)
 * - config: optional per-DAG runtime config (timeout, concurrency)
 * - meta: optional description and version
 *
 * The host dynamically imports DAG modules and validates the export shape
 * at runtime using DagRegistrationSchema before registering.
 */

import type { DagDef } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import { ok, err, dagId as makeDagId } from "@fugue/framework";
import type { DagId } from "@fugue/framework";
import { z } from "zod";
import type { HostError } from "./host-error.js";

// ---------------------------------------------------------------------------
// Config defaults — FR-013: sensible defaults when omitted
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CONCURRENT = 10;

// ---------------------------------------------------------------------------
// DagRegistration interface — FR-010, FR-011, FR-012
// ---------------------------------------------------------------------------

export interface DagRegistrationConfig {
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

export interface DagRegistrationMeta {
  readonly description?: string;
  readonly version?: string;
}

export interface DagRegistration {
  readonly dag: DagDef;
  readonly inputSchema: z.ZodType<unknown>;
  readonly route?: string;
  readonly config?: DagRegistrationConfig;
  readonly meta?: DagRegistrationMeta;
}

// ---------------------------------------------------------------------------
// Resolved registration — all optionals filled with defaults
// ---------------------------------------------------------------------------

export interface ResolvedDagRegistration {
  readonly dag: DagDef;
  readonly inputSchema: z.ZodType<unknown>;
  readonly route: string;
  readonly config: {
    readonly timeoutMs: number;
    readonly maxConcurrent: number;
  };
  readonly meta: {
    readonly description: string;
    readonly version: string;
  };
}

/**
 * Apply sensible defaults to all optional fields (FR-013).
 */
export const resolveDefaults = (reg: DagRegistration): ResolvedDagRegistration => ({
  dag: reg.dag,
  inputSchema: reg.inputSchema,
  route: reg.route ?? `/dags/${reg.dag.id}/run`,
  config: {
    timeoutMs: reg.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxConcurrent: reg.config?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  },
  meta: {
    description: reg.meta?.description ?? "",
    version: reg.meta?.version ?? "0.0.0",
  },
});

// ---------------------------------------------------------------------------
// Zod runtime schema — validates dynamically imported module exports
// ---------------------------------------------------------------------------

/**
 * Runtime validation schema for DagRegistration.
 *
 * Uses z.custom for DagDef and inputSchema because:
 * - DagDef is branded and validated at construction time by defineDag()
 * - inputSchema is any Zod schema instance (has .parse method)
 *
 * We check structural shape (id, nodes, edges present) without requiring
 * the brand — the brand is a TS compile-time artifact.
 */
export const DagRegistrationSchema = z.object({
  dag: z.custom<DagDef>(
    (v): v is DagDef =>
      v != null &&
      typeof v === "object" &&
      "id" in v &&
      typeof (v as Record<string, unknown>).id === "string" &&
      "nodes" in v &&
      Array.isArray((v as Record<string, unknown>).nodes) &&
      "edges" in v &&
      Array.isArray((v as Record<string, unknown>).edges),
    { message: "dag must be a valid DagDef with id (string), nodes (array), and edges (array)" },
  ),
  inputSchema: z.custom<z.ZodType<unknown>>(
    (v): v is z.ZodType<unknown> =>
      v != null &&
      typeof v === "object" &&
      "parse" in v &&
      typeof (v as Record<string, unknown>).parse === "function",
    { message: "inputSchema must be a Zod schema (object with .parse method)" },
  ),
  route: z.string().optional(),
  config: z
    .object({
      timeoutMs: z.number().positive().optional(),
      maxConcurrent: z.number().int().positive().optional(),
    })
    .optional(),
  meta: z
    .object({
      description: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Validate helper — returns Result<DagRegistration, HostError>
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as a DagRegistration.
 * Used by the module loader after dynamic import to ensure the export
 * conforms to the contract before registering.
 */
export const validateDagRegistration = (
  value: unknown,
): Result<DagRegistration, HostError> => {
  const result = DagRegistrationSchema.safeParse(value);
  if (!result.success) {
    const id = extractDagId(value) as DagId;
    return err({
      kind: "dag-validation-failed",
      dagId: id,
      reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      message: `DagRegistration validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  }
  return ok(result.data as DagRegistration);
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const extractDagId = (value: unknown): string => {
  if (value != null && typeof value === "object" && "dag" in value) {
    const dag = (value as Record<string, unknown>).dag;
    if (dag != null && typeof dag === "object" && "id" in dag) {
      const id = (dag as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
  }
  return "<unknown>";
};
