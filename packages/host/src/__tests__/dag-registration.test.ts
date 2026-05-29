import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { DagDef } from "@fugue/framework";
import {
  DagRegistrationSchema,
  validateDagRegistration,
  resolveDefaults,
  applyFugueYaml,
  missingEnvVars,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
  type DagRegistration,
} from "../domain/dag-registration.js";
import type { FugueYaml } from "../domain/config.js";

// ---------------------------------------------------------------------------
// Test helpers — structurally valid DagDef-like object
//
// DagRegistrationSchema checks: id (string), nodes (array), edges (array).
// We don't need a fully branded DagDef for schema validation tests —
// the brand is a compile-time-only artifact. We cast to DagDef for
// resolveDefaults which needs the typed interface.
// ---------------------------------------------------------------------------

const makeFakeDag = (id = "test-dag"): DagDef =>
  ({
    id,
    nodes: [
      { id: "start", kind: "transform", execute: async () => ({ result: "ok" }) },
      { id: "end", kind: "transform", execute: async () => ({ done: true }) },
    ],
    edges: [{ from: "start", to: "end", kind: "unconditional" }],
  }) as unknown as DagDef;

const testInputSchema = z.object({ query: z.string() });

const validRegistration = (): DagRegistration => ({
  dag: makeFakeDag(),
  inputSchema: testInputSchema,
});

// ---------------------------------------------------------------------------
// DagRegistrationSchema — Zod runtime validation
// ---------------------------------------------------------------------------

