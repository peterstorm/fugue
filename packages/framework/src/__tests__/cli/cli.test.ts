import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { runLint } from "../../cli/lint.js";
import { runDescribe } from "../../cli/describe.js";

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

    // 1 edge
    expect(result.dag.edges).toHaveLength(1);
    expect(result.dag.edges[0]).toMatchObject({
      from: "fetch-user",
      to: "summarize",
      kind: "unconditional",
    });

    // Two waves: [[fetch-user], [summarize]]
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
});
