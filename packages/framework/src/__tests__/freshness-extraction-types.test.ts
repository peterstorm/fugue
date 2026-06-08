import { resourceName, witness, witnessValue, mkWitness, RN } from "./_freshness-helpers.js";
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
import type { Witness, WitnessValue } from "../types/freshness.js";
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
        return witness("version", "postgres:orders", String(v));
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

  test("node without extractors compiles (freshness tracking silently skipped)", () => {
    const node: NodeDef<unknown, unknown> = {
      id: "pure" as any,
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
    const witnesses: Witness[] = [
      witness("version", "r", "1"),
      witness("etag", "r", "abc"),
      witness("timestamp", "r", "1234567890"),
      witness("lsn", "r", "0/1234"),
      witness("idempotency-key", "r", "idem-1"),
      witness("custom", "r", "custom-val"),
    ];
    expect(witnesses).toHaveLength(6);
  });
});
