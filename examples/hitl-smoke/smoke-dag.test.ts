// Regression guard for the HITL smoke DAG.
//
// The smoke DAG lives outside `packages/examples/dags/`, so the golden
// examples-lint suite does not cover it. Without this test a wiring typo (a bad
// fan-in key, a stale model id, a broken `defineLinearDag` chain) would ship
// silently and only surface during a manual `bun run smoke` against a live host.
// Run it through the same `runLint` the `fugue` CLI uses, so the build fails fast.
//
// The DAG references `@fuguejs/host/contract` only as an `import type` (erased at
// runtime), so `runLint` loads it without pulling in the host.

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { runLint } from "@fuguejs/framework";

describe("HITL smoke DAG", () => {
  it("dags/demo/approval/dag.ts lints clean", async () => {
    const dagPath = resolve(import.meta.dir, "dags", "demo", "approval", "dag.ts");
    const result = await runLint(dagPath);
    if (!result.ok) {
      // Surface the structured error so a failure is actionable, not opaque.
      throw new Error(`smoke DAG failed to lint: ${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });
});
