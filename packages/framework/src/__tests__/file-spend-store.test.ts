import { afterEach, describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSpendStore } from "../file/spend-store.js";
import { parseFileSpendRecord, serializeFileSpendRecord } from "../file/spend-store-codec.js";
import {
  addSpend,
  makeSpend,
  NO_SPEND,
  pricedCall,
  unpricedCall,
  unpricedModels,
} from "../types/spend.js";
import type { MicroUsd } from "../types/spend.js";
import { runId, type RunId } from "../types/ids.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "fugue-spend-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const rid = runId("run-file-spend");
const modelName = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 12 })
  .map((codeUnits) => String.fromCharCode(...codeUnits));
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const recordPath = (root: string, value: string): string => join(root, `${digest(value)}.json`);

describe("file spend codec", () => {
  it("round-trips valid spend structurally (property)", () => {
    // `usage` is generated over BOTH values: "unknown" is the absorbing signal
    // that disables ceiling evaluation, so silently losing it across a durable
    // round trip (a process restart) would reopen a ceiling that must keep
    // refusing. The USD shape is generated too — an unpriced spend's model list
    // is the other half of the same fail-closed signal.
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      fc.constantFrom("known" as const, "unknown" as const),
      fc.option(fc.uniqueArray(modelName, { minLength: 1, maxLength: 3 }), { nil: undefined }),
      (tokens, calls, micros, usage, models) => {
        const canonical = models === undefined ? undefined : unpricedModels(models);
        const spend = makeSpend({
          usage,
          tokens,
          calls,
          usd: canonical === undefined
            ? { kind: "priced", micros: micros as MicroUsd }
            : { kind: "unpriced", models: canonical, knownMicros: micros as MicroUsd },
        });
        const encoded = serializeFileSpendRecord(rid, spend);
        expect(encoded.ok).toBe(true);
        if (!encoded.ok) return;
        const decoded = parseFileSpendRecord(encoded.value, rid);
        expect(decoded).toEqual({ ok: true, value: spend });
        // Pinned explicitly: the flag must survive, not merely compare equal by
        // coincidence with a default.
        if (decoded.ok) expect(decoded.value.usage).toBe(usage);
      },
    ));
  });

  it("keeps an unknown-usage unpriced spend intact through the codec", () => {
    const models = unpricedModels(["mystery-model"]);
    if (models === undefined) throw new Error("expected canonical models");
    const spend = makeSpend({
      usage: "unknown",
      tokens: 0,
      calls: 1,
      usd: { kind: "unpriced", models, knownMicros: 0 as MicroUsd },
    });

    const encoded = serializeFileSpendRecord(rid, spend);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    // The wire form carries the flag literally — a reader on another process
    // must be able to see it without inferring it.
    expect(JSON.parse(encoded.value).usage).toBe("unknown");

    const decoded = parseFileSpendRecord(encoded.value, rid);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.usage).toBe("unknown");
      expect(decoded.value.usd.kind).toBe("unpriced");
      if (decoded.value.usd.kind === "unpriced") {
        expect([...decoded.value.usd.models]).toEqual(["mystery-model"]);
      }
    }
  });

  it("round-trips arbitrary UTF-16 unpriced model names", () => {
    fc.assert(fc.property(
      fc.uniqueArray(modelName, { minLength: 1, maxLength: 4 }),
      (models) => {
        const canonicalModels = unpricedModels(models);
        if (canonicalModels === undefined) throw new Error("generated models are non-empty");
        const spend = makeSpend({
          usage: "known",
          tokens: 0,
          calls: 1,
          usd: {
            kind: "unpriced",
            models: canonicalModels,
            knownMicros: 0 as MicroUsd,
          },
        });
        const encoded = serializeFileSpendRecord(rid, spend);
        expect(encoded.ok).toBe(true);
        if (encoded.ok) expect(parseFileSpendRecord(encoded.value, rid)).toEqual({ ok: true, value: spend });
      },
    ));
  });

  it("rejects malformed figures, model ordering, extra fields, and crossed run ownership", () => {
    const valid = {
      schemaVersion: 1,
      runId: rid,
      usage: "known",
      tokens: 1,
      calls: 1,
      micros: 1,
      unpricedModels: [],
    };
    for (const malformed of [
      { ...valid, tokens: -1 },
      { ...valid, calls: 1.5 },
      { ...valid, micros: "1" },
      { ...valid, unpricedModels: ["z", "a"] },
      { ...valid, extra: true },
      { ...valid, runId: "another-run" },
    ]) {
      expect(parseFileSpendRecord(JSON.stringify(malformed), rid).ok).toBe(false);
    }
  });
});

