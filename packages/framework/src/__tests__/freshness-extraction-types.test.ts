import { resourceName, witness, mkWitness, RN } from "./_freshness-helpers.js";
/**
 * Phase 3 test — freshness extraction type-level assertions.
 *
 * Validates at compile time:
 * - A `writes` sideEffects can declare `extractConditionedOn` and `extractNewWitness`.
 * - A `reads` sideEffects can declare `extractWitness`.
 * - Extractor return types must be `Witness`.
 * - Extractors are colocated on the SideEffectProfile discriminated union.
 *
 * The extractors live on `SideEffectProfile` variants (not top-level `NodeDef`),
 * so `extractWitness` on a `writes` node or `extractConditionedOn` on a `reads`
 * node is a compile error.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import type { Witness } from "../types/freshness.js";
import { ok } from "../types/result.js";

describe("freshness extraction types (Phase 3)", () => {
  test("reads sideEffects with extractWitness compiles — extractor receives output type", () => {
    const se: SideEffectProfile = {
      kind: "reads",
      resource: RN("postgres:orders"),
      extractWitness: (output: any) => {
        const v: number = output.version;
        return witness("version", "postgres:orders", String(v));
      },
    };
    const node: NodeDef<unknown, { version: number; data: string }> = {
      id: "reader" as any,
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
      const w: Witness = node.sideEffects.extractWitness!({ version: 42, data: "x" });
      expect(w.kind).toBe("version");
      expect(w.value).toBe("42");
    }
  });

  test("writes sideEffects with both extractors compiles", () => {
    const se: SideEffectProfile = {
      kind: "writes",
      resource: RN("postgres:orders"),
      extractConditionedOn: (input: any) => {
        const v: number = input.version;
        return witness("version", "postgres:orders", String(v));
      },
      extractNewWitness: (output: any) => {
        const v: number = output.newVersion;
        return witness("version", "postgres:orders", String(v));
      },
    };
    const node: NodeDef<{ version: number }, { newVersion: number }> = {
      id: "writer" as any,
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

      const newW: Witness = node.sideEffects.extractNewWitness!({ newVersion: 43 });
      expect(newW.value).toBe("43");
    }
  });

  test("reads extractWitness return type must be Witness", () => {
    const se: Extract<SideEffectProfile, { kind: "reads" }> = {
      kind: "reads",
      resource: RN("test"),
      extractWitness: (output: any) => witness("version", "test", String(output.v)),
    };
    expect(se.extractWitness).toBeDefined();
    const result = se.extractWitness!({ v: 99 });
    expect(result.kind).toBe("version");
    expect(result.resource).toBe(RN("test"));
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
