import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { parseProductionBunVersion } from "../verify-prerequisites.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const workflowPath = (name: string): string => resolve(repoRoot, ".github/workflows", name);
const readWorkflowText = (name: string): string => readFileSync(workflowPath(name), "utf8");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be a YAML mapping`);
  return value;
};

const list = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be a YAML sequence`);
  return value;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
};

const workflow = (name: string): Record<string, unknown> =>
  record(parse(readWorkflowText(name)), name);

const jobsOf = (document: Record<string, unknown>): Record<string, unknown> =>
  record(document.jobs, "jobs");

const jobOf = (
  document: Record<string, unknown>,
  name: string,
): Record<string, unknown> => record(jobsOf(document)[name], `jobs.${name}`);

const stepsOf = (job: Record<string, unknown>): readonly Record<string, unknown>[] =>
  list(job.steps, "job steps").map((step, index) => record(step, `steps[${index}]`));

const namedStep = (
  job: Record<string, unknown>,
  name: string,
): Record<string, unknown> => {
  const found = stepsOf(job).find((step) => step.name === name);
  if (found === undefined) throw new Error(`missing workflow step '${name}'`);
  return found;
};

const setupBunVersion = (job: Record<string, unknown>): string => {
  const setup = stepsOf(job).find((step) => step.uses === "oven-sh/setup-bun@v2");
  if (setup === undefined) throw new Error("missing setup-bun step");
  return text(record(setup.with, "setup-bun.with")["bun-version"], "bun-version");
};

const expectedProductionBunVersion = (): string => {
  const dockerfile = readFileSync(resolve(repoRoot, "packages/host/Dockerfile"), "utf8");
  const parsed = parseProductionBunVersion(dockerfile);
  if (!parsed.ok) throw new Error(`production Dockerfile version parse failed: ${parsed.error.kind}`);
  return parsed.value;
};

type BuildableTestLeaf = Readonly<{
  manifestPath: string;
  testScript: string;
}>;

const buildableTestLeaves = (): readonly BuildableTestLeaf[] => {
  const rootManifest = record(
    JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")),
    "package.json",
  );
  const workspacePatterns = list(rootManifest.workspaces, "package.json workspaces")
    .map((pattern, index) => text(pattern, `workspaces[${index}]`));
  const manifestPaths = workspacePatterns
    .flatMap((pattern) => [
      ...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot, onlyFiles: true }),
    ])
    .sort();

  return manifestPaths.flatMap((manifestPath): readonly BuildableTestLeaf[] => {
    const directory = resolve(repoRoot, dirname(manifestPath));
    const manifest = record(
      JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8")),
      manifestPath,
    );
    const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
    if (scripts.build !== "tsc" || typeof scripts.test !== "string") return [];

    const tsconfig = record(
      JSON.parse(readFileSync(resolve(directory, "tsconfig.json"), "utf8")),
      `${dirname(manifestPath)}/tsconfig.json`,
    );
    const compilerOptions = record(tsconfig.compilerOptions, "tsconfig compilerOptions");
    const emittedTests = [
      ...new Bun.Glob("src/**/*.test.ts").scanSync({ cwd: directory, onlyFiles: true }),
    ];
    return compilerOptions.outDir === "dist" && emittedTests.length > 0
      ? [{ manifestPath, testScript: scripts.test }]
      : [];
  });
};

