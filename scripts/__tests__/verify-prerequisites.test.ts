import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseProductionBunVersion,
  requireMatchingBunVersion,
} from "../verify-prerequisites.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const preflight = resolve(repoRoot, "scripts/verify-prerequisites.ts");
const hostAclGate = resolve(
  repoRoot,
  "packages/host/src/__tests__/integration/isolation-redis-acl-real-server.test.ts",
);
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}>;

const environment = (overrides: Readonly<Record<string, string | null>>): Record<string, string> => {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const merged = new Map(inherited);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) merged.delete(key);
    else merged.set(key, value);
  }
  return Object.fromEntries(merged);
};

const runPreflight = async (
  overrides: Readonly<Record<string, string | null>>,
  script = preflight,
): Promise<CommandResult> => {
  const startedAt = performance.now();
  const child = Bun.spawn([process.execPath, script], {
    cwd: repoRoot,
    env: environment(overrides),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 6_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      elapsedMs: performance.now() - startedAt,
      timedOut,
    };
  } finally {
    clearTimeout(watchdog);
  }
};

const runHostAclGate = async (
  redisUrl: string | null,
): Promise<CommandResult & Readonly<{ output: string }>> => {
  const startedAt = performance.now();
  const child = Bun.spawn([process.execPath, "test", hostAclGate], {
    cwd: repoRoot,
    env: environment({ REDIS_URL: redisUrl }),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 6_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      output: `${stdout}\n${stderr}`,
      elapsedMs: performance.now() - startedAt,
      timedOut,
    };
  } finally {
    clearTimeout(watchdog);
  }
};

const linkPreflightRuntimeDependency = async (fixtureRoot: string): Promise<void> => {
  const fixtureNodeModules = join(fixtureRoot, "node_modules");
  await mkdir(fixtureNodeModules, { recursive: true });
  await symlink(resolve(repoRoot, "node_modules/ts-pattern"), join(fixtureNodeModules, "ts-pattern"));
};

const reserveTcpPort = (): number => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
};

const startRedisWireEndpoint = async (
  mode: "stall-after-hello" | "reject-ping",
): Promise<string> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (data) => {
      const command = data.toString();
      if (command.includes("HELLO")) socket.write("%0\r\n");
      if (mode === "reject-ping" && command.includes("PING")) {
        socket.write("-ERR private-wire-detail\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  cleanupTasks.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });
  return `redis://127.0.0.1:${address.port}`;
};

const probeWithoutWholeWatchdog = (
  redisUrl: string,
): Readonly<{ completion: Promise<void>; close: () => void }> => {
  const client = new Bun.RedisClient(redisUrl, {
    connectionTimeout: 250,
    autoReconnect: false,
    maxRetries: 0,
    enableOfflineQueue: false,
  });
  const completion = (async (): Promise<void> => {
    await client.connect();
    await client.send("PING", []);
    await client.send("ACL", ["CAT"]);
  })();
  return { completion, close: () => client.close() };
};

type RedisFixture = Readonly<{ url: string; password: string }>;

const startRedis = async (aclEnabled: boolean): Promise<RedisFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "fugue-verify-redis-"));
  const port = reserveTcpPort();
  const password = `verify-secret-${crypto.randomUUID()}`;
  const command = [
    "redis-server",
    "--bind", "127.0.0.1",
    "--port", String(port),
    "--save", "",
    "--appendonly", "no",
    "--dir", directory,
    "--requirepass", password,
  ];
  if (!aclEnabled) command.push("--rename-command", "ACL", "");

  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  cleanupTasks.push(async () => {
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  });

  const url = `redis://default:${encodeURIComponent(password)}@127.0.0.1:${port}`;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const client = new Bun.RedisClient(url, {
      connectionTimeout: 100,
      autoReconnect: false,
      maxRetries: 0,
      enableOfflineQueue: false,
    });
    try {
      await client.connect();
      if (await client.send("PING", []) === "PONG") return { url, password };
    } catch {
      await Bun.sleep(25);
    } finally {
      client.close();
    }
  }
  throw new Error("throwaway Redis did not become ready");
};

