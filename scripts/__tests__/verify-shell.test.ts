import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const verifyScript = resolve(import.meta.dir, "../verify.sh");
const cleanupDirectories: string[] = [];

const phases = [
  "run check:verification-prerequisites",
  "run typecheck",
  "run check:docs",
  "run test:scripts",
  "run test",
] as const;

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

type ShellResult = Readonly<{ exitCode: number; recorded: readonly string[] }>;

const runVerificationShell = async (failingPhase?: string): Promise<ShellResult> => {
  const directory = await mkdtemp(join(tmpdir(), "fugue-verify-shell-"));
  cleanupDirectories.push(directory);
  const recording = join(directory, "recording.txt");
  const fakeBun = join(directory, "bun");
  await writeFile(
    fakeBun,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$RECORDING_FILE\"",
      "if [ \"$*\" = \"${FAIL_COMMAND:-}\" ]; then exit 23; fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(fakeBun, 0o755);

  const child = Bun.spawn(["bash", verifyScript], {
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      RECORDING_FILE: recording,
      FAIL_COMMAND: failingPhase ?? "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  const recorded = (await readFile(recording, "utf8")).trim().split("\n").filter(Boolean);
  return { exitCode, recorded };
};

describe("scripts/verify.sh", () => {
  it("runs every verification phase in the mandated order", async () => {
    const result = await runVerificationShell();
    expect(result.exitCode).toBe(0);
    expect(result.recorded).toEqual(phases);
  });

  for (const [index, phase] of phases.entries()) {
    it(`fails closed at '${phase}' and does not run later phases`, async () => {
      const result = await runVerificationShell(phase);
      expect(result.exitCode).toBe(23);
      expect(result.recorded).toEqual(phases.slice(0, index + 1));
    });
  }
});
