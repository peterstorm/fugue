/**
 * Filesystem durability primitives for the file backend.
 *
 * `atomicWriteFile` commits by caller-owned unique same-directory tmp + rename.
 *
 * `withFileLock` uses a rename-born owner directory plus a permanent sibling
 * fence directory (`<lockPath>.fence`). Every prospective birth publishes a
 * unique birth intent before checking for reapers. Every stale reaper
 * publishes a unique reap intent and waits for all pre-existing births to
 * finish before making its final stale decision. New births observe the reap
 * intent and stand down. Consequently the owner pathname is stable between
 * the fenced stale probe and rename: a reaper can never move, delete, or fail
 * to restore a newly born live owner. Unexpected owner-metadata/process-probe
 * failures remain live (fail closed) and are warned. Release is silent only
 * for an absent lock or a proven ownership mismatch; an ownership-read or
 * owned-directory removal failure throws a typed `FrameworkError`. If the
 * critical section already failed, that primary failure remains authoritative
 * while the release failure is reported through a total, logger-safe warning.
 *
 * Intents are uniquely named and never reused, so dead-process intents can be
 * removed without the compare/delete race that affects a reusable lock path.
 * Reaper tombs are reconciled before births; a live tomb that cannot be
 * restored blocks acquisition rather than permitting overlapping critical
 * sections. Release checks both pid and the acquisition's plain ownership
 * token. A branded lease type may be introduced in a future API revision; it
 * is deliberately not part of this internal primitive's current surface.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ErrorCodeProbe,
  probeErrorCode,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
} from "../types/safe-error.js";
import {
  fileOperationError,
  fileThrownValueMessage,
  warnWithoutThrowing,
} from "./boundary-error.js";

let tokenCounter = 0;
const uniqueToken = (): string =>
  `${process.pid}-${Date.now()}-${tokenCounter++}-${Math.random().toString(36).slice(2)}`;

/** Test-only deterministic temp-path hook; production calls always mint a unique path. */
export interface AtomicWriteFileTestHooks {
  readonly temporaryPath?: (targetPath: string) => string;
}

export const atomicWriteFile = (
  path: string,
  contents: string,
  hooks: AtomicWriteFileTestHooks = {},
): void => {
  let temporary: string | null = null;
  try {
    if (typeof path !== "string" || path.length === 0 || path.includes("\u0000")) {
      throw "path must be a non-empty NUL-free string";
    }
    if (typeof contents !== "string") {
      throw "contents must be a string";
    }
    temporary = hooks.temporaryPath?.(path) ?? `${path}.tmp.${uniqueToken()}`;
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } catch (error) {
    if (temporary !== null) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch (cleanupError) {
        warnWithoutThrowing(
          `[AtomicWrite] failed to unlink tmp ${temporary} after a failed write: ${safeErrorMessage(cleanupError)}`,
        );
      }
    }
    throw fileOperationError("atomicWriteFile", path, error);
  }
};

const MAX_ACQUIRE_ATTEMPTS = 50;
const RETRY_MS = 100;
const PID_FILE = "pid";
const OWNER_FILE = "owner";
const BIRTH_PREFIX = "birth-";
const REAP_PREFIX = "reap-";
const TOMB_PREFIX = "tomb-";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errnoOf = (error: unknown): string | undefined => {
  const probe = probeErrorCode(error);
  return probe.kind === "code" ? probe.code : undefined;
};

const fencePathOf = (lockPath: string): string => `${lockPath}.fence`;

/** Test-only scheduling and deterministic diagnostics hooks. */
export interface FileLockTestHooks {
  readonly afterUnfencedStaleProbe?: () => void | Promise<void>;
  readonly afterFenceEstablished?: () => void | Promise<void>;
  readonly afterStableOwnerProbe?: (stale: boolean) => void | Promise<void>;
  readonly afterVictimRename?: () => void | Promise<void>;
  readonly readOwnerPid?: (ownerPath: string) => string;
  readonly probeOwnerProcess?: (pid: number) => void;
  readonly readOwnershipToken?: (ownerPath: string) => string;
  readonly inspectReleasePath?: (lockPath: string) => void;
}

type OwnerProbeResult =
  | Readonly<{ stale: true; diagnostic?: never }>
  | Readonly<{ stale: false; diagnostic?: string }>;

const warnUnexpectedOwnerFailure = (
  ownerPath: string,
  operation: "read pid metadata" | "probe owner process",
  error: unknown,
  probe: ErrorCodeProbe,
): string => {
  const diagnostic = `could not ${operation} for ${ownerPath}: ${safeErrorMessageWithCodeProbe(error, probe)}`;
  warnWithoutThrowing(`[FileLock] ${diagnostic}; treating owner as live`);
  return diagnostic;
};

