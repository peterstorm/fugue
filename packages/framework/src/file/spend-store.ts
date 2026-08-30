/** High-level atomic file store for durable per-run spend snapshots. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameworkError } from "../types/errors.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import type { RunId } from "../types/ids.js";
import type { Spend } from "../types/spend.js";
import { NO_SPEND, addSpend } from "../types/spend.js";
import { isMissingPathError } from "../types/safe-error.js";
import { atomicWriteFile, withFileLock } from "./atomic.js";
import {
  fileOperationError,
  isFileBackendPathString,
} from "./boundary-error.js";
import {
  assertDirectoryIdentity,
  verifyDirectory,
  verifyExistingFile,
  type VerifiedDirectory,
} from "./verified-directory.js";
import { parseFileSpendRecord, serializeFileSpendRecord } from "./spend-store-codec.js";

export interface FileSpendStore {
  readonly read: (runId: RunId) => Promise<Result<Spend, FrameworkError>>;
  readonly add: (runId: RunId, delta: Spend) => Promise<Result<void, FrameworkError>>;
}

const digestOf = (runId: RunId): string =>
  createHash("sha256").update(runId as string, "utf8").digest("hex");

const pathsFor = (root: VerifiedDirectory, runId: RunId) => {
  const digest = digestOf(runId);
  const fileName = `${digest}.json`;
  return {
    fileName,
    recordPath: join(root.path, fileName),
    lockPath: join(root.path, `${digest}.lock`),
  };
};

const readSnapshot = (
  root: VerifiedDirectory,
  runId: RunId,
): Result<Spend, FrameworkError> => {
  const { fileName } = pathsFor(root, runId);
  assertDirectoryIdentity(root);
  let recordPath: string;
  try {
    recordPath = verifyExistingFile(root, fileName);
  } catch (error) {
    if (isMissingPathError(error)) return ok(NO_SPEND);
    throw error;
  }
  const parsed = parseFileSpendRecord(readFileSync(recordPath, "utf8"), runId);
  assertDirectoryIdentity(root);
  return parsed;
};

/**
 * Create a store rooted at a verified non-symlink directory. Construction
 * throws only a typed FrameworkError; every port method returns Result.
 */
export const createFileSpendStore = (rootPath: string): FileSpendStore => {
  let root: VerifiedDirectory;
  try {
    if (!isFileBackendPathString(rootPath)) {
      throw new TypeError("root must be a non-empty NUL-free string");
    }
    root = verifyDirectory(rootPath, null, true);
  } catch (error) {
    throw fileOperationError("spendStore:create", rootPath, error);
  }

  return Object.freeze({
    read: async (runId: RunId): Promise<Result<Spend, FrameworkError>> => {
      try {
        return readSnapshot(root, runId);
      } catch (error) {
        return err(fileOperationError("spendStore:read", root.path, error));
      }
    },

    add: async (runId: RunId, delta: Spend): Promise<Result<void, FrameworkError>> => {
      const { recordPath, lockPath } = pathsFor(root, runId);
      try {
        await withFileLock(lockPath, () => {
          assertDirectoryIdentity(root);
          const prior = readSnapshot(root, runId);
          if (!prior.ok) throw prior.error;
          const serialized = serializeFileSpendRecord(runId, addSpend(prior.value, delta));
          if (!serialized.ok) throw serialized.error;
          atomicWriteFile(recordPath, serialized.value);
          assertDirectoryIdentity(root);
        });
        return ok(undefined);
      } catch (error) {
        return err(fileOperationError("spendStore:add", root.path, error));
      }
    },
  });
};
