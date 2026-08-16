import { describe, expect, it } from "bun:test";
import {
  fileCacheError,
  fileOperationError,
  type FileOperation,
} from "../file/boundary-error.js";
import { frameworkError } from "../types/error-factories.js";
import type { FrameworkError } from "../types/errors.js";
import { retriabilityOf } from "../types/errors.js";

const FILE_OPERATION_TYPECHECK_COVERAGE = [
  "acquireFileLock",
  "appendEvent",
  "assertLosslessEvent",
  "atomicWriteFile",
  "createFileCheckpointer",
  "createFileFreshnessIndex",
  "createFileJob",
  "createFileJournal",
  "data",
  "eventDigestOf",
  "eventFileName",
  "freshness:findConflict",
  "freshness:recordWrite",
  "keyDigest",
  "load",
  "readCheckpoint",
  "readFileEventRecords",
  "readFileEvents",
  "releaseFileLock",
  "resumeFileJob",
  "saveNode",
  "serializeFileCheckpoint",
  "serializeFileEventRecord",
  "setMeta",
  "stealStaleFileLock",
  "updateData",
  "updateProgress",
  "withFileLock",
  "writeCheckpoint",
  "writeProgress",
] as const satisfies readonly FileOperation[];

const FILE_CHECKPOINTER_OPERATION_TYPECHECK_COVERAGE = [
  "createFileCheckpointer",
  "load",
  "saveNode",
  "setMeta",
] as const satisfies readonly FileOperation[];

type AssertNever<T extends never> = T;
type _EveryFileOperationIsCovered = AssertNever<
  Exclude<FileOperation, (typeof FILE_OPERATION_TYPECHECK_COVERAGE)[number]>
>;
type _EveryCheckpointerOperationBelongsToFileOperation = AssertNever<
  Exclude<(typeof FILE_CHECKPOINTER_OPERATION_TYPECHECK_COVERAGE)[number], FileOperation>
>;

// This function is intentionally never called. `@ts-expect-error` makes both
// framework typechecks fail if either typed helper ever accepts misspellings.
const compileTimeTypoPin = (): void => {
  // @ts-expect-error -- file-backend operation names are a closed local union.
  fileOperationError("appendEvnet", "fixture", "typo must not compile");
  // @ts-expect-error -- Result-bearing cache errors use the same closed union.
  fileCacheError("saveNdoe", "typo must not compile");
};
void compileTimeTypoPin;

describe("file boundary error operation vocabulary", () => {
  it("contains every file-backend operation used by the implementation", () => {
    expect(FILE_OPERATION_TYPECHECK_COVERAGE).toHaveLength(30);
    expect(new Set(FILE_OPERATION_TYPECHECK_COVERAGE).size).toBe(
      FILE_OPERATION_TYPECHECK_COVERAGE.length,
    );
    expect(FILE_CHECKPOINTER_OPERATION_TYPECHECK_COVERAGE).toEqual([
      "createFileCheckpointer",
      "load",
      "saveNode",
      "setMeta",
    ]);
  });

  it("preserves the selected operation in typed file failures", () => {
    const error = fileOperationError("appendEvent", "/runs/r1", "disk full");
    expect(error).toMatchObject({
      kind: "cache-error",
      operation: "appendEvent",
    });
  });

  it("leaves public cache-error.operation open for non-file adapters", () => {
    const error: FrameworkError = frameworkError.cacheError(
      "consumer-defined-operation",
      "external adapter failure",
    );
    expect(error).toEqual({
      kind: "cache-error",
      operation: "consumer-defined-operation",
      message: "external adapter failure",
    });
  });
});

describe("fileOperationError — permanent-class inference (the load-bearing ADR-0080 link)", () => {
  it("preserves an inner permanent cache-error class when no explicit class is given", () => {
    // The appendEvent fs-wrap around a permanent codec rejection must stay
    // permanent — a regression erasing the inner class would mislabel a
    // deterministic append rejection retriable with no test failing.
    const inner = fileCacheError("serializeFileEventRecord", "non-lossless event", "permanent");
    const wrapped = fileOperationError("appendEvent", "/runs/r1", inner);
    expect(wrapped).toMatchObject({ kind: "cache-error", operation: "appendEvent" });
    expect(wrapped.kind === "cache-error" && wrapped.failureClass).toBe("permanent");
    expect(retriabilityOf(wrapped)).toBe("non-retriable");
  });

  it("an explicit failureClass wins over the inferred inner class", () => {
    const inner = fileCacheError("serializeFileEventRecord", "non-lossless event", "permanent");
    const wrapped = fileOperationError("appendEvent", "/runs/r1", inner, "transient");
    expect(wrapped.kind === "cache-error" && wrapped.failureClass).toBe("transient");
    expect(retriabilityOf(wrapped)).toBe("retriable");
  });

  it("does not infer a class from untyped reasons or non-cache-error typed values", () => {
    const fromString = fileOperationError("readCheckpoint", "/runs/r1", "disk full");
    expect(fromString.kind === "cache-error" && fromString.failureClass).toBeUndefined();
    expect(retriabilityOf(fromString)).toBe("retriable");

    const fromNonCache = fileOperationError(
      "readCheckpoint",
      "/runs/r1",
      frameworkError.checkpointCorrupt("run-1", "hostile payload"),
    );
    expect(fromNonCache.kind === "cache-error" && fromNonCache.failureClass).toBeUndefined();
  });
});
