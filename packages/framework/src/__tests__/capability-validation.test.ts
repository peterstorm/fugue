/**
 * Unit tests for `validateCapabilities`.
 *
 * Validates:
 * - All capabilities present → Ok with ValidatedNodeContext
 * - Single missing capability → Err with that capability
 * - Multiple missing capabilities → Err listing all
 * - Empty requires (pure transforms) → always Ok
 * - Capability present but null → treated as missing
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { N, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import type { NodeDef, BaseNodeContext, Capability } from "../types/node.js";
import type { LlmClient } from "../types/llm.js";
import type { FrameworkError } from "../types/errors.js";
import { isOk, isErr } from "../types/result.js";
import { NoopObserver } from "../observer/observer.js";

const noop = async () => ({ ok: true as const, value: undefined });
const noopTracer = { startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, isRecording: () => false }) } as any;

const makeNode = (id: string, requires: readonly Capability[]): NodeDef<unknown, unknown> => ({
  id: N(id),
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: requires as any,
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
});

const makeCtx = (overrides: Partial<BaseNodeContext> = {}): BaseNodeContext => ({
  runId: "r1" as any,
  dagId: "d1" as any,
  logger: { warn: () => {}, error: () => {} },
  tracer: noopTracer,
  observer: new NoopObserver(),
  cache: null,
  llm: null, http: null,
  prompts: null,
  judgeLlm: null,
  ...overrides,
});

const fakeLlm = {} as LlmClient;

describe("validateCapabilities", () => {
  it("empty requires → Ok", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", [])],
      edges: [],
    });
    const result = validateCapabilities(dag, makeCtx());
    expect(isOk(result)).toBe(true);
  });

  it("all required capabilities present → Ok", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["llm", "cache"])],
      edges: [],
    });
    const result = validateCapabilities(dag, makeCtx({
      llm: fakeLlm,
      cache: { get: async () => ({ hit: false }), set: async () => ({ ok: true, value: undefined } as any) },
    }));
    expect(isOk(result)).toBe(true);
  });

  it("single missing capability → Err with missing-capability kind", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["llm"])],
      edges: [],
    });
    const result = validateCapabilities(dag, makeCtx());
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-capability");
      if (result.error.kind === "missing-capability") {
        expect(result.error.capability).toBe("llm");
        expect(result.error.nodeId).toBe(N("a"));
        expect(result.error.missing).toHaveLength(1);
      }
    }
  });

  it("multiple missing capabilities across nodes → all surfaced", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [
        makeNode("a", ["llm"]),
        makeNode("b", ["cache", "prompts"]),
      ],
      edges: [],
    });
    const result = validateCapabilities(dag, makeCtx());
    expect(isErr(result)).toBe(true);
    if (!result.ok && result.error.kind === "missing-capability") {
      expect(result.error.missing).toHaveLength(3);
      const caps = result.error.missing.map(m => m.capability).sort();
      expect(caps).toEqual(["cache", "llm", "prompts"]);
    }
  });

  it("capability field present but null → treated as missing", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["llm"])],
      edges: [],
    });
    const result = validateCapabilities(dag, makeCtx({ llm: null }));
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-capability");
    }
  });

  it("a capability colliding with a reserved infra field is treated as missing (fail-closed)", () => {
    // A consumer could augment `CapabilityRegistry` with a name that shadows a
    // reserved infra field (e.g. `logger`). `makeNodeContext` refuses to wire
    // such a capability, so it can never be satisfied — but `ctx.logger` is
    // always present. Validation must NOT read the infra logger and pass; it
    // must report the capability as missing.
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["logger" as Capability])],
      edges: [],
    });
    // `makeCtx` always provides a non-null `logger` infra field.
    const result = validateCapabilities(dag, makeCtx());
    expect(isErr(result)).toBe(true);
    if (!result.ok && result.error.kind === "missing-capability") {
      expect(result.error.capability).toBe("logger" as Capability);
      expect(result.error.nodeId).toBe(N("a"));
    }
  });

  it("first miss is surfaced at top-level nodeId/capability fields", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [
        makeNode("a", ["llm"]),
        makeNode("b", ["cache"]),
      ],
      edges: [],
    });
    const result = validateCapabilities(dag, makeCtx());
    if (!result.ok && result.error.kind === "missing-capability") {
      // First miss should be node "a" / "llm" since nodes are iterated in order
      expect(result.error.nodeId).toBe(N("a"));
      expect(result.error.capability).toBe("llm");
    }
  });
});
