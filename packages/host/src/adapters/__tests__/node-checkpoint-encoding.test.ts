// The host's node-checkpoint encoding: exact-restore proof by one walk, then
// toJson. What it refuses is what the writer's former parse-back comparison
// refused; the framework's file-lossless-prescan-parity test holds that
// equivalence over arbitrary values, and these cases pin it at the host seam.

import { describe, expect, it } from "bun:test";
import { fromJson, toJson } from "@fuguejs/framework";
import { encodeNodeCheckpoint } from "../node-checkpoint-encoding.js";

describe("encodeNodeCheckpoint", () => {
  it("returns toJson's bytes for an output JSON restores exactly", () => {
    const output = {
      leads: [{ cvr: "12345678", score: 33, hit: true, detail: undefined }],
      byNode: new Map([["n", new Set(["approved"])]]),
      at: new Date("2026-11-16T00:00:00.000Z"),
    };
    const encoded = encodeNodeCheckpoint(output);
    expect(encoded).toEqual({ ok: true, value: toJson(output) });
    if (encoded.ok) expect(fromJson(encoded.value)).toEqual(output);
  });

  it.each([
    ["a non-finite number", { meta: { maxScore: Number.NaN } }, "nodeOutput.meta.maxScore is the non-finite number NaN"],
    ["-0", { meta: { maxScore: -0 } }, "nodeOutput.meta.maxScore is -0"],
    ["an array hole", { leads: [1, , 3] }, "nodeOutput.leads[1] is an array hole"],
    ["a null-prototype object", { meta: Object.create(null) as object }, "nodeOutput.meta is a null-prototype object"],
    ["a symbol-keyed property", { selection: { [Symbol("response")]: 1 } }, "nodeOutput.selection has symbol-keyed own property"],
    ["a cycle", (() => { const o: Record<string, unknown> = {}; o["self"] = o; return o; })(), "circular reference at nodeOutput.self"],
  ])("refuses %s, naming the path in its diagnostic", (_label, output, expected) => {
    const encoded = encodeNodeCheckpoint(output);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) expect(encoded.error).toContain(expected);
  });
});
