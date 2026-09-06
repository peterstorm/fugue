import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pricedCall, runId, type MicroUsd } from "@fuguejs/framework";
import { createFileSpendLedger } from "../adapters/spend-ledger-file.js";
import { formatHostError, httpStatusFor } from "../domain/host-error.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "fugue-ledger-adapter-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const rid = runId("adapter-run");
const pathFor = (root: string): string =>
  join(root, `${createHash("sha256").update(rid).digest("hex")}.json`);

describe("createFileSpendLedger", () => {
  it("translates construction failures to the dedicated typed host error", () => {
    const target = tempRoot();
    const parent = tempRoot();
    const linked = join(parent, "linked");
    symlinkSync(target, linked, "dir");
    const created = createFileSpendLedger(linked);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toMatchObject({
      kind: "spend-ledger-unavailable",
      backend: "file",
      operation: "create",
    });
    expect(httpStatusFor(created.error)).toBe(500);
    expect(formatHostError(created.error)).toContain("file spend ledger unavailable");
  });

  it("translates corrupt reads without treating corruption as zero", async () => {
    const root = tempRoot();
    const created = createFileSpendLedger(root);
    if (!created.ok) throw new Error("expected file ledger");
    writeFileSync(pathFor(root), "{broken");
    const read = await created.value.read(rid);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatchObject({
      kind: "spend-ledger-unavailable",
      operation: "read",
    });
  });

  it("translates add failures and never retries a forged invalid delta", async () => {
    const root = tempRoot();
    const created = createFileSpendLedger(root);
    if (!created.ok) throw new Error("expected file ledger");
    const invalid = pricedCall(1, 1 as MicroUsd) as { tokens: number };
    invalid.tokens = Number.NaN;
    const added = await created.value.add(rid, invalid as never);
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error).toMatchObject({
      kind: "spend-ledger-unavailable",
      operation: "add",
    });
  });
});
