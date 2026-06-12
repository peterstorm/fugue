// Drift guard for the shipped copy of the golden examples.
//
// `packages/examples` stays the lint-tested source of truth (private, never
// published). `@fuguejs/framework` ships a byte-identical copy under
// `docs/examples/` so a consumer who installs only the framework still gets the
// canonical, copy-paste examples (the examples package itself is private —
// ADR-shipping plan E3). This suite fails the build if the two diverge, so the
// copy can never silently rot out of sync with the source it was lint-tested as.

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceDir = resolve(import.meta.dir, "..", "..", "dags");
const shippedDir = resolve(import.meta.dir, "..", "..", "..", "framework", "docs", "examples");

const tsFiles = (dir: string) =>
  readdirSync(dir).filter((name) => name.endsWith(".ts")).sort();

describe("shipped example copy (@fuguejs/framework/docs/examples)", () => {
  it("ships exactly the same set of files as the lint-tested source", () => {
    expect(tsFiles(shippedDir)).toEqual(tsFiles(sourceDir));
  });

  for (const file of tsFiles(sourceDir)) {
    it(`${file} is byte-identical to the source`, () => {
      const source = readFileSync(resolve(sourceDir, file), "utf8");
      const shipped = readFileSync(resolve(shippedDir, file), "utf8");
      // To update the shipped copy after editing an example, re-run:
      //   cp packages/examples/dags/*.ts packages/framework/docs/examples/
      expect(shipped).toBe(source);
    });
  }
});
