/** Strict, pure V1 codec for one file-backed run spend snapshot. */

import type { FrameworkError } from "../types/errors.js";
import type { Result } from "../types/result.js";
import { err, map, ok } from "../types/result.js";
import type { MicroUsd, Spend, UnpricedModels } from "../types/spend.js";
import { costFloor } from "../types/spend.js";
import type { RunId } from "../types/ids.js";
import { fileCacheError } from "./boundary-error.js";

interface FileSpendRecordV1 {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly tokens: number;
  readonly calls: number;
  readonly micros: number;
  readonly unpricedModels: readonly string[];
}

type SpendStoreOperation = "spendStore:read" | "spendStore:add";

const codecError = (operation: SpendStoreOperation, message: string): FrameworkError =>
  fileCacheError(operation, message, "permanent");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFigure = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const canonicalModels = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value) || !value.every((model) => typeof model === "string")) {
    return false;
  }
  const canonical = [...new Set(value)].sort();
  return canonical.length === value.length && canonical.every((model, index) => model === value[index]);
};

const parseRecord = (
  value: unknown,
  expectedRunId: RunId,
  operation: SpendStoreOperation,
): Result<FileSpendRecordV1, FrameworkError> => {
  if (!isRecord(value)) return err(codecError(operation, "spend record must be an object"));
  const expectedKeys = ["calls", "micros", "runId", "schemaVersion", "tokens", "unpricedModels"];
  if (Object.keys(value).sort().join("\u0000") !== expectedKeys.join("\u0000")) {
    return err(codecError(operation, "spend record fields do not match schema V1"));
  }
  if (value.schemaVersion !== 1) return err(codecError(operation, "unsupported spend schemaVersion"));
  if (value.runId !== expectedRunId) {
    return err(codecError(operation, "spend record runId does not own its digest address"));
  }
  if (!isFigure(value.tokens) || !isFigure(value.calls) || !isFigure(value.micros)) {
    return err(codecError(operation, "spend figures must be non-negative safe integers"));
  }
  if (!canonicalModels(value.unpricedModels)) {
    return err(codecError(operation, "unpricedModels must be sorted unique strings"));
  }
  return ok(Object.freeze({
    schemaVersion: 1,
    runId: expectedRunId,
    tokens: value.tokens,
    calls: value.calls,
    micros: value.micros,
    unpricedModels: Object.freeze([...value.unpricedModels]),
  }));
};

const spendOfFileRecord = (record: FileSpendRecordV1): Spend => {
  const [head, ...rest] = record.unpricedModels;
  const micros = record.micros as MicroUsd;
  return {
    tokens: record.tokens,
    calls: record.calls,
    usd: head === undefined
      ? { kind: "priced", micros }
      : {
          kind: "unpriced",
          models: [head, ...rest] as UnpricedModels,
          knownMicros: micros,
        },
  };
};

export const parseFileSpendRecord = (
  text: string,
  expectedRunId: RunId,
): Result<Spend, FrameworkError> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return err(codecError("spendStore:read", "spend record is not valid JSON"));
  }
  return map(
    parseRecord(decoded, expectedRunId, "spendStore:read"),
    spendOfFileRecord,
  );
};

export const serializeFileSpendRecord = (
  runId: RunId,
  spend: Spend,
): Result<string, FrameworkError> => {
  const models = spend.usd.kind === "unpriced" ? [...spend.usd.models] : [];
  const candidate = {
    schemaVersion: 1,
    runId,
    tokens: spend.tokens,
    calls: spend.calls,
    micros: costFloor(spend.usd),
    unpricedModels: models,
  };
  return map(
    parseRecord(candidate, runId, "spendStore:add"),
    (record) => JSON.stringify(record),
  );
};
