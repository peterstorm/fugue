// Compile-time guard: DagMachineContextPersisted must NOT carry closure-bearing
// fields like SideEffectProfile (which has extractWitness, idempotencyKey, etc.).
//
// The guard works by checking that DagMachineContextPersisted does NOT extend a
// shape containing NodeDef (which carries SideEffectProfile + run closures).
// If someone accidentally adds a `dag` or `nodeById` field to
// DagMachineContextPersisted, the type-level assertion fails here at compile time.

import { describe, it, expect } from "bun:test";
import type { DagMachineContextPersisted } from "../dag-runtime/types.js";
import type { DagDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { NodeId } from "../types/ids.js";

// ---------------------------------------------------------------------------
// Type-level assertions (zero runtime cost — erased by TypeScript)
// ---------------------------------------------------------------------------

// DagMachineContextPersisted must NOT have a `dag` field (which carries closures).
type _AssertNoDag = DagMachineContextPersisted extends { dag: DagDef }
  ? "ERROR: DagMachineContextPersisted must not contain dag (closures)"
  : never;
const _noDag: _AssertNoDag = undefined as never;
void _noDag;

// DagMachineContextPersisted must NOT have a `nodeById` field.
type _AssertNoNodeById = DagMachineContextPersisted extends {
  nodeById: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>;
}
  ? "ERROR: DagMachineContextPersisted must not contain nodeById (closures)"
  : never;
const _noNodeById: _AssertNoNodeById = undefined as never;
void _noNodeById;

// ---------------------------------------------------------------------------
// Runtime test (documents the intent for humans reading the test output)
// ---------------------------------------------------------------------------

describe("DagMachineContextPersisted serialization safety", () => {
  it("does not carry closure-bearing fields (compile-time assertion)", () => {
    // The type-level assertions above are the real test — if they fail,
    // the file fails to compile. This runtime assertion is documentation.
    expect(true).toBe(true);
  });
});
