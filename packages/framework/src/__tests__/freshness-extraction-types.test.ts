/**
 * Phase 3 test — freshness extraction type-level assertions.
 *
 * Validates at compile time:
 * - A `writes` node can declare `extractConditionedOn` and `extractNewWitness`.
 * - A `reads` node can declare `extractWitness`.
 * - Extractor return types must be `Witness`.
 * - Extractors receive the correct input/output types.
 *
 * Note: The plan's Phase 3 describes extractors as *required* for reads/writes
 * nodes via a discriminated NodeDef union. The implementation uses optional
 * fields instead (pragmatic: avoids breaking every existing node definition).
 * These tests validate the optional-field shape compiles correctly and that
 * the extractor type signatures are sound.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { NodeDef } from "../types/node.js";
import type { Witness } from "../types/freshness.js";
import { ok } from "../types/result.js";

describe("freshness extraction types (Phase 3)", () => {
  test("reads node with extractWitness compiles — extractor receives output type", () => {
    const node: NodeDef<unknown, { version: number; data: string }> = {
      id: "reader" as any,
      kind: "fetch",
      inputSchema: z.unknown(),
      outputSchema: z.object({ version: z.number(), data: z.string() }),
      requires: [],
      sideEffects: { kind: "reads", resource: "postgres:orders" },
      confidence: { mode: "none" },
      extractWitness: (output) => {
        // Type assertion: output is { version: number; data: string }
        const v: number = output.version;
        return { kind: "version", resource: "postgres:orders", value: String(v) };
      },
      run: async () => ok({ version: 1, data: "test" }),
    };
    expect(node.extractWitness).toBeDefined();
    // Verify the extractor returns a Witness
    const w: Witness = node.extractWitness!({ version: 42, data: "x" });
    expect(w.kind).toBe("version");
    expect(w.value).toBe("42");
  });

  test("writes node with both extractors compiles — correct input/output types", () => {
    const node: NodeDef<{ version: number }, { newVersion: number }> = {
      id: "writer" as any,
      kind: "transform",
      inputSchema: z.object({ version: z.number() }),
      outputSchema: z.object({ newVersion: z.number() }),
      requires: [],
      sideEffects: { kind: "writes", resource: "postgres:orders" },
      confidence: { mode: "none" },
      extractConditionedOn: (input) => {
        // Type assertion: input is { version: number }
        const v: number = input.version;
        return { kind: "version", resource: "postgres:orders", value: String(v) };
      },
      extractNewWitness: (output) => {
        // Type assertion: output is { newVersion: number }
        const v: number = output.newVersion;
        return { kind: "version", resource: "postgres:orders", value: String(v) };
      },
      run: async () => ok({ newVersion: 43 }),
    };
    expect(node.extractConditionedOn).toBeDefined();
    expect(node.extractNewWitness).toBeDefined();

    const conditioned: Witness = node.extractConditionedOn!({ version: 42 });
    expect(conditioned.value).toBe("42");

    const newW: Witness = node.extractNewWitness!({ newVersion: 43 });
    expect(newW.value).toBe("43");
  });

  test("extractWitness return type must be Witness (not bare object)", () => {
    // This compiles because the return satisfies the Witness interface.
    // If someone tried to return { foo: "bar" } it would be a compile error.
    const extractor: NodeDef<unknown, { v: number }>["extractWitness"] =
      (output) => ({
        kind: "version" as const,
        resource: "test",
        value: String(output.v),
      });
    expect(extractor).toBeDefined();

    // Verify the return type
    const result = extractor!({ v: 99 });
    expect(result.kind).toBe("version");
    expect(result.resource).toBe("test");
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
      // No extractors — this is valid
      run: async () => ok("result"),
    };
    expect(node.extractWitness).toBeUndefined();
    expect(node.extractConditionedOn).toBeUndefined();
    expect(node.extractNewWitness).toBeUndefined();
  });

  test("WitnessKind covers all expected variants", () => {
    // Type-level exhaustiveness: all WitnessKind values compile as Witness.kind
    const witnesses: Witness[] = [
      { kind: "version", resource: "r", value: "1" },
      { kind: "etag", resource: "r", value: "abc" },
      { kind: "timestamp", resource: "r", value: "1234567890" },
      { kind: "lsn", resource: "r", value: "0/1234" },
      { kind: "idempotency-key", resource: "r", value: "idem-1" },
      { kind: "custom", resource: "r", value: "custom-val" },
    ];
    expect(witnesses).toHaveLength(6);
  });
});