const ownerStaleness = (
  ownerPath: string,
  hooks: FileLockTestHooks = {},
): OwnerProbeResult => {
  let rawPid: string;
  try {
    rawPid = hooks.readOwnerPid?.(ownerPath)
      ?? readFileSync(join(ownerPath, PID_FILE), "utf-8");
  } catch (error) {
    const probe = probeErrorCode(error);
    // A missing pid is a legacy/torn owner. Every other metadata failure is
    // insufficient evidence of death: warn with the cause and fail closed.
    if (probe.kind === "code" && probe.code === "ENOENT") return { stale: true };
    return {
      stale: false,
      diagnostic: warnUnexpectedOwnerFailure(ownerPath, "read pid metadata", error, probe),
    };
  }

  const pid = Number(rawPid.trim());
  if (!Number.isInteger(pid) || pid <= 0) return { stale: true };

  try {
    if (hooks.probeOwnerProcess !== undefined) hooks.probeOwnerProcess(pid);
    else process.kill(pid, 0);
    return { stale: false };
  } catch (error) {
    const probe = probeErrorCode(error);
    if (probe.kind === "code" && probe.code === "ESRCH") return { stale: true };
    // EPERM is expected proof that another user's process exists. Any other
    // probe failure remains fail-closed but explains why acquisition blocked.
    if (probe.kind === "code" && probe.code === "EPERM") return { stale: false };
    return {
      stale: false,
      diagnostic: warnUnexpectedOwnerFailure(ownerPath, "probe owner process", error, probe),
    };
  }
};

const removeUniqueProtocolEntry = (path: string, description: string): void => {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    warnWithoutThrowing(
      `[FileLock] failed to remove ${description} ${path}: ${safeErrorMessage(error)}`,
    );
  }
};

