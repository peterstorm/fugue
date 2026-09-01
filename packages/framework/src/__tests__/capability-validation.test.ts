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
import * as fc from "fast-check";
import { z } from "zod";
import { N, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { makeNodeContext, mergeScopedCapabilities } from "../shared/make-node-context.js";
import { testNodeContext } from "./_context-factories.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { DAG_INPUT } from "../types/ids.js";
import type { NodeDef, BaseNodeContext, Capability } from "../types/node.js";
import { BUILTIN_CAPABILITY_KEYS, RESERVED_NON_CAPABILITY_KEYS } from "../types/node.js";
import type { LlmClient } from "../types/llm.js";
import type { CapabilityBroker, ScopedCapabilityHandle } from "../types/capability-broker.js";
import { isOk, isErr, ok } from "../types/result.js";

const noop = async () => ({ ok: true as const, value: undefined });

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

const makeCtx = (overrides: Partial<BaseNodeContext> = {}): BaseNodeContext =>
  testNodeContext({
    runId: "r1" as BaseNodeContext["runId"],
    dagId: "d1" as BaseNodeContext["dagId"],
    ...overrides,
  });

const fakeLlm = {} as LlmClient;

describe("validateCapabilities", () => {
  it("empty requires → Ok", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", [])],
      edges: [{ from: DAG_INPUT, to: "a" }],
    });
    const result = validateCapabilities(dag, makeCtx());
    expect(isOk(result)).toBe(true);
  });

  it("budget is the seventh built-in: missing fails and a read-only client satisfies it", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["budget"])],
      edges: [{ from: DAG_INPUT, to: "a" }],
    });
    expect(isErr(validateCapabilities(dag, makeCtx()))).toBe(true);
    expect(isOk(validateCapabilities(dag, makeCtx({
      budget: {
        spent: () => ({
          usage: "known",
          tokens: 0,
          calls: 0,
          usd: { kind: "priced", micros: 0 as never },
        }),
        remaining: () => ({ kind: "unbudgeted" }),
      },
    })))).toBe(true);
  });

  it("all required capabilities present → Ok", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["llm", "cache"])],
      edges: [{ from: DAG_INPUT, to: "a" }],
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
      edges: [{ from: DAG_INPUT, to: "a" }],
    });
    const result = validateCapabilities(dag, makeCtx());
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-capability");
      if (result.error.kind === "missing-capability") {
        expect(result.error.missing).toHaveLength(1);
        expect(result.error.missing[0].capability).toBe("llm");
        expect(result.error.missing[0].nodeId).toBe(N("a"));
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
      edges: [{ from: DAG_INPUT, to: "a" }, { from: DAG_INPUT, to: "b" }],
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
      edges: [{ from: DAG_INPUT, to: "a" }],
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
      edges: [{ from: DAG_INPUT, to: "a" }],
    });
    // `makeCtx` always provides a non-null `logger` infra field.
    const result = validateCapabilities(dag, makeCtx());
    expect(isErr(result)).toBe(true);
    if (!result.ok && result.error.kind === "missing-capability") {
      expect(result.error.missing[0].capability).toBe("logger" as Capability);
      expect(result.error.missing[0].nodeId).toBe(N("a"));
    }
  });

  it("prototype-meta names cannot be satisfied by inherited context properties", () => {
    const ctx = makeNodeContext({ runId: "r1", dagId: "d1" });
    for (const key of ["__proto__", "prototype", "constructor"] as const) {
      const capability = key as Capability;
      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("a", [capability])],
        edges: [{ from: DAG_INPUT, to: "a" }],
      });
      const result = validateCapabilities(dag, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "missing-capability") {
        expect(result.error.missing[0]).toEqual({ nodeId: N("a"), capability });
      }
    }
  });

  it("a broker claiming provides() for a BUILT-IN capability key → Err kind 'validation' (wiring error, not a silent drop)", () => {
    // SEAM CONTRACT with `mergeScopedCapabilities`: the merge refuses to overlay
    // built-in keys (`llm`/`http`/…), so a broker claiming one contradicts the
    // static built-in authority contract. Validation fails before minting, and
    // the merge independently fails closed for malformed unannounced output.
    const broker: CapabilityBroker = {
      mintFor: async () => ok({} as ScopedCapabilityHandle),
      provides: (c: Capability) => c === "llm",
    };
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["llm"])],
      edges: [{ from: DAG_INPUT, to: "a" }],
    });
    // Even with a non-null static llm wired, the broker's claim is the defect.
    const result = validateCapabilities(dag, makeCtx({ llm: fakeLlm }), broker);
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") {
        expect(result.error.nodeId).toBe(N("a"));
        expect(result.error.message).toContain('provides("llm")');
        expect(result.error.message).toContain("built-in");
      }
    }
  });

  it("each built-in capability key claimed by a broker is rejected (including budget)", () => {
    for (const builtin of BUILTIN_CAPABILITY_KEYS) {
      const broker: CapabilityBroker = {
        mintFor: async () => ok({} as ScopedCapabilityHandle),
        provides: (c: Capability) => c === builtin,
      };
      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("a", [builtin])],
        edges: [{ from: DAG_INPUT, to: "a" }],
      });
      const result = validateCapabilities(dag, makeCtx(), broker);
      expect(isErr(result)).toBe(true);
      if (!result.ok) expect(result.error.kind).toBe("validation");
    }
  });

  it("first miss is `missing[0]`, following node iteration order", () => {
    const dag = defineDagFromArray({
      id: "d",
      nodes: [
        makeNode("a", ["llm"]),
        makeNode("b", ["cache"]),
      ],
      edges: [{ from: DAG_INPUT, to: "a" }, { from: DAG_INPUT, to: "b" }],
    });
    const result = validateCapabilities(dag, makeCtx());
    if (!result.ok && result.error.kind === "missing-capability") {
      // First miss should be node "a" / "llm" since nodes are iterated in order
      expect(result.error.missing[0].nodeId).toBe(N("a"));
      expect(result.error.missing[0].capability).toBe("llm");
    }
  });
});

