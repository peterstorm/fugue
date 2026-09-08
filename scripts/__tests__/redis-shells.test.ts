import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const waitForRedisScript = resolve(repoRoot, "scripts/wait-for-redis.sh");
const testRedisScript = resolve(repoRoot, "scripts/test-redis.sh");
const cleanupDirectories: string[] = [];

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

const executable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source);
  await chmod(path, 0o755);
};

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

type ShellResult = Readonly<{
  exitCode: number;
  stderr: string;
  log: readonly string[];
}>;

const runWaitForRedis = async (mode: "delayed-pong" | "permanent-error"): Promise<ShellResult> => {
  const directory = await mkdtemp(join(tmpdir(), "fugue-wait-redis-"));
  cleanupDirectories.push(directory);
  const logPath = join(directory, "commands.log");
  const countPath = join(directory, "count");
  await executable(
    join(directory, "redis-cli"),
    [
      "#!/bin/sh",
      "set -eu",
      "printf 'redis-cli:%s\\n' \"$*\" >> \"$COMMAND_LOG\"",
      "count=0",
      "if [ -f \"$COUNT_FILE\" ]; then count=$(cat \"$COUNT_FILE\"); fi",
      "count=$((count + 1))",
      "printf '%s' \"$count\" > \"$COUNT_FILE\"",
      "if [ \"$READINESS_MODE\" = delayed-pong ] && [ \"$count\" -ge 3 ]; then",
      "  printf 'PONG\\n'",
      "  exit 0",
      "fi",
      "exit 9",
      "",
    ].join("\n"),
  );
  await executable(join(directory, "sleep"), "#!/bin/sh\nexit 0\n");

  const child = Bun.spawn(["bash", waitForRedisScript, "redis://default:test-secret@127.0.0.1:6389"], {
    cwd: repoRoot,
    env: {
      ...inheritedEnvironment(),
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      COMMAND_LOG: logPath,
      COUNT_FILE: countPath,
      READINESS_MODE: mode,
      REDIS_READY_MAX_ATTEMPTS: "3",
      REDIS_READY_DELAY_SECONDS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const log = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  return { exitCode, stderr, log };
};

type LegacyOptions = Readonly<{
  podmanRunExit?: number;
  bunExit?: number;
  stopExit?: number;
  readiness?: "immediate" | "timeout";
}>;

const runLegacyRedis = async (options: LegacyOptions = {}): Promise<ShellResult> => {
  const directory = await mkdtemp(join(tmpdir(), "fugue-test-redis-"));
  cleanupDirectories.push(directory);
  const logPath = join(directory, "commands.log");
  await executable(
    join(directory, "podman"),
    [
      "#!/bin/sh",
      "set -eu",
      "printf 'podman:%s\\n' \"$*\" >> \"$COMMAND_LOG\"",
      "case \"${1:-}\" in",
      "  run)",
      "    if [ \"$PODMAN_RUN_EXIT\" -ne 0 ]; then exit \"$PODMAN_RUN_EXIT\"; fi",
      "    printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "    ;;",
      "  port) printf '127.0.0.1:49152\\n' ;;",
      "  stop) exit \"$PODMAN_STOP_EXIT\" ;;",
      "  *) exit 65 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await executable(
    join(directory, "redis-cli"),
    [
      "#!/bin/sh",
      "printf 'redis-cli:%s\\n' \"$*\" >> \"$COMMAND_LOG\"",
      "if [ \"$READINESS_MODE\" = immediate ]; then printf 'PONG\\n'; exit 0; fi",
      "exit 9",
      "",
    ].join("\n"),
  );
  await executable(
    join(directory, "bun"),
    [
      "#!/bin/sh",
      "printf 'bun:%s REDIS_URL=%s\\n' \"$*\" \"${REDIS_URL:-}\" >> \"$COMMAND_LOG\"",
      "exit \"$BUN_EXIT\"",
      "",
    ].join("\n"),
  );
  await executable(join(directory, "sleep"), "#!/bin/sh\nexit 0\n");

  const child = Bun.spawn(["bash", testRedisScript], {
    cwd: repoRoot,
    env: {
      ...inheritedEnvironment(),
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      COMMAND_LOG: logPath,
      PODMAN_RUN_EXIT: String(options.podmanRunExit ?? 0),
      PODMAN_STOP_EXIT: String(options.stopExit ?? 0),
      BUN_EXIT: String(options.bunExit ?? 0),
      READINESS_MODE: options.readiness ?? "immediate",
      REDIS_READY_MAX_ATTEMPTS: "2",
      REDIS_READY_DELAY_SECONDS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const log = await readFile(logPath, "utf8")
    .then((contents) => contents.trim().split("\n").filter(Boolean))
    .catch(() => []);
  return { exitCode, stderr, log };
};

describe("scripts/wait-for-redis.sh", () => {
  it("retries a delayed authenticated PONG before succeeding", async () => {
    const result = await runWaitForRedis("delayed-pong");
    expect(result.exitCode).toBe(0);
    expect(result.log).toHaveLength(3);
    expect(result.log.every((line) => line.includes("--no-auth-warning -u"))).toBe(true);
  });

  it("fails after the bounded attempts without exposing credentials", async () => {
    const result = await runWaitForRedis("permanent-error");
    expect(result.exitCode).not.toBe(0);
    expect(result.log).toHaveLength(3);
    expect(result.stderr).toContain("credentials withheld");
    expect(result.stderr).not.toContain("test-secret");
  });
});

describe("scripts/test-redis.sh", () => {
  it("uses an unnamed loopback ephemeral container and cleans up its exact ID", async () => {
    const result = await runLegacyRedis();
    expect(result.exitCode).toBe(0);
    expect(result.log[0]).toBe("podman:run --rm -d -p 127.0.0.1::6379 redis:7-alpine");
    expect(result.log).toContain("podman:port aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 6379/tcp");
    expect(result.log).toContain("bun:run --filter * test REDIS_URL=redis://127.0.0.1:49152");
    expect(result.log.at(-1)).toBe("podman:stop aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.log.join("\n")).not.toContain("--name");
  });

  it("preserves the workspace test failure while still cleaning up", async () => {
    const result = await runLegacyRedis({ bunExit: 23, stopExit: 31 });
    expect(result.exitCode).toBe(23);
    expect(result.log.at(-1)).toContain("podman:stop aaaaaaaaaaaa");
  });

  it("makes cleanup failure fail an otherwise green run", async () => {
    const result = await runLegacyRedis({ stopExit: 31 });
    expect(result.exitCode).toBe(31);
    expect(result.stderr).toContain("Failed to stop");
  });

  it("never stops a foreign container when creation fails", async () => {
    const result = await runLegacyRedis({ podmanRunExit: 29 });
    expect(result.exitCode).toBe(29);
    expect(result.log).toEqual([
      "podman:run --rm -d -p 127.0.0.1::6379 redis:7-alpine",
    ]);
  });

  it("bounds readiness failure and cleans up the created container", async () => {
    const result = await runLegacyRedis({ readiness: "timeout" });
    expect(result.exitCode).not.toBe(0);
    expect(result.log.filter((line) => line.startsWith("redis-cli:"))).toHaveLength(2);
    expect(result.log.some((line) => line.startsWith("bun:"))).toBe(false);
    expect(result.log.at(-1)).toContain("podman:stop aaaaaaaaaaaa");
  });

  const podmanUnavailable = Bun.which("podman") === null;
  it.skipIf(podmanUnavailable)(
    "runs the owned lifecycle against real Podman when Podman is available",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "fugue-real-podman-probe-"));
      cleanupDirectories.push(directory);
      await executable(join(directory, "bun"), "#!/bin/sh\nexit 0\n");
      const child = Bun.spawn(["bash", testRedisScript], {
        cwd: repoRoot,
        env: {
          ...inheritedEnvironment(),
          PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
          REDIS_READY_MAX_ATTEMPTS: "80",
          REDIS_READY_DELAY_SECONDS: "0.1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
    30_000,
  );
});