describe("production Bun version parsing", () => {
  it("parses the one exact production image", () => {
    const result = parseProductionBunVersion("# production\nFROM oven/bun:1.4.2-alpine\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value)).toBe("1.4.2");
  });

  it("rejects missing and ambiguous FROM instructions", () => {
    expect(parseProductionBunVersion("RUN echo no-base")).toEqual({
      ok: false,
      error: { kind: "docker-from-missing" },
    });
    expect(
      parseProductionBunVersion("FROM oven/bun:1.4.2-alpine\nFROM scratch AS output"),
    ).toEqual({ ok: false, error: { kind: "docker-from-ambiguous", count: 2 } });
  });

  it("rejects floating/non-production image tags and runtime mismatch", () => {
    expect(parseProductionBunVersion("FROM oven/bun:1.4-alpine")).toEqual({
      ok: false,
      error: { kind: "docker-image-invalid" },
    });
    const parsed = parseProductionBunVersion("FROM oven/bun:1.4.2-alpine");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const mismatch = requireMatchingBunVersion(parsed.value, "1.4.1");
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.kind).toBe("bun-version-mismatch");
    if (mismatch.error.kind !== "bun-version-mismatch") return;
    expect(String(mismatch.error.expected)).toBe("1.4.2");
    expect(mismatch.error.actual).toBe("1.4.1");
  });
});