/** Publish a fully initialized, uniquely named protocol intent atomically. */
const createIntent = (lockPath: string, kind: "birth" | "reap"): string => {
  const fencePath = fencePathOf(lockPath);
  try {
    mkdirSync(fencePath);
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw error;
  }
  const staging = mkdtempSync(`${lockPath}.${kind}-intent-`);
  const published = join(fencePath, `${kind}-intent-${uniqueToken()}`);
  try {
    writeFileSync(join(staging, PID_FILE), `${process.pid}`);
    renameSync(staging, published);
    return published;
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      warnWithoutThrowing(
        `[FileLock] failed to remove ${kind} intent staging ${staging}: ${safeErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
};

const protocolEntries = (lockPath: string, prefix: string): readonly string[] => {
  const fencePath = fencePathOf(lockPath);
  if (!existsSync(fencePath)) return [];
  return readdirSync(fencePath)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(fencePath, name));
};

/**
 * Remove only dead owners of uniquely named intents. Unlike the reusable
 * canonical lock path, an intent path is never re-born, so this cleanup
 * cannot target a later contender.
 */
const activeIntents = (
  lockPath: string,
  prefix: string,
  hooks: FileLockTestHooks = {},
): readonly string[] => {
  const active: string[] = [];
  for (const intent of protocolEntries(lockPath, prefix)) {
    if (ownerStaleness(intent, hooks).stale) {
      removeUniqueProtocolEntry(intent, "stale protocol intent");
    } else {
      active.push(intent);
    }
  }
  return active;
};

const tryBirthOwner = (lockPath: string, ownershipToken: string): boolean => {
  const staging = mkdtempSync(`${lockPath}.birth-`);
  try {
    writeFileSync(join(staging, PID_FILE), `${process.pid}`);
    writeFileSync(join(staging, OWNER_FILE), ownershipToken);
    renameSync(staging, lockPath);
    return true;
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      warnWithoutThrowing(
        `[FileLock] failed to remove birth staging ${staging} after a failed birth: ${safeErrorMessage(cleanupError)}`,
      );
    }
    const code = errnoOf(error);
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
};

/**
 * Birth with a two-party fence handshake. A reaper that appears after our
 * check must observe this birth intent and wait; a reaper already published
 * makes us stand down before touching the canonical owner path.
 */
const tryFencedBirth = (
  lockPath: string,
  ownershipToken: string,
  hooks: FileLockTestHooks = {},
): boolean => {
  const intent = createIntent(lockPath, "birth");
  try {
    if (activeIntents(lockPath, `${REAP_PREFIX}intent-`, hooks).length > 0) return false;
    if (protocolEntries(lockPath, TOMB_PREFIX).length > 0) return false;
    return tryBirthOwner(lockPath, ownershipToken);
  } finally {
    removeUniqueProtocolEntry(intent, "birth intent");
  }
};

const waitForBirthBarrier = async (
  lockPath: string,
  hooks: FileLockTestHooks = {},
): Promise<boolean> => {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    if (activeIntents(lockPath, `${BIRTH_PREFIX}intent-`, hooks).length === 0) return true;
    await sleep(RETRY_MS);
  }
  return false;
};

/**
 * Recover tombs left by a reaper crash while all births are fenced. Stale
 * tombs are disposable. A live tomb is restored only into an empty owner
 * path; if another owner exists it remains as a durable fail-closed fence.
 */
const reconcileTombs = (
  lockPath: string,
  hooks: FileLockTestHooks = {},
): boolean => {
  for (const tomb of protocolEntries(lockPath, TOMB_PREFIX)) {
    if (ownerStaleness(tomb, hooks).stale) {
      removeUniqueProtocolEntry(tomb, "stale lock tomb");
      continue;
    }
    if (!existsSync(lockPath)) {
      try {
        renameSync(tomb, lockPath);
      } catch (error) {
        if (errnoOf(error) !== "ENOENT" && errnoOf(error) !== "EEXIST" && errnoOf(error) !== "ENOTEMPTY") {
          throw error;
        }
      }
    }
  }
  return protocolEntries(lockPath, TOMB_PREFIX).length === 0;
};

/**
 * Permanently fenced stale recovery. The final stale probe occurs only after
 * the reap intent is visible and every earlier birth intent has drained.
 * Therefore no new owner can appear between that probe and the victim rename.
 */
const fencedReap = async (
  lockPath: string,
  hooks: FileLockTestHooks = {},
): Promise<boolean> => {
  const intent = createIntent(lockPath, "reap");
  try {
    if (!(await waitForBirthBarrier(lockPath, hooks))) return false;
    await hooks.afterFenceEstablished?.();

    if (!reconcileTombs(lockPath, hooks)) return false;
    if (!existsSync(lockPath)) return true;

    const stale = ownerStaleness(lockPath, hooks).stale;
    await hooks.afterStableOwnerProbe?.(stale);
    if (!stale) return false;

    const tomb = join(fencePathOf(lockPath), `${TOMB_PREFIX}${uniqueToken()}`);
    try {
      renameSync(lockPath, tomb);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return false;
      throw error;
    }
    await hooks.afterVictimRename?.();

    // Defense in depth against PID reuse or a legacy owner becoming readable:
    // never delete a tomb that now proves live. Births are still fenced, so a
    // restore cannot race a newly born owner.
    if (!ownerStaleness(tomb, hooks).stale) {
      try {
        renameSync(tomb, lockPath);
      } catch (error) {
        warnWithoutThrowing(
          `[FileLock] could not restore live lock tomb ${tomb} to ${lockPath}; acquisition remains fenced: ${safeErrorMessage(error)}`,
        );
      }
      return false;
    }

    removeUniqueProtocolEntry(tomb, "stale lock tomb");
    if (existsSync(tomb)) return false;
    warnWithoutThrowing(`[FileLock] removed stale lock: ${lockPath}`);
    return true;
  } finally {
    removeUniqueProtocolEntry(intent, "reap intent");
  }
};

/** Test seam for stale recovery; production callers use `acquireFileLock`. */
export const stealStaleFileLock = async (
  lockPath: string,
  hooks: FileLockTestHooks = {},
): Promise<boolean> => {
  try {
    return await fencedReap(lockPath, hooks);
  } catch (error) {
    throw fileOperationError("stealStaleFileLock", lockPath, error);
  }
};

/**
 * Acquire `lockPath`. The returned plain token must be supplied to release;
 * this protects same-pid concurrent callers as well as cross-process owners.
 */
export const acquireFileLock = async (
  lockPath: string,
  hooks: FileLockTestHooks = {},
): Promise<string> => {
  try {
    const ownershipToken = uniqueToken();
    let staleHookRan = false;
    let lastProbeDiagnostic: string | undefined;
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      if (tryFencedBirth(lockPath, ownershipToken, hooks)) return ownershipToken;

      const ownerProbe = existsSync(lockPath)
        ? ownerStaleness(lockPath, hooks)
        : undefined;
      if (ownerProbe?.diagnostic !== undefined) {
        lastProbeDiagnostic = ownerProbe.diagnostic;
      }
      if (ownerProbe?.stale === true) {
        if (!staleHookRan) {
          staleHookRan = true;
          await hooks.afterUnfencedStaleProbe?.();
        }
        await fencedReap(lockPath, hooks);
        continue;
      }
      if (protocolEntries(lockPath, TOMB_PREFIX).length > 0) {
        await fencedReap(lockPath, hooks);
        continue;
      }
      await sleep(RETRY_MS);
    }
    throw fileOperationError(
      "acquireFileLock",
      lockPath,
      `Could not acquire lock after ${MAX_ACQUIRE_ATTEMPTS} attempts${lastProbeDiagnostic === undefined ? "" : `; last blocking owner probe: ${lastProbeDiagnostic}`}`,
    );
  } catch (error) {
    throw fileOperationError("acquireFileLock", lockPath, error);
  }
};

/**
 * Construct and best-effort report an observable release failure. The logger
 * is deliberately secondary: hostile logger implementations cannot replace
 * the typed failure returned to the caller.
 */
const releaseFailure = (
  lockPath: string,
  reason: unknown,
): ReturnType<typeof fileOperationError> => {
  const failure = fileOperationError("releaseFileLock", lockPath, reason);
  warnWithoutThrowing(
    `[FileLock] lock release failed and the lock may remain live: ${fileThrownValueMessage(failure)}`,
  );
  return failure;
};

/**
 * Determine whether an ownership-read ENOENT really means the canonical lock
 * is absent. A missing metadata file inside an existing owner is corruption,
 * not an expected already-released lock. An inconclusive path inspection is
 * itself an observable typed release failure.
 */
const releaseLockIsAbsent = (
  lockPath: string,
  hooks: FileLockTestHooks,
): boolean => {
  try {
    if (hooks.inspectReleasePath !== undefined) hooks.inspectReleasePath(lockPath);
    else lstatSync(lockPath);
    return false;
  } catch (error) {
    const probe = probeErrorCode(error);
    if (probe.kind === "code" && probe.code === "ENOENT") return true;
    throw releaseFailure(
      lockPath,
      `could not inspect the canonical lock while verifying release; lock left in place: ${safeErrorMessageWithCodeProbe(error, probe)}`,
    );
  }
};

type ReleaseMetadataRead =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "absent" };

const readReleaseMetadata = (
  lockPath: string,
  field: "pid" | "ownership token",
  read: () => string,
  hooks: FileLockTestHooks,
): ReleaseMetadataRead => {
  try {
    return { kind: "value", value: read().trim() };
  } catch (error) {
    const probe = probeErrorCode(error);
    if (
      probe.kind === "code"
      && probe.code === "ENOENT"
      && releaseLockIsAbsent(lockPath, hooks)
    ) {
      return { kind: "absent" };
    }
    throw releaseFailure(
      lockPath,
      `failed to verify ownership while reading ${field}; lock left in place: ${safeErrorMessageWithCodeProbe(error, probe)}`,
    );
  }
};

/**
 * Remove the canonical owner only when both pid and token still match.
 *
 * Absence and proven ownership mismatch are safe no-ops. An inconclusive
 * ownership read or failure to remove a lock proven to be ours throws the
 * existing typed `cache-error` with operation `releaseFileLock`; callers can
 * therefore never report successful cleanup while an owned lock remains.
 */
export const releaseFileLock = (
  lockPath: string,
  ownershipToken: string,
  hooks: FileLockTestHooks = {},
): void => {
  const pid = readReleaseMetadata(
    lockPath,
    "pid",
    () => hooks.readOwnerPid?.(lockPath)
      ?? readFileSync(join(lockPath, PID_FILE), "utf-8"),
    hooks,
  );
  if (pid.kind === "absent" || pid.value !== `${process.pid}`) return;

  const token = readReleaseMetadata(
    lockPath,
    "ownership token",
    () => hooks.readOwnershipToken?.(lockPath)
      ?? readFileSync(join(lockPath, OWNER_FILE), "utf-8"),
    hooks,
  );
  if (token.kind === "absent" || token.value !== ownershipToken) return;

  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch (error) {
    throw releaseFailure(
      lockPath,
      `failed to remove the owned lock directory; lock left in place: ${safeErrorMessage(error)}`,
    );
  }
};

type CriticalSectionOutcome<T> =
  | { readonly kind: "succeeded"; readonly value: T }
  | { readonly kind: "failed"; readonly error: ReturnType<typeof fileOperationError> };

export const withFileLock = async <T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  hooks: FileLockTestHooks = {},
): Promise<T> => {
  const ownershipToken = await acquireFileLock(lockPath, hooks);
  let outcome: CriticalSectionOutcome<T>;
  try {
    outcome = { kind: "succeeded", value: await fn() };
  } catch (error) {
    outcome = {
      kind: "failed",
      error: fileOperationError("withFileLock", lockPath, error),
    };
  }

  try {
    releaseFileLock(lockPath, ownershipToken, hooks);
  } catch (releaseError) {
    if (outcome.kind === "succeeded") {
      throw fileOperationError("withFileLock", lockPath, releaseError);
    }
    warnWithoutThrowing(
      `[FileLock] secondary lock-release failure after the critical section failed; preserving the primary failure. primary=${fileThrownValueMessage(outcome.error)}; cleanup=${fileThrownValueMessage(releaseError)}`,
    );
  }

  if (outcome.kind === "failed") throw outcome.error;
  return outcome.value;
};