describe("DagRegistrationSchema", () => {
  test("valid registration passes schema validation", () => {
    const reg = validRegistration();
    const result = DagRegistrationSchema.safeParse(reg);
    expect(result.success).toBe(true);
  });

  test("valid registration with all optional fields passes", () => {
    const reg = {
      ...validRegistration(),
      route: "/custom/run",
      config: { timeoutMs: 60_000, maxConcurrent: 5 },
      meta: { description: "Test DAG", version: "1.2.3" },
    };
    const result = DagRegistrationSchema.safeParse(reg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.route).toBe("/custom/run");
      expect(result.data.config?.timeoutMs).toBe(60_000);
      expect(result.data.config?.maxConcurrent).toBe(5);
      expect(result.data.meta?.description).toBe("Test DAG");
      expect(result.data.meta?.version).toBe("1.2.3");
    }
  });

  test("missing dag field fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("missing inputSchema field fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: makeFakeDag(),
    });
    expect(result.success).toBe(false);
  });

  test("dag without id fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: { nodes: [], edges: [] },
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("dag with a colon-bearing id fails validation (brand is earned, not manufactured)", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: makeFakeDag("tenant:dag"),
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "dag.id");
      expect(issue).toBeDefined();
    }
  });

  test("validateDagRegistration rejects a colon-bearing id at the contract boundary", () => {
    const res = validateDagRegistration({
      dag: makeFakeDag("a:b"),
      inputSchema: testInputSchema,
    });
    expect(res.ok).toBe(false);
  });

  test("dag with an over-long id fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: makeFakeDag("x".repeat(129)),
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("dag without nodes fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: { id: "x", edges: [] },
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("dag without edges fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: { id: "x", nodes: [] },
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("dag with non-array nodes fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: { id: "x", nodes: "not-array", edges: [] },
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("dag with non-array edges fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: { id: "x", nodes: [], edges: "not-array" },
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("inputSchema without .parse method fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: makeFakeDag(),
      inputSchema: { notASchema: true },
    });
    expect(result.success).toBe(false);
  });

  test("null dag fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: null,
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("null inputSchema fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: makeFakeDag(),
      inputSchema: null,
    });
    expect(result.success).toBe(false);
  });

  test("config with non-positive timeoutMs fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      ...validRegistration(),
      config: { timeoutMs: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("config with negative maxConcurrent fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      ...validRegistration(),
      config: { maxConcurrent: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("config with fractional maxConcurrent fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      ...validRegistration(),
      config: { maxConcurrent: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  test("route override with custom string passes", () => {
    const result = DagRegistrationSchema.safeParse({
      ...validRegistration(),
      route: "/api/v2/summarize",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.route).toBe("/api/v2/summarize");
    }
  });

  test("config with valid timeoutMs and maxConcurrent passes", () => {
    const result = DagRegistrationSchema.safeParse({
      ...validRegistration(),
      config: { timeoutMs: 120_000, maxConcurrent: 20 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config?.timeoutMs).toBe(120_000);
      expect(result.data.config?.maxConcurrent).toBe(20);
    }
  });

  test("dag with numeric id fails validation", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: { id: 123, nodes: [], edges: [] },
      inputSchema: testInputSchema,
    });
    expect(result.success).toBe(false);
  });

  test("inputSchema with object that has parse as non-function fails", () => {
    const result = DagRegistrationSchema.safeParse({
      dag: makeFakeDag(),
      inputSchema: { parse: "not-a-function" },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateDagRegistration — Result-returning helper
// ---------------------------------------------------------------------------

describe("validateDagRegistration", () => {
  test("valid registration returns Ok", () => {
    const result = validateDagRegistration(validRegistration());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value.dag as unknown as { id: string }).id).toBe("test-dag");
    }
  });

  test("valid registration with optional fields returns Ok", () => {
    const result = validateDagRegistration({
      ...validRegistration(),
      route: "/api/custom",
      config: { timeoutMs: 5000, maxConcurrent: 2 },
      meta: { description: "A dag", version: "2.0.0" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.route).toBe("/api/custom");
      expect(result.value.config?.timeoutMs).toBe(5000);
      expect(result.value.config?.maxConcurrent).toBe(2);
      expect(result.value.meta?.description).toBe("A dag");
      expect(result.value.meta?.version).toBe("2.0.0");
    }
  });

  test("missing dag returns Err with dag-validation-failed kind", () => {
    const result = validateDagRegistration({ inputSchema: testInputSchema });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("dag-validation-failed");
    }
  });

  test("missing inputSchema returns Err with dag-validation-failed kind", () => {
    const result = validateDagRegistration({ dag: makeFakeDag() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("dag-validation-failed");
    }
  });

  test("missing dag.id produces error with dagId 'unknown'", () => {
    const result = validateDagRegistration({
      dag: { nodes: [], edges: [] },
      inputSchema: testInputSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "dag-validation-failed") {
      expect(result.error.dagId as string).toBe("unknown");
    }
  });

  test("completely invalid value (null) returns Err", () => {
    const result = validateDagRegistration(null);
    expect(result.ok).toBe(false);
  });

  test("undefined returns Err", () => {
    const result = validateDagRegistration(undefined);
    expect(result.ok).toBe(false);
  });

  test("error message includes field path information", () => {
    const result = validateDagRegistration({ dag: "not-a-dag", inputSchema: testInputSchema });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "dag-validation-failed") {
      expect(result.error.reason).toContain("dag");
      expect(result.error.message).toContain("DagRegistration validation failed");
    }
  });

  test("extracts dagId from partially valid registration", () => {
    const result = validateDagRegistration({
      dag: { id: "my-dag", nodes: "invalid", edges: [] },
      inputSchema: testInputSchema,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "dag-validation-failed") {
      expect(result.error.dagId as string).toBe("my-dag");
    }
  });

  test("number value returns Err", () => {
    const result = validateDagRegistration(42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("dag-validation-failed");
    }
  });

  test("empty object returns Err", () => {
    const result = validateDagRegistration({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("dag-validation-failed");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveDefaults — FR-013 sensible defaults
// ---------------------------------------------------------------------------

describe("resolveDefaults", () => {
  test("applies default route from dag.id when route omitted", () => {
    const reg = validRegistration();
    const resolved = resolveDefaults(reg);
    expect(resolved.route).toBe("/dags/test-dag/run");
  });

  test("preserves custom route when provided", () => {
    const reg = { ...validRegistration(), route: "/custom/endpoint" };
    const resolved = resolveDefaults(reg);
    expect(resolved.route).toBe("/custom/endpoint");
  });

  test("applies default timeoutMs when config omitted", () => {
    const resolved = resolveDefaults(validRegistration());
    expect(resolved.config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  test("applies default maxConcurrent when config omitted", () => {
    const resolved = resolveDefaults(validRegistration());
    expect(resolved.config.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
  });

  test("preserves custom timeoutMs when provided", () => {
    const reg = { ...validRegistration(), config: { timeoutMs: 60_000 } };
    const resolved = resolveDefaults(reg);
    expect(resolved.config.timeoutMs).toBe(60_000);
  });

  test("preserves custom maxConcurrent when provided", () => {
    const reg = { ...validRegistration(), config: { maxConcurrent: 3 } };
    const resolved = resolveDefaults(reg);
    expect(resolved.config.maxConcurrent).toBe(3);
  });

  test("applies default meta when omitted", () => {
    const resolved = resolveDefaults(validRegistration());
    expect(resolved.meta.description).toBe("");
    expect(resolved.meta.version).toBe("0.0.0");
  });

  test("preserves custom meta when provided", () => {
    const reg = {
      ...validRegistration(),
      meta: { description: "My DAG", version: "1.0.0" },
    };
    const resolved = resolveDefaults(reg);
    expect(resolved.meta.description).toBe("My DAG");
    expect(resolved.meta.version).toBe("1.0.0");
  });

  test("partial config fills missing fields with defaults", () => {
    const reg = { ...validRegistration(), config: { timeoutMs: 15_000 } };
    const resolved = resolveDefaults(reg);
    expect(resolved.config.timeoutMs).toBe(15_000);
    expect(resolved.config.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
  });

  test("partial meta fills missing fields with defaults", () => {
    const reg = { ...validRegistration(), meta: { description: "Hello" } };
    const resolved = resolveDefaults(reg);
    expect(resolved.meta.description).toBe("Hello");
    expect(resolved.meta.version).toBe("0.0.0");
  });

  test("dag reference is preserved (same object)", () => {
    const reg = validRegistration();
    const resolved = resolveDefaults(reg);
    expect(resolved.dag).toBe(reg.dag);
  });

  test("inputSchema reference is preserved (same object)", () => {
    const reg = validRegistration();
    const resolved = resolveDefaults(reg);
    expect(resolved.inputSchema).toBe(reg.inputSchema);
  });

  test("different dag ids produce different default routes", () => {
    const reg1 = { ...validRegistration(), dag: makeFakeDag("alpha") };
    const reg2 = { ...validRegistration(), dag: makeFakeDag("beta") };
    expect(resolveDefaults(reg1).route).toBe("/dags/alpha/run");
    expect(resolveDefaults(reg2).route).toBe("/dags/beta/run");
  });
});

describe("applyFugueYaml (pure merge)", () => {
  const yaml = (over: Partial<FugueYaml> = {}): FugueYaml => ({ team: "cx", env: [], ...over });

  test("fugue.yaml fields override dag.ts config; omitted fields are preserved", () => {
    const reg: DagRegistration = {
      ...validRegistration(),
      route: "/from-dag",
      config: { timeoutMs: 30_000, maxConcurrent: 2, circuitBreaker: { failureThreshold: 9 } },
    };
    const merged = applyFugueYaml(reg, yaml({ route: "/from-yaml", timeoutMs: 90_000, cacheTtlMs: 600_000 }));
    expect(merged.route).toBe("/from-yaml");          // yaml wins
    expect(merged.config?.timeoutMs).toBe(90_000);    // yaml wins
    expect(merged.config?.maxConcurrent).toBe(2);     // preserved from dag.ts
    expect(merged.config?.cacheTtlMs).toBe(600_000);  // yaml-only field added
    expect(merged.config?.circuitBreaker).toEqual({ failureThreshold: 9 }); // not mergeable from yaml → preserved
  });

  test("omitted route falls back to the dag.ts route", () => {
    const reg = { ...validRegistration(), route: "/keep" };
    expect(applyFugueYaml(reg, yaml()).route).toBe("/keep");
  });
});

describe("missingEnvVars (pure fail-closed policy)", () => {
  test("returns names absent or empty in env", () => {
    expect(missingEnvVars(["A", "B", "C"], { A: "x", B: "" })).toEqual(["B", "C"]);
  });
  test("returns empty when all present", () => {
    expect(missingEnvVars(["A"], { A: "x" })).toEqual([]);
  });
  test("empty requirement list is always satisfied", () => {
    expect(missingEnvVars([], {})).toEqual([]);
  });
});
