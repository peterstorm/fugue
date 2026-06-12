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
import { N, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { makeNodeContext, mergeScopedCapabilities } from "../shared/make-node-context.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import type { NodeDef, BaseNodeContext, Capability } from "../types/node.js";
import { BUILTIN_CAPABILITY_KEYS, RESERVED_NON_CAPABILITY_KEYS } from "../types/node.js";
import type { LlmClient } from "../types/llm.js";
import type { FrameworkError } from "../types/errors.js";
import type { CapabilityBroker, ScopedCapabilityHandle } from "../types/capability-broker.js";
import { isOk, isErr, ok } from "../types/result.js";
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
      expect(result.error.missing[0].capability).toBe("logger" as Capability);
      expect(result.error.missing[0].nodeId).toBe(N("a"));
    }
  });

  it("a broker claiming provides() for a BUILT-IN capability key → Err kind 'validation' (wiring error, not a silent drop)", () => {
    // SEAM CONTRACT with `mergeScopedCapabilities`: the merge refuses to overlay
    // built-in keys (`llm`/`http`/…), so a broker claiming one would have its
    // minted handle silently dropped — the node would run against the static
    // client while the system believes the broker governs it (silent authority
    // widening). Validation must fail the run LOUDLY instead.
    const broker: CapabilityBroker = {
      mintFor: async () => ok({} as ScopedCapabilityHandle),
      provides: (c: Capability) => c === "llm",
    };
    const dag = defineDagFromArray({
      id: "d",
      nodes: [makeNode("a", ["llm"])],
      edges: [],
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

  it("each built-in capability key claimed by a broker is rejected (llm/cache/prompts/judgeLlm/http)", () => {
    for (const builtin of BUILTIN_CAPABILITY_KEYS) {
      const broker: CapabilityBroker = {
        mintFor: async () => ok({} as ScopedCapabilityHandle),
        provides: (c: Capability) => c === builtin,
      };
      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("a", [builtin])],
        edges: [],
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
      edges: [],
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
          edges: [],
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
        expect((merged as unknown as Record<string, unknown>)[capName]).toBe(handle);
      }),
    );
  });

  it("the rejected complement: every built-in key claimed by a broker fails validation AND is dropped by the merge (the seam agrees on both sides)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...BUILTIN_CAPABILITY_KEYS), (builtin) => {
        const broker: CapabilityBroker = {
          mintFor: async () => ok({} as ScopedCapabilityHandle),
          provides: (c: Capability) => c === builtin,
        };
        const dag = defineDagFromArray({
          id: "d",
          nodes: [makeNode("a", [builtin])],
          edges: [],
        });
        // Validation rejects the claim loudly…
        const validated = validateCapabilities(dag, makeCtx(), broker);
        expect(isErr(validated)).toBe(true);
        if (!validated.ok) expect(validated.error.kind).toBe("validation");

        // …because the merge would silently drop the same key (kept in lockstep:
        // if the merge ever starts overlaying built-ins, FR-W2-009, this pair of
        // assertions forces the validation rejection to be lifted in the same
        // commit).
        const base = makeNodeContext({ runId: "run-prop", dagId: "dag-prop" });
        const merged = mergeScopedCapabilities(
          base,
          { [builtin]: { bogus: true } } as unknown as ScopedCapabilityHandle,
        );
        expect((merged as unknown as Record<string, unknown>)[builtin]).toBe(
          (base as unknown as Record<string, unknown>)[builtin],
        );
      }),
    );
  });
});