describe("createFileSpendStore", () => {
  it("reads an unknown run as NO_SPEND and addresses it only by digest", async () => {
    const root = tempRoot();
    const store = createFileSpendStore(root);
    expect(await store.read(rid)).toEqual({ ok: true, value: NO_SPEND });
    await store.add(rid, pricedCall(2, 3 as MicroUsd));
    expect(readdirSync(root)).toContain(`${digest(rid)}.json`);
    expect(readdirSync(root).some((name) => name.includes(rid))).toBe(false);
  });

  it("survives a fresh store instance and folds sequential adds", async () => {
    const root = tempRoot();
    const first = createFileSpendStore(root);
    await first.add(rid, pricedCall(10, 4 as MicroUsd));
    await first.add(rid, unpricedCall(2, "future-model"));

    const fresh = createFileSpendStore(root);
    expect(await fresh.read(rid)).toEqual({
      ok: true,
      value: addSpend(pricedCall(10, 4 as MicroUsd), unpricedCall(2, "future-model")),
    });
  });

  it("carries the unknown-usage signal across a process restart", async () => {
    // The durability half of the codec property above: a run whose usage went
    // unknown must still read back as unknown from a FRESH store instance, or a
    // restart would silently reopen a ceiling that had stopped admitting.
    const root = tempRoot();
    const unknownUsage = makeSpend({
      usage: "unknown",
      tokens: 0,
      calls: 1,
      usd: { kind: "priced", micros: 0 as MicroUsd },
    });

    const first = createFileSpendStore(root);
    expect((await first.add(rid, pricedCall(10, 4 as MicroUsd))).ok).toBe(true);
    expect((await first.add(rid, unknownUsage)).ok).toBe(true);

    const reloaded = await createFileSpendStore(root).read(rid);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value.usage).toBe("unknown");
      expect(reloaded.value).toEqual(addSpend(pricedCall(10, 4 as MicroUsd), unknownUsage));
    }
  });

  it("carries an unpriced model list across a process restart", async () => {
    const root = tempRoot();
    const first = createFileSpendStore(root);
    expect((await first.add(rid, unpricedCall(3, "mystery-model"))).ok).toBe(true);

    const reloaded = await createFileSpendStore(root).read(rid);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok && reloaded.value.usd.kind === "unpriced") {
      expect([...reloaded.value.usd.models]).toEqual(["mystery-model"]);
    } else {
      throw new Error("expected an unpriced spend to reload as unpriced");
    }
  });

  it("serializes concurrent adds into one complete aggregate", async () => {
    const root = tempRoot();
    const store = createFileSpendStore(root);
    const deltas = Array.from({ length: 20 }, (_, i) => pricedCall(i + 1, (i + 2) as MicroUsd));
    const outcomes = await Promise.all(deltas.map((delta) => store.add(rid, delta)));
    expect(outcomes.every((result) => result.ok)).toBe(true);
    expect(await createFileSpendStore(root).read(rid)).toEqual({
      ok: true,
      value: deltas.reduce(addSpend, NO_SPEND),
    });
  });

  it("treats corrupt and crossed records as errors, never zero", async () => {
    const root = tempRoot();
    const store = createFileSpendStore(root);
    const persistedRecordPath = recordPath(root, rid);
    writeFileSync(persistedRecordPath, "{torn");
    const corrupt = await store.read(rid);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) {
      expect(corrupt.error).toMatchObject({
        kind: "cache-error",
        operation: "spendStore:read",
      });
      if (corrupt.error.kind === "cache-error") {
        expect(corrupt.error.message).toContain(persistedRecordPath);
      }
    }

    writeFileSync(persistedRecordPath, JSON.stringify({
      schemaVersion: 1,
      runId: "other-run",
      usage: "known",
      tokens: 0,
      calls: 0,
      micros: 0,
      unpricedModels: [],
    }));
    expect((await store.read(rid)).ok).toBe(false);
    expect((await store.add(rid, pricedCall(1, 1 as MicroUsd))).ok).toBe(false);
  });

  it("returns typed operation-specific errors for malformed and hostile runtime runIds", async () => {
    const root = tempRoot();
    const store = createFileSpendStore(root);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const candidate of ["../escape", 42, null, revoked.proxy] as readonly unknown[]) {
      const read = await store.read(candidate as RunId);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error).toMatchObject({
          kind: "cache-error",
          operation: "spendStore:read",
          failureClass: "permanent",
        });
      }

      const add = await store.add(candidate as RunId, pricedCall(1, 1 as MicroUsd));
      expect(add.ok).toBe(false);
      if (!add.ok) {
        expect(add.error).toMatchObject({
          kind: "cache-error",
          operation: "spendStore:add",
          failureClass: "permanent",
        });
      }
    }

    expect(readdirSync(root)).toEqual([]);
  });

  it("rechecks root identity after the verified directory is replaced", async () => {
    const root = tempRoot();
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    const store = createFileSpendStore(root);
    renameSync(root, displaced);
    mkdirSync(root);

    const read = await store.read(rid);
    const add = await store.add(rid, pricedCall(1, 1 as MicroUsd));
    expect(read.ok).toBe(false);
    expect(add.ok).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses symlinked roots and record files", async () => {
    const real = tempRoot();
    const parent = tempRoot();
    const linkedRoot = join(parent, "linked");
    symlinkSync(real, linkedRoot, "dir");
    expect(() => createFileSpendStore(linkedRoot)).toThrow();

    const store = createFileSpendStore(real);
    const target = join(parent, "outside.json");
    writeFileSync(target, "{}");
    symlinkSync(target, recordPath(real, rid));
    expect((await store.read(rid)).ok).toBe(false);
    expect((await store.add(rid, pricedCall(1, 1 as MicroUsd))).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });
});