const runFixtureTest = async (cwd: string): Promise<Readonly<{
  exitCode: number;
  output: string;
}>> => {
  const child = Bun.spawn([process.execPath, "run", "test"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
};

describe("root verification authority", () => {
  it("delegates to every workspace and repository-owned local TypeScript", () => {
    const manifest = record(
      JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")),
      "package.json",
    );
    const scripts = record(manifest.scripts, "package.json scripts");
    const devDependencies = record(manifest.devDependencies, "package.json devDependencies");
    expect(scripts.verify).toBe("bash scripts/verify.sh");
    expect(scripts.typecheck).toBe(
      "bun run --filter '*' typecheck && bun run typecheck:scripts",
    );
    expect(scripts["typecheck:scripts"]).toBe(
      "bun ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.scripts.json",
    );
    expect(scripts.test).toBe("bun run --filter '*' test");
    expect(scripts["test:redis"]).toBe("bash scripts/test-redis.sh");
    expect(devDependencies["@types/bun"]).toBe("1.4.1");
  });
});

describe("buildable leaf test scope", () => {
  it("keeps every compile-to-dist leaf scoped to source tests", () => {
    const leaves = buildableTestLeaves();
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      expect(leaf.testScript).toBe("bun test --path-ignore-patterns='dist/**'");
    }
  });

  it("ignores a failing compiled dist test but still rejects a failing source test", async () => {
    const leaf = buildableTestLeaves()[0];
    if (leaf === undefined) throw new Error("expected at least one buildable test leaf");

    const fixture = mkdtempSync(join(tmpdir(), "fugue-leaf-test-scope-"));
    try {
      mkdirSync(resolve(fixture, "src"));
      mkdirSync(resolve(fixture, "dist"));
      writeFileSync(
        resolve(fixture, "package.json"),
        JSON.stringify({ private: true, scripts: { test: leaf.testScript } }),
      );
      writeFileSync(
        resolve(fixture, "src/current.test.ts"),
        'import { expect, test } from "bun:test"; test("current source", () => expect(true).toBe(true));\n',
      );
      writeFileSync(
        resolve(fixture, "dist/stale.test.js"),
        'import { expect, test } from "bun:test"; test("stale dist", () => expect(true).toBe(false));\n',
      );

      const staleDistResult = await runFixtureTest(fixture);
      expect(staleDistResult.exitCode).toBe(0);
      expect(staleDistResult.output).not.toContain("stale dist");

      writeFileSync(
        resolve(fixture, "src/current.test.ts"),
        'import { expect, test } from "bun:test"; test("current source", () => expect(true).toBe(false));\n',
      );
      const currentSourceResult = await runFixtureTest(fixture);
      expect(currentSourceResult.exitCode).not.toBe(0);
      expect(currentSourceResult.output).toContain("current source");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("reusable verification workflow", () => {
  it("is workflow_call-only and owns exactly the workspace and Oracle gates", () => {
    const verify = workflow("verify.yml");
    expect(Object.keys(record(verify.on, "verify.on"))).toEqual(["workflow_call"]);
    expect(Object.keys(jobsOf(verify)).sort()).toEqual([
      "original-image-oracle-smoke",
      "workspace-gate",
    ]);
  });

  it("runs the authoritative gate against an authenticated disposable Redis", () => {
    const gate = jobOf(workflow("verify.yml"), "workspace-gate");
    const redisStartup = text(
      namedStep(gate, "Start disposable Redis").run,
      "Start disposable Redis.run",
    );
    const verifyStep = namedStep(gate, "Verify repository");

    expect(setupBunVersion(gate)).toBe(expectedProductionBunVersion());
    expect(redisStartup).toContain("--bind 127.0.0.1");
    expect(redisStartup).toContain("--port 6389");
    expect(redisStartup).toContain("--requirepass 'fugue-ci-test-password'");
    const readiness = "bash scripts/wait-for-redis.sh 'redis://default:fugue-ci-test-password@127.0.0.1:6389'";
    const exportedUrl = "'REDIS_URL=redis://default:fugue-ci-test-password@127.0.0.1:6389'";
    expect(redisStartup).toContain(readiness);
    expect(redisStartup).toContain(exportedUrl);
    expect(redisStartup.indexOf(readiness)).toBeLessThan(redisStartup.indexOf(exportedUrl));
    expect(redisStartup).not.toContain("${{");
    expect(verifyStep.run).toBe("bun run verify");
    const workflowText = readWorkflowText("verify.yml");
    expect(workflowText).not.toContain("for pkg in");
    expect(workflowText).not.toContain("continue-on-error");
  });

  it("preserves the original production-image Oracle smoke", () => {
    const oracle = jobOf(workflow("verify.yml"), "original-image-oracle-smoke");
    const container = record(oracle.container, "oracle.container");
    expect(container.image).toBe("oven/bun:1.4.2-alpine");
    expect(stepsOf(oracle).some((step) => step.run === "bun scripts/oracle-driver-smoke.ts")).toBe(true);
  });

  it("pins every workflow runtime to the production Dockerfile", () => {
    const expected = expectedProductionBunVersion();
    const verify = workflow("verify.yml");
    const release = workflow("release.yaml");
    expect(setupBunVersion(jobOf(verify, "workspace-gate"))).toBe(expected);
    expect(setupBunVersion(jobOf(release, "publish"))).toBe(expected);
    expect(
      record(jobOf(verify, "original-image-oracle-smoke").container, "oracle.container").image,
    ).toBe(`oven/bun:${expected}-alpine`);
  });
});

describe("verification workflow callers", () => {
  it("keeps CI as a thin caller of the shared workflow", () => {
    const ci = workflow("ci.yml");
    expect(Object.keys(jobsOf(ci))).toEqual(["verification"]);
    expect(jobOf(ci, "verification").uses).toBe("./.github/workflows/verify.yml");
    expect(readWorkflowText("ci.yml")).not.toContain("bun run");
  });

  it("makes release depend on the same shared verification", () => {
    const release = workflow("release.yaml");
    expect(jobOf(release, "verification").uses).toBe("./.github/workflows/verify.yml");
    expect(jobOf(release, "publish").needs).toBe("verification");
  });
});

describe("release dry-run and artifact gates", () => {
  it("requires a manual release-tag supplied through workflow data", () => {
    const release = workflow("release.yaml");
    const dispatch = record(record(release.on, "release.on").workflow_dispatch, "workflow_dispatch");
    const inputs = record(dispatch.inputs, "workflow_dispatch.inputs");
    const releaseTag = record(inputs["release-tag"], "release-tag");
    expect(releaseTag.required).toBe(true);
    expect(releaseTag.type).toBe("string");
    expect(record(release.env, "release.env").EXPECTED_RELEASE_TAG).toContain("inputs['release-tag']");
    expect(readWorkflowText("release.yaml")).not.toContain("${{ inputs.release-tag }}");
  });

  it("validates every tarball before the separate push-tag-only publish step", () => {
    const release = workflow("release.yaml");
    expect(record(release.env, "release.env").PACKAGES).toBe(
      "framework document-source xlsx adapter-fs adapter-ms-graph adapter-pg adapter-oracle http-auth host",
    );
    const publishJob = jobOf(release, "publish");
    const steps = stepsOf(publishJob);
    const prepare = namedStep(publishJob, "Prepare and validate all release tarballs");
    const publish = namedStep(
      publishJob,
      "Publish validated tarballs (skip versions already on the registry)",
    );
    expect(steps.indexOf(prepare)).toBeLessThan(steps.indexOf(publish));
    expect(text(prepare.run, "prepare.run")).toContain("bun pm pack");
    expect(text(prepare.run, "prepare.run")).toContain("tar -xzOf");
    expect(text(prepare.run, "prepare.run")).not.toContain("npm publish");
    expect(publish.if).toBe("github.event_name == 'push' && github.ref_type == 'tag'");
    expect(text(publish.run, "publish.run")).toContain("npm view");
    expect(text(publish.run, "publish.run")).toContain("npm publish");
    expect(text(publish.run, "publish.run")).not.toContain("bun pm pack");
  });

  it("contains no blanket verification waiver or test-budget override", () => {
    const allWorkflowText = ["verify.yml", "ci.yml", "release.yaml"]
      .map(readWorkflowText)
      .join("\n");
    expect(allWorkflowText).not.toContain("continue-on-error");
    expect(allWorkflowText).not.toContain("--timeout");
    expect(allWorkflowText).not.toContain("test.skip");
  });
});
