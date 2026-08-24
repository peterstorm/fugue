import { resourceName, witness, witnessValue, stampWitness, RN } from "./_freshness-helpers.js";
/**
 * Phase 3 test — freshness extraction type-level assertions.
 *
 * Validates at compile time:
 * - A `writes` sideEffects can declare `extractConditionedOn` and `extractNewWitness`.
 * - A `reads` sideEffects can declare `extractWitness`.
 * - `extractWitness` / `extractNewWitness` return `WitnessValue` (resource-free —
 *   the framework stamps the node's resource); `extractConditionedOn` returns a
 *   full `Witness` (its resource is a free variable).
 * - Extractors are colocated on the SideEffectProfile discriminated union.
 *
 * The extractors live on `SideEffectProfile` variants (not top-level `NodeDef`),
 * so `extractWitness` on a `writes` node or `extractConditionedOn` on a `reads`
 * node is a compile error.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { NodeId } from "../types/ids.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import type { Witness, WitnessValue, WitnessKind } from "../types/freshness.js";
import { ok } from "../types/result.js";

describe("freshness extraction types (Phase 3)", () => {
  test("reads sideEffects with extractWitness compiles — extractor receives output type", () => {
    const se: SideEffectProfile = {
      kind: "reads",
      resource: RN("postgres:orders"),
      extractWitness: (output: unknown) => {
        const v: number = (output as { version: number }).version;
        return witnessValue("version", String(v));
      },
    };
    const node: NodeDef<unknown, { version: number; data: string }> = {
      id: "reader" as unknown as NodeId,
      kind: "fetch",
      inputSchema: z.unknown(),
      outputSchema: z.object({ version: z.number(), data: z.string() }),
      requires: [],
      sideEffects: se,
      confidence: { mode: "none" },
      run: async () => ok({ version: 1, data: "test" }),
    };
    expect(node.sideEffects.kind).toBe("reads");
    if (node.sideEffects.kind === "reads") {
      expect(node.sideEffects.extractWitness).toBeDefined();
      // Resource-free: the extractor yields only (kind, value); the framework
      // stamps the resource at emission time.
      const w: WitnessValue = node.sideEffects.extractWitness!({ version: 42, data: "x" });
      expect(w.kind).toBe("version");
      expect(w.value).toBe("42");
    }
  });

  test("writes sideEffects with both extractors compiles", () => {
    const se: SideEffectProfile = {
      kind: "writes",
      resource: RN("postgres:orders"),
      // extractConditionedOn keeps a full Witness — its resource is a free
      // variable (a write may condition on a different resource read upstream).
      extractConditionedOn: (input: unknown) => {
        const v: number = (input as { version: number }).version;
        return witness("version", RN("postgres:orders"), String(v));
      },
      // extractNewWitness is resource-free — the framework stamps this node's resource.
      extractNewWitness: (output: unknown) => {
        const v: number = (output as { newVersion: number }).newVersion;
        return witnessValue("version", String(v));
      },
    };
    const node: NodeDef<{ version: number }, { newVersion: number }> = {
      id: "writer" as unknown as NodeId,
      kind: "transform",
      inputSchema: z.object({ version: z.number() }),
      outputSchema: z.object({ newVersion: z.number() }),
      requires: [],
      sideEffects: se,
      confidence: { mode: "none" },
      run: async () => ok({ newVersion: 43 }),
    };
    if (node.sideEffects.kind === "writes") {
      expect(node.sideEffects.extractConditionedOn).toBeDefined();
      expect(node.sideEffects.extractNewWitness).toBeDefined();

      const conditioned: Witness = node.sideEffects.extractConditionedOn!({ version: 42 });
      expect(conditioned.value).toBe("42");
      expect(conditioned.resource).toBe(RN("postgres:orders"));

      const newW: WitnessValue = node.sideEffects.extractNewWitness!({ newVersion: 43 });
      expect(newW.value).toBe("43");
    }
  });

  test("reads extractWitness return type is resource-free WitnessValue", () => {
    const se: Extract<SideEffectProfile, { kind: "reads" }> = {
      kind: "reads",
      resource: RN("test"),
      extractWitness: (output: unknown) => witnessValue("version", String((output as { v: number }).v)),
    };
    expect(se.extractWitness).toBeDefined();
    const result: WitnessValue = se.extractWitness!({ v: 99 });
    expect(result.kind).toBe("version");
    // No `resource` on the extractor output — the framework stamps se.resource.
    expect("resource" in result).toBe(false);
    expect(result.value).toBe("99");
  });

  test("a full Witness is rejected from a resource-free extractor slot (compile-time guarantee)", () => {
    const se: Extract<SideEffectProfile, { kind: "reads" }> = {
      kind: "reads",
      resource: RN("postgres:orders"),
      // @ts-expect-error — extractWitness returns WitnessValue, whose `resource`
      // is `never`; a full Witness carries `resource: ResourceName` and is
      // therefore unassignable. This makes a resource mismatch *unrepresentable*
      // at compile time, not merely overwritten at runtime. If this directive
      // ever stops erroring, the type-level guarantee has regressed. (The
      // witness() call itself is well-typed — the error is purely the
      // return-type mismatch against the resource-free slot.)
      extractWitness: () => witness("version", RN("wrong:resource"), "1"),
    };
    expect(se.extractWitness).toBeDefined();
  });

  test("a full Witness is rejected from the writes extractNewWitness slot (compile-time guarantee)", () => {
    const se: Extract<SideEffectProfile, { kind: "writes" }> = {
      kind: "writes",
      resource: RN("postgres:orders"),
      extractConditionedOn: () => witness("version", RN("postgres:orders"), "0"),
      // @ts-expect-error — extractNewWitness is the symmetric resource-free slot:
      // it returns WitnessValue (`resource: never`), so a full Witness is
      // unassignable here too. Same guarantee as extractWitness above; if this
      // directive stops erroring, the writes-side guarantee has regressed.
      extractNewWitness: () => witness("version", RN("wrong:resource"), "1"),
    };
    expect(se.extractNewWitness).toBeDefined();
  });

  test("writes freshness extractors are an all-or-none pair", () => {
    // @ts-expect-error — a conditioned-on witness without the produced witness
    // cannot perform freshness bookkeeping and is excluded by the ADT.
    const missingNewWitness: SideEffectProfile = {
      kind: "writes",
      resource: RN("postgres:orders"),
      extractConditionedOn: () => witness("version", RN("postgres:orders"), "1"),
    };
    // @ts-expect-error — a produced witness without its conditioned-on witness
    // cannot perform conflict detection and is excluded by the ADT.
    const missingConditionedOn: SideEffectProfile = {
      kind: "writes",
      resource: RN("postgres:orders"),
      extractNewWitness: () => witnessValue("version", "2"),
    };

    expect(missingNewWitness.kind).toBe("writes");
    expect(missingConditionedOn.kind).toBe("writes");
  });

  test("stampWitness produces the same full Witness as the witness constructor (roundtrip)", () => {
    const stamped = stampWitness(RN("postgres:orders"), witnessValue("etag", "abc123"));
    // Pins the (kind, resource, value) argument order independent of the
    // emission wiring — a transposed stampWitness arg would fail here.
    expect(stamped.kind).toBe("etag");
    expect(stamped.resource).toBe(RN("postgres:orders"));
    expect(stamped.value).toBe("abc123");
    expect(stamped).toEqual(witness("etag", RN("postgres:orders"), "abc123"));
  });

  test("stampWitness re-validates the non-empty value invariant at the stamping boundary", () => {
    // The WitnessValue doc promises its sole invariant is re-validated where it
    // matters — stampWitness, which routes through witness(). A hand-built
    // empty value bypassing witnessValue() must still be rejected here.
    expect(() => stampWitness(RN("postgres:orders"), { kind: "version", value: "" } as WitnessValue)).toThrow();
  });

  test("stampWitness overrides any stray runtime resource with the stamped one", () => {
    // `resource?: never` is a compile-time guarantee only; a hand-built object
    // cast to WitnessValue could smuggle a `resource` field at runtime. The
    // framework must always win — the stamped resource is authoritative, so a
    // mismatch cannot leak into the emitted witness. This makes the
    // "framework stamps, author never names own resource" contract explicit
    // rather than incidental.
    const smuggled = { kind: "version", value: "42", resource: RN("attacker:controlled") } as unknown as WitnessValue;
    const stamped = stampWitness(RN("postgres:orders"), smuggled);
    expect(stamped.resource).toBe(RN("postgres:orders"));
    expect(stamped.value).toBe("42");
  });

  test("stampWitness throws an actionable error when an extractor returns no WitnessValue", () => {
    // An author extractor whose body falls through to an implicit `return`
    // yields undefined. Fail-closed is preserved (it throws), but the message
    // must name the authoring mistake rather than surfacing an opaque
    // "Cannot read properties of undefined" TypeError.
    expect(() => stampWitness(RN("postgres:orders"), undefined as unknown as WitnessValue)).toThrow(
      /returned no WitnessValue/,
    );
    expect(() => stampWitness(RN("postgres:orders"), "version" as unknown as WitnessValue)).toThrow(
      /returned no WitnessValue/,
    );
  });

  test("witnessValue rejects an empty value (smart-constructor invariant)", () => {
    expect(() => witnessValue("version", "")).toThrow();
    // witness() enforces non-empty value; the non-empty-resource invariant now
    // lives at the ResourceName boundary (witness() takes an already-branded
    // resource, so it cannot be handed a raw — possibly empty — string).
    expect(() => witness("version", RN("postgres:orders"), "")).toThrow();
    expect(() => resourceName("")).toThrow();
  });

  // Round-18 tda-1: the smart constructors now enforce the CLOSED WitnessKind
  // union at mint time (the file adapter's boundary gate is no longer the
  // only line of defense — a cast or plain-JS caller cannot mint an
  // off-contract witness). `__brandWitness` remains the trusted
  // deserialization bypass.
  test("witness()/witnessValue() reject an off-contract kind (closed-union invariant)", () => {
    const bogus = "bogus-kind" as unknown as ReturnType<typeof witnessValue>["kind"];
    expect(() => witnessValue(bogus, "v")).toThrow(TypeError);
    expect(() => witness(bogus, RN("postgres:orders"), "v")).toThrow(TypeError);
    // stampWitness routes through witness(), so a smuggled kind is caught there.
    expect(() => stampWitness(RN("postgres:orders"), witnessValue(bogus, "v"))).toThrow(TypeError);
  });

  test("node without extractors compiles (freshness tracking silently skipped)", () => {
    const node: NodeDef<unknown, unknown> = {
      id: "pure" as unknown as NodeId,
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: { kind: "none" },
      confidence: { mode: "none" },
      run: async () => ok("result"),
    };
    // With colocated extractors, a `none` node has no extractor fields at all
    expect(node.sideEffects.kind).toBe("none");
  });

  test("WitnessKind covers all expected variants", () => {
    // `satisfies Record<WitnessKind, …>` makes this exhaustiveness check
    // compile-enforced: adding or removing a WitnessKind variant without
    // updating this map is a type error, not a silently-passing length assert.
    const samples = {
      version: "1",
      etag: "abc",
      timestamp: "1234567890",
      lsn: "0/1234",
      "idempotency-key": "idem-1",
      custom: "custom-val",
    } satisfies Record<WitnessKind, string>;

    const witnesses: Witness[] = (Object.entries(samples) as [WitnessKind, string][]).map(
      ([kind, value]) => witness(kind, RN("r"), value),
    );
    expect(witnesses).toHaveLength(Object.keys(samples).length);
    expect(new Set(witnesses.map((w) => w.kind)).size).toBe(witnesses.length);
  });
});