describe("verification prerequisite subprocess", () => {
  it("fails when REDIS_URL is missing", async () => {
    const result = await runPreflight({ REDIS_URL: null });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("REDIS_URL must be non-empty");
  });

  it("fails when local TypeScript is absent instead of using a global or network fallback", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "fugue-verify-no-typescript-"));
    cleanupTasks.push(() => rm(fixtureRoot, { recursive: true, force: true }));
    const fixtureScript = join(fixtureRoot, "scripts/verify-prerequisites.ts");
    await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
    await mkdir(join(fixtureRoot, "packages/host"), { recursive: true });
    await copyFile(preflight, fixtureScript);
    await linkPreflightRuntimeDependency(fixtureRoot);
    await writeFile(
      join(fixtureRoot, "packages/host/Dockerfile"),
      `FROM oven/bun:${Bun.version}-alpine\n`,
    );

    const result = await runPreflight(
      { REDIS_URL: "redis://127.0.0.1:1" },
      fixtureScript,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("local TypeScript is missing");
  });

  it("rejects an HTTP REDIS_URL before client I/O without exposing it", async () => {
    const malformedUrl = "http://default:verification-secret@127.0.0.1:6379";
    const result = await runPreflight({ REDIS_URL: malformedUrl });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("valid redis:// or rediss:// URL");
    expect(result.stderr).not.toContain(malformedUrl);
    expect(result.stderr).not.toContain("verification-secret");
  });

  it("fails when the workspace compiler link is absent even if a global tsc is executable", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "fugue-verify-no-local-bin-"));
    cleanupTasks.push(() => rm(fixtureRoot, { recursive: true, force: true }));
    const fixtureScript = join(fixtureRoot, "scripts/verify-prerequisites.ts");
    const globalBin = join(fixtureRoot, "global-bin");
    const globalTsc = join(globalBin, "tsc");
    await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
    await mkdir(join(fixtureRoot, "packages/host"), { recursive: true });
    await mkdir(join(fixtureRoot, "node_modules/typescript/bin"), { recursive: true });
    await mkdir(globalBin, { recursive: true });
    await copyFile(preflight, fixtureScript);
    await linkPreflightRuntimeDependency(fixtureRoot);
    await writeFile(
      join(fixtureRoot, "packages/host/Dockerfile"),
      `FROM oven/bun:${Bun.version}-alpine\n`,
    );
    await writeFile(join(fixtureRoot, "node_modules/typescript/bin/tsc"), "owned compiler\n");
    await writeFile(globalTsc, "#!/bin/sh\nprintf 'global compiler available\\n'\n");
    await chmod(globalTsc, 0o755);

    const globalProbe = Bun.spawn(["tsc"], {
      env: environment({ PATH: globalBin }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await globalProbe.exited).toBe(0);
    expect(await new Response(globalProbe.stdout).text()).toContain("global compiler available");

    const result = await runPreflight(
      { PATH: globalBin, REDIS_URL: "redis://127.0.0.1:1" },
      fixtureScript,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("local TypeScript is missing or mislinked");
    expect(result.stderr).not.toContain("redis-server is required");
  });

  it("fails when redis-server is absent from PATH while Bun remains executable", async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), "fugue-verify-path-"));
    cleanupTasks.push(() => rm(emptyPath, { recursive: true, force: true }));
    const result = await runPreflight({ PATH: emptyPath, REDIS_URL: "redis://127.0.0.1:1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("redis-server is required in PATH");
  });

  it("fails closed against a closed endpoint within the watchdog", async () => {
    const result = await runPreflight({ REDIS_URL: "redis://127.0.0.1:1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeLessThan(4_000);
    expect(result.stderr).toContain("Redis connect probe failed");
    expect(result.stderr).toContain("URL, credentials, and server details withheld");
  });

  it("reports a credential-safe PING stage without the server's message", async () => {
    const rejectingUrl = await startRedisWireEndpoint("reject-ping");
    const result = await runPreflight({ REDIS_URL: rejectingUrl });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Redis ping probe failed");
    expect(result.stderr).not.toContain("private-wire-detail");
  });

  it("uses the whole-probe watchdog when a connected peer never answers Redis commands", async () => {
    const stalledUrl = await startRedisWireEndpoint("stall-after-hello");
    const counterfactual = probeWithoutWholeWatchdog(stalledUrl);
    const counterfactualOutcome = await Promise.race([
      counterfactual.completion.then(() => "completed" as const),
      Bun.sleep(600).then(() => "external-bound" as const),
    ]);
    expect(counterfactualOutcome).toBe("external-bound");
    counterfactual.close();
    await counterfactual.completion.catch(() => undefined);

    const result = await runPreflight({ REDIS_URL: stalledUrl });
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeGreaterThan(1_500);
    expect(result.elapsedMs).toBeLessThan(4_000);
    expect(result.stderr).toContain("Redis timeout probe failed");
  });

  it("authenticates, proves PING plus ACL CAT, and exits without retaining a client handle", async () => {
    const redis = await startRedis(true);
    const result = await runPreflight({ REDIS_URL: redis.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Verification prerequisites satisfied");
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeLessThan(4_000);
  });

  it("rejects wrong authentication without exposing the URL or password", async () => {
    const redis = await startRedis(true);
    const wrongUrl = redis.url.replace(encodeURIComponent(redis.password), "wrong-password");
    const result = await runPreflight({ REDIS_URL: wrongUrl });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain(redis.password);
    expect(result.stderr).not.toContain("wrong-password");
    expect(result.stderr).not.toContain(wrongUrl);
    expect(result.stderr).toContain("Redis connect probe failed");
    expect(result.stderr).toContain("URL, credentials, and server details withheld");
  });

  it("rejects a real Redis server where ACL CAT is unavailable", async () => {
    const redis = await startRedis(false);
    const result = await runPreflight({ REDIS_URL: redis.url });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Redis acl-cat probe failed");
    expect(result.stderr).not.toContain(redis.password);
  });
});

describe("configured host Redis ACL gate subprocess", () => {
  it("deliberately skips only when REDIS_URL is absent", async () => {
    const result = await runHostAclGate(null);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("10 skip");
  });

  it("fails rather than reporting all-skipped green for a configured closed endpoint", async () => {
    const port = reserveTcpPort();
    const result = await runHostAclGate(`redis://127.0.0.1:${port}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).not.toContain("10 skip");
  });

  it("fails rather than reporting all-skipped green for configured broken authentication", async () => {
    const redis = await startRedis(true);
    const wrongUrl = redis.url.replace(encodeURIComponent(redis.password), "wrong-host-password");
    const result = await runHostAclGate(wrongUrl);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).not.toContain("10 skip");
    expect(result.output).not.toContain(redis.password);
    expect(result.output).not.toContain("wrong-host-password");
  });

  it("fails rather than skipping when configured Redis lacks ACL capability", async () => {
    const redis = await startRedis(false);
    const result = await runHostAclGate(redis.url);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).not.toContain("10 skip");
    expect(result.output).not.toContain(redis.password);
  });
});
