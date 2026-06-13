import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { runLint } from "../../cli/lint.js";
import { runDescribe } from "../../cli/describe.js";
import { runCapabilities } from "../../cli/capabilities.js";
import { BUILTIN_CAPABILITY_KEYS } from "../../types/node.js";

const fixturePath = (name: string): string =>
  resolve(__dirname, "fixtures", name);

const binPath = resolve(__dirname, "..", "..", "..", "bin", "fugue.ts");

const runBin = async (
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

describe("runLint", () => {
  it("reports ok for a valid DAG file", async () => {
    const result = await runLint(fixturePath("valid-dag.ts"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toContain("valid-dag.ts");
    }
  });

  it("captures DagDefinitionError as dag-definition-error", async () => {
    const result = await runLint(fixturePath("invalid-edge-typo.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.kind).toBe("dag-definition-error");
      // The DagDefinitionError carries the detail FrameworkError verbatim.
      const e = result.errors[0]! as Extract<
        typeof result.errors[number],
        { kind: "dag-definition-error" }
      >;
      expect(e.dagId).toBe("invalid-edge-fixture");
      expect(e.detail).toBeDefined();
      expect(typeof e.detail.kind).toBe("string");
    }
  });

  it("reports no-default-export for a module without a default", async () => {
    const result = await runLint(fixturePath("no-default-export.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.kind).toBe("no-default-export");
    }
  });

  it("reports missing-dag-field when default export lacks .dag", async () => {
    const result = await runLint(fixturePath("missing-dag-field.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.kind).toBe("missing-dag-field");
    }
  });

  it("reports import-failed for a non-existent path", async () => {
    const result = await runLint("/tmp/does-not-exist-fugue-test.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.kind).toBe("import-failed");
    }
  });

  it("propagates a B1 fan-in-key-mismatch from the analyzer (ok: false)", async () => {
    // The DAG imports/defineDag-validates fine; the structural analyzer must
    // surface the key mismatch and flip the lint result to ok: false.
    const result = await runLint(fixturePath("manual-fan-in-mismatch.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find((x) => x.kind === "fan-in-key-mismatch");
      expect(e).toBeDefined();
      if (e && e.kind === "fan-in-key-mismatch") {
        expect(e.nodeId).toBe("join");
        expect(e.missingKeys).toContain("right");
        expect(e.extraKeys).toContain("WRONG");
      }
    }
  });

  it("propagates a B3 shape-helper-hint advisory alongside ok: true", async () => {
    const result = await runLint(fixturePath("manual-linear-advisory.ts"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const hints = (result.advisories ?? []).flatMap((a) =>
        a.kind === "shape-helper-hint" ? [a.helper] : [],
      );
      expect(hints).toContain("defineLinearDag");
    }
  });
});

describe("runDescribe", () => {
  it("returns a structured summary for a valid DAG", async () => {
    const result = await runDescribe(fixturePath("valid-dag.ts"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.dag.id).toBe("valid-fixture");
    expect(result.dag.route).toBe("/dags/valid-fixture/run");
    expect(result.dag.description).toBe("Valid fixture DAG");
    expect(result.dag.version).toBe("1.0.0");
    expect(result.dag.outputNodeId).toBe("summarize");

    // 2 nodes
    expect(result.dag.nodes).toHaveLength(2);
    expect(result.dag.nodes[0]!.id).toBe("fetch-user");
    expect(result.dag.nodes[1]!.id).toBe("summarize");
    expect(result.dag.nodes[0]!.kind).toBe("fetch");
    expect(result.dag.nodes[1]!.kind).toBe("transform");

    // 2 edges: the chain edge + the DAG_INPUT edge defineLinearDag injects to
    // the entry node (C0 — the request flows in over an explicit edge).
    expect(result.dag.edges).toHaveLength(2);
    expect(result.dag.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "fetch-user", to: "summarize", kind: "unconditional" }),
        expect.objectContaining({ from: "$input", to: "fetch-user", kind: "unconditional" }),
      ]),
    );

    // Two waves: [[fetch-user], [summarize]] — $input adds no wave.
    expect(result.dag.waves).toEqual([["fetch-user"], ["summarize"]]);

    // JSON Schemas should be present (zod renders an object schema)
    expect(result.dag.inputSchema).toBeDefined();
    expect(result.dag.inputSchema?.type).toBe("object");
    expect(result.dag.outputSchema).toBeDefined();
    expect(result.dag.outputSchema?.type).toBe("object");

    // No human-review on these nodes, no prompts referenced
    expect(result.dag.nodes.every((n) => !n.humanReview)).toBe(true);
    expect(result.dag.prompts).toEqual([]);
  });

  it("sets outputSchema from the output node's schema", async () => {
    const result = await runDescribe(fixturePath("valid-dag.ts"));
    if (!result.ok) throw new Error("describe should have succeeded");
    const props = result.dag.outputSchema?.properties as
      | Record<string, unknown>
      | undefined;
    expect(props).toBeDefined();
    expect(Object.keys(props ?? {})).toContain("summary");
  });

  it("returns null outputNodeId and null outputSchema when omitted from the DAG", async () => {
    const result = await runDescribe(fixturePath("no-explicit-output.ts"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both fields are explicitly `null` (not undefined / not missing) so LLM
    // tooling never has to branch on present-vs-missing.
    expect(result.dag.outputNodeId).toBeNull();
    expect(result.dag.outputSchema).toBeNull();
  });

  it("propagates lint errors as describe errors", async () => {
    // Uses a *separate* invalid-DAG fixture (`-2`) so this test doesn't share
    // a poisoned module-cache entry with the runLint test above. Bun caches
    // failed module evaluations by resolved path; re-importing the same path
    // returns a record with `default` in TDZ instead of re-throwing the
    // original DagDefinitionError.
    const result = await runDescribe(fixturePath("invalid-edge-typo-2.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.kind).toBe("dag-definition-error");
    }
  });
});

describe("runCapabilities", () => {
  it("lists exactly the built-in capability set with full metadata", () => {
    const result = runCapabilities();
    expect(result.ok).toBe(true);

    const names = result.builtin.map((c) => c.name);
    // Must match the registry's single source of truth — no more, no less.
    expect([...names].sort()).toEqual([...BUILTIN_CAPABILITY_KEYS].sort());

    // Every entry carries non-empty metadata.
    for (const entry of result.builtin) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.clientType.length).toBeGreaterThan(0);
      expect(entry.reference.length).toBeGreaterThan(0);
    }

    // Spot-check the load-bearing ones the docs lean on.
    const http = result.builtin.find((c) => c.name === "http");
    expect(http?.clientType).toBe("HttpCapability");
    const judge = result.builtin.find((c) => c.name === "judgeLlm");
    expect(judge?.clientType).toBe("LlmClient");
  });

  it("explains how to obtain custom (adapter-provided) capabilities", () => {
    const result = runCapabilities();
    expect(result.custom.mechanism).toContain("module augmentation");
    expect(result.custom.howToDeclare).toContain("requires");
    expect(result.custom.seeAlso).toContain("@fuguejs/framework/docs/adapter-authoring.md");
  });
});

describe("fugue bin (subprocess)", () => {
  it("lint exits 0 and emits ok JSON on a valid DAG", async () => {
    const { exitCode, stdout } = await runBin(["lint", fixturePath("valid-dag.ts")]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toContain("valid-dag.ts");
  });

  it("lint exits 1 and emits dag-definition-error on a broken DAG", async () => {
    const { exitCode, stdout } = await runBin(["lint", fixturePath("invalid-edge-typo.ts")]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].kind).toBe("dag-definition-error");
  });

  it("describe emits a full DAG manifest as JSON", async () => {
    const { exitCode, stdout } = await runBin(["describe", fixturePath("valid-dag.ts")]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.dag.id).toBe("valid-fixture");
    expect(parsed.dag.waves).toEqual([["fetch-user"], ["summarize"]]);
  });

  it("capabilities exits 0 and emits the built-in catalogue as JSON", async () => {
    const { exitCode, stdout } = await runBin(["capabilities"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.builtin.map((c: { name: string }) => c.name)).toContain("http");
    expect(parsed.custom.seeAlso).toContain("@fuguejs/framework/docs/adapter-authoring.md");
  });

  it("capabilities exits 2 when given an argument", async () => {
    const { exitCode, stderr } = await runBin(["capabilities", "some/path.ts"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("takes no arguments");
  });

  it("exits 2 with usage text on missing args", async () => {
    const { exitCode, stderr } = await runBin([]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Usage: fugue");
  });

  it("exits 2 on unknown command", async () => {
    const { exitCode, stderr } = await runBin(["bogus", fixturePath("valid-dag.ts")]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unknown command");
  });

  it("--help exits 0 with usage on stdout", async () => {
    const { exitCode, stdout } = await runBin(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: fugue");
  });

  it("-h exits 0 with usage on stdout", async () => {
    const { exitCode, stdout } = await runBin(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: fugue");
  });

  it("exits 2 with usage on missing <path>", async () => {
    const { exitCode, stderr } = await runBin(["lint"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Missing required <path>");
  });

  it("exits 2 when extra arguments are passed", async () => {
    const { exitCode, stderr } = await runBin([
      "lint",
      fixturePath("valid-dag.ts"),
      "leftover-arg",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unexpected extra arguments");
  });
});
