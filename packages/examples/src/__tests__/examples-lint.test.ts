// Regression guard for the golden DAG examples.
//
// Every file in `dags/` is a copy-paste-ready authoring example referenced by
// `@fuguejs/framework/docs/llm-dag-authoring.md`. This suite imports each one through the same
// `runLint` the `fugue` CLI uses, so a structurally broken example fails the
// build instead of silently rotting in the docs. (Type-level correctness —
// including `requires` validity — is covered separately by `tsc --noEmit`.)

import { describe, it, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runLint } from "@fuguejs/framework";

const dagsDir = resolve(import.meta.dir, "..", "..", "dags");

const exampleFiles = readdirSync(dagsDir)
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("golden DAG examples", () => {
  it("ships at least the documented set of examples", () => {
    // Guards against an empty glob silently passing the suite.
    expect(exampleFiles.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of exampleFiles) {
    it(`${file} lints clean`, async () => {
      const result = await runLint(resolve(dagsDir, file));
      if (!result.ok) {
        // Surface the structured error so a failure is actionable, not opaque.
        throw new Error(`${file} failed to lint: ${JSON.stringify(result.errors, null, 2)}`);
      }
      expect(result.ok).toBe(true);
    });
  }
});
