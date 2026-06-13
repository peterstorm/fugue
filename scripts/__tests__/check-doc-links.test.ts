// Unit tests for the pure core of the shipped-doc link checker. The `exists`
// seam lets us drive every branch — including the "escapes packages/" case that
// the real monorepo never exercises (no in-tree shipped doc links out today) —
// without touching disk.

import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { findDocLinkProblems, type DocLinkEnv } from "../check-doc-links.ts";

const packagesRoot = "/repo/packages";
const shippedDocRoots = [
  resolve(packagesRoot, "framework/docs"),
  resolve(packagesRoot, "host/docs"),
];

// All links resolve to existing targets unless a test says otherwise.
const env = (exists: (p: string) => boolean): DocLinkEnv => ({
  packagesRoot,
  shippedDocRoots,
  exists,
});

const docFile = resolve(packagesRoot, "framework/docs/guide.md");

describe("findDocLinkProblems", () => {
  it("flags a link from a shipped doc that escapes packages/ (would 404 once installed)", () => {
    // ../../../docs/adr.md resolves to /repo/docs/adr.md — outside packages/.
    const problems = findDocLinkProblems(
      docFile,
      "See [the ADR](../../../docs/adr.md) for rationale.",
      env(() => true), // target exists, so we reach the escape check
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toContain("escapes packages/");
    expect(problems[0]!.target).toBe("../../../docs/adr.md");
  });

  it("flags a dangling relative link whose target does not exist", () => {
    const problems = findDocLinkProblems(
      docFile,
      "See [the missing page](./gone.md).",
      env(() => false),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toContain("dangling");
  });

  it("accepts a sibling shipped-doc link that stays under packages/", () => {
    const problems = findDocLinkProblems(
      docFile,
      "See [the adapter guide](./adapter-authoring.md).",
      env(() => true),
    );
    expect(problems).toEqual([]);
  });

  it("strips a trailing #anchor and validates the file target (existing file → ok)", () => {
    // A relative-file link carrying a section anchor: only the file part is
    // validated. `exists` is asserted to receive the anchor-stripped path.
    let checked = "";
    const problems = findDocLinkProblems(
      docFile,
      "See [the section](./adapter-authoring.md#configuration).",
      env((p) => {
        checked = p;
        return true;
      }),
    );
    expect(problems).toEqual([]);
    expect(checked).toBe(resolve(packagesRoot, "framework/docs/adapter-authoring.md"));
  });

  it("flags a relative-file link with a #anchor as dangling when the file is missing", () => {
    // The anchor must not mask a dangling file target.
    const problems = findDocLinkProblems(
      docFile,
      "See [the section](./gone.md#configuration).",
      env(() => false),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toContain("dangling");
    expect(problems[0]!.target).toBe("./gone.md#configuration");
  });

  it("does not apply the escape rule to a README outside the strict docs roots", () => {
    // A package README may link into the monorepo docs/ root; only files under a
    // shipped `docs/` dir carry the strict shipped→shipped rule.
    const readme = resolve(packagesRoot, "framework/README.md");
    const problems = findDocLinkProblems(
      readme,
      "See [the ADR](../../docs/adr.md).",
      env(() => true),
    );
    expect(problems).toEqual([]);
  });

  it("ignores external, anchor-only, and code-span links", () => {
    const md = [
      "[external](https://example.com/x.md)",
      "[anchor](#section)",
      "`[not a link](./nope.md)`",
      "```\n[fenced](./also-nope.md)\n```",
    ].join("\n\n");
    const problems = findDocLinkProblems(docFile, md, env(() => false));
    expect(problems).toEqual([]);
  });
});
