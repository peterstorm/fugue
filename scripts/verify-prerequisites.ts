import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { match } from "ts-pattern";

type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

type BunVersion = string & { readonly __brand: "BunVersion" };
type RedisUrl = string & { readonly __brand: "RedisUrl" };
type RedisProbeStage = "connect" | "ping" | "acl-cat" | "timeout";

type PrerequisiteError =
  | { readonly kind: "docker-from-missing" }
  | { readonly kind: "docker-from-ambiguous"; readonly count: number }
  | { readonly kind: "docker-image-invalid" }
  | { readonly kind: "bun-version-mismatch"; readonly expected: BunVersion; readonly actual: string }
  | { readonly kind: "typescript-missing" }
  | { readonly kind: "redis-server-missing" }
  | { readonly kind: "redis-url-missing" }
  | { readonly kind: "redis-url-invalid" }
  | { readonly kind: "redis-probe-failed"; readonly stage: RedisProbeStage }
  | { readonly kind: "preflight-failed" };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

const BUN_IMAGE = /^oven\/bun:(\d+\.\d+\.\d+)-alpine$/;
const PROBE_TIMEOUT_MS = 2_000;

export const parseProductionBunVersion = (
  dockerfile: string,
): Result<BunVersion, PrerequisiteError> => {
  const images = dockerfile
    .split("\n")
    .map((line) => line.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$/i)?.[1])
    .filter((image): image is string => image !== undefined);

  if (images.length === 0) return err({ kind: "docker-from-missing" });
  if (images.length !== 1) return err({ kind: "docker-from-ambiguous", count: images.length });

  const version = images[0]!.match(BUN_IMAGE)?.[1];
  return version === undefined
    ? err({ kind: "docker-image-invalid" })
    : ok(version as BunVersion);
};

export const requireMatchingBunVersion = (
  expected: BunVersion,
  actual: string,
): Result<BunVersion, PrerequisiteError> =>
  actual === expected
    ? ok(expected)
    : err({ kind: "bun-version-mismatch", expected, actual });

const parseRedisUrl = (raw: string | undefined): Result<RedisUrl, PrerequisiteError> => {
  const candidate = raw?.trim();
  if (candidate === undefined || candidate === "") return err({ kind: "redis-url-missing" });

  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "redis:" || parsed.protocol === "rediss:")
      && parsed.hostname !== ""
      ? ok(candidate as RedisUrl)
      : err({ kind: "redis-url-invalid" });
  } catch {
    return err({ kind: "redis-url-invalid" });
  }
};

const probeRedis = async (redisUrl: RedisUrl): Promise<Result<void, PrerequisiteError>> => {
  const client = new Bun.RedisClient(redisUrl, {
    connectionTimeout: 250,
    autoReconnect: false,
    maxRetries: 0,
    enableOfflineQueue: false,
  });
  let stage: Exclude<RedisProbeStage, "timeout"> = "connect";
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const probe = async (): Promise<Result<void, PrerequisiteError>> => {
    try {
      await client.connect();
      stage = "ping";
      const pong: unknown = await client.send("PING", []);
      if (pong !== "PONG") return err({ kind: "redis-probe-failed", stage });

      stage = "acl-cat";
      const aclCategories: unknown = await client.send("ACL", ["CAT"]);
      return Array.isArray(aclCategories) && aclCategories.length > 0
        ? ok(undefined)
        : err({ kind: "redis-probe-failed", stage });
    } catch {
      return err({ kind: "redis-probe-failed", stage });
    }
  };

  try {
    return await Promise.race([
      probe(),
      new Promise<Result<void, PrerequisiteError>>((resolveTimeout) => {
        watchdog = setTimeout(
          () => resolveTimeout(err({ kind: "redis-probe-failed", stage: "timeout" })),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    client.close();
  }
};

const messageFor = (error: PrerequisiteError): string =>
  match(error)
    .with(
      { kind: "docker-from-missing" },
      () => "packages/host/Dockerfile must contain one production FROM image",
    )
    .with(
      { kind: "docker-from-ambiguous" },
      ({ count }) => `packages/host/Dockerfile must contain one production FROM image; found ${count}`,
    )
    .with(
      { kind: "docker-image-invalid" },
      () => "packages/host/Dockerfile must use an exact oven/bun:<major.minor.patch>-alpine image",
    )
    .with(
      { kind: "bun-version-mismatch" },
      ({ expected, actual }) => `Bun ${expected} is required by packages/host/Dockerfile; found ${actual}`,
    )
    .with(
      { kind: "typescript-missing" },
      () => "local TypeScript is missing or mislinked; run bun install --frozen-lockfile",
    )
    .with({ kind: "redis-server-missing" }, () => "redis-server is required in PATH")
    .with({ kind: "redis-url-missing" }, () => "REDIS_URL must be non-empty")
    .with(
      { kind: "redis-url-invalid" },
      () => "REDIS_URL must be a valid redis:// or rediss:// URL (value and credentials withheld)",
    )
    .with(
      { kind: "redis-probe-failed" },
      ({ stage }) => `Redis ${stage} probe failed; authentication, PING, and ACL CAT are required (URL, credentials, and server details withheld)`,
    )
    .with(
      { kind: "preflight-failed" },
      () => "preflight could not inspect the repository (sensitive details withheld)",
    )
    .exhaustive();

const repoRoot = resolve(import.meta.dir, "..");

const hasMatchingLocalCompiler = async (): Promise<boolean> => {
  try {
    const [binCompiler, ownedCompiler] = await Promise.all([
      realpath(resolve(repoRoot, "node_modules/.bin/tsc")),
      realpath(resolve(repoRoot, "node_modules/typescript/bin/tsc")),
    ]);
    return binCompiler === ownedCompiler;
  } catch {
    return false;
  }
};

const run = async (): Promise<Result<void, PrerequisiteError>> => {
  const dockerfile = await readFile(resolve(repoRoot, "packages/host/Dockerfile"), "utf8");
  const parsedVersion = parseProductionBunVersion(dockerfile);
  if (!parsedVersion.ok) return parsedVersion;

  const matchedVersion = requireMatchingBunVersion(parsedVersion.value, Bun.version);
  if (!matchedVersion.ok) return matchedVersion;

  if (!(await hasMatchingLocalCompiler())) return err({ kind: "typescript-missing" });
  if (Bun.which("redis-server") === null) return err({ kind: "redis-server-missing" });

  const redisUrl = parseRedisUrl(process.env.REDIS_URL);
  if (!redisUrl.ok) return redisUrl;
  return probeRedis(redisUrl.value);
};

if (import.meta.main) {
  const result = await run().catch(() => err<PrerequisiteError>({ kind: "preflight-failed" }));
  if (!result.ok) {
    console.error(`Verification prerequisite failed: ${messageFor(result.error)}`);
    process.exit(1);
  }
  process.stdout.write("Verification prerequisites satisfied.\n");
}