// ── Property: the validate/merge seam contract (validation-exempt ⇒ survives merge) ─
//
// `validateCapabilities` exempts every capability a broker `provides()` from the
// base-context check — promising the handle will arrive at dispatch. The promise
// only holds if `mergeScopedCapabilities` actually KEEPS the minted handle: a key
// the merge drops but validation exempts would pass validation for a handle the
// node never receives. The example tests above pin the built-in (rejected) side;
// this property pins the complement — every NON-built-in, NON-reserved name both
// passes validation AND survives the merge.

describe("validateCapabilities + mergeScopedCapabilities — seam invariant (property)", () => {
  const builtins: ReadonlySet<string> = new Set(BUILTIN_CAPABILITY_KEYS);
  const reserved: ReadonlySet<string> = new Set(RESERVED_NON_CAPABILITY_KEYS);

  // Capability-name-shaped strings: lowercase start, then letters/digits/`:`/
  // `.`/`-` (covers both plain custom names and `provider:operation` scopes).
  // `Capability` is `keyof CapabilityRegistry` — arbitrary strings don't
  // typecheck, so we cast deliberately, exactly as runtime-built `requires`
  // arrays would (the cast is the scenario under test). Built-in and reserved
  // names are filtered out — those are the rejected/collision classes covered
  // by the example tests above.
  const customCapabilityName = fc
    .stringMatching(/^[a-z][a-zA-Z0-9:.-]{0,30}$/)
    .filter((s) => !builtins.has(s) && !reserved.has(s));

  it("for ANY non-built-in, non-reserved name: a broker claiming provides() passes validation AND the minted handle survives the merge", () => {
    fc.assert(
      fc.property(customCapabilityName, (name) => {
        const capName = name as Capability;
        const broker: CapabilityBroker = {
          mintFor: async () => ok({} as ScopedCapabilityHandle),
          provides: (c: Capability) => c === capName,
        };

        // (1) Validation: the base context does NOT carry the capability, but
        // the broker claims it → exempt, run-start validation passes.
        const dag = defineDagFromArray({
          id: "d",
          nodes: [makeNode("a", [capName])],
          edges: [{ from: DAG_INPUT, to: "a" }],
        });
        const validated = validateCapabilities(dag, makeCtx(), broker);
        expect(isOk(validated)).toBe(true);

        // (2) Merge: a handle minted under that key survives the dispatch-time
        // merge BY REFERENCE — the validation exemption's promise is kept.
        const base = makeNodeContext({ runId: "run-prop", dagId: "dag-prop" });
        const handle = { op: async () => ok(undefined) };
        const merged = mergeScopedCapabilities(
          base,
          { [capName]: handle } as unknown as ScopedCapabilityHandle,
        );
        expect(merged.ok).toBe(true);
        if (!merged.ok) return;
        expect((merged.value as unknown as Record<string, unknown>)[capName]).toBe(handle);
      }),
    );
  });

  it("the rejected complement: every built-in key claimed by a broker fails validation AND merge (the seam agrees on both sides)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...BUILTIN_CAPABILITY_KEYS), (builtin) => {
        const broker: CapabilityBroker = {
          mintFor: async () => ok({} as ScopedCapabilityHandle),
          provides: (c: Capability) => c === builtin,
        };
        const dag = defineDagFromArray({
          id: "d",
          nodes: [makeNode("a", [builtin])],
          edges: [{ from: DAG_INPUT, to: "a" }],
        });
        // Validation rejects the claim loudly…
        const validated = validateCapabilities(dag, makeCtx(), broker);
        expect(isErr(validated)).toBe(true);
        if (!validated.ok) expect(validated.error.kind).toBe("validation");

        // …and the merge independently refuses the malformed minted output.
        // If broker-minted built-ins land (FR-W2-009), both sides must change in
        // the same commit.
        const base = makeNodeContext({ runId: "run-prop", dagId: "dag-prop" });
        const merged = mergeScopedCapabilities(
          base,
          { [builtin]: { bogus: true } } as unknown as ScopedCapabilityHandle,
        );
        expect(merged).toEqual({
          ok: false,
          error: { kind: "reserved-capability", key: builtin },
        });
        expect((base as unknown as Record<string, unknown>)[builtin]).not.toEqual({ bogus: true });
      }),
    );
  });
});
