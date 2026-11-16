// `parseNodeStateRecord` — the checkpoint core's shared node-record grammar.
//
// Parse, don't validate: the parse returns the PROVEN record, pass-through
// `output` included, so a backend never re-reads `output` off the raw value
// through a second, unproven helper (PR #53 review finding). These tests pin
// that interface: the round trip through the stored JSON shape, the output
// being the very value on the proven object, and the rejections.

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseNodeStateRecord } from "../checkpoint/checkpointer.js";
import { ID_PATTERN } from "../types/ids.js";

const nodeIdArb = fc.stringMatching(ID_PATTERN);
const completedAtArb = fc
  .date({ min: new Date("1970-01-01T00:00:00.000Z"), max: new Date("9999-12-31T23:59:59.999Z"), noInvalidDate: true });

describe("parseNodeStateRecord — returns the proven record, output included", () => {
  it("round-trips every valid stored record, pass-through output included", () => {
    fc.assert(
      fc.property(nodeIdArb, completedAtArb, fc.jsonValue(), (nodeId, completedAt, output) => {
        const stored: unknown = JSON.parse(
          JSON.stringify({ nodeId, output, completedAt: completedAt.toISOString() }),
        );
        const parsed = parseNodeStateRecord(stored);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect<string>(parsed.value.nodeId).toBe(nodeId);
        expect(parsed.value.completedAt.getTime()).toBe(completedAt.getTime());
        // The output is the stored form, untouched: JSON round-trips it exactly.
        expect(parsed.value.output).toEqual(JSON.parse(JSON.stringify(output)));
      }),
    );
  });

  it("returns the output by reference — read off the proven object, never copied", () => {
    const output = { nested: { value: 1 } };
    const parsed = parseNodeStateRecord({
      nodeId: "node-a",
      output,
      completedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(parsed.ok && parsed.value.output).toBe(output);
  });

  it("an absent output parses as undefined (the pass-through the Redis backends always had)", () => {
    const parsed = parseNodeStateRecord({ nodeId: "node-a", completedAt: "2025-01-01T00:00:00.000Z" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.output).toBeUndefined();
  });

  it("rejects every non-object record before reading any field", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.string(), fc.double(), fc.boolean(), fc.array(fc.jsonValue())),
        (raw) => {
          const parsed = parseNodeStateRecord(raw);
          expect(parsed.ok).toBe(false);
          if (!parsed.ok) expect(parsed.error).toStartWith("node entry must be a JSON object");
        },
      ),
    );
  });

  it("rejects a nodeId outside ID_PATTERN and a non-canonical completedAt", () => {
    const badId = parseNodeStateRecord({ nodeId: "a@b", output: 1, completedAt: "2025-01-01T00:00:00.000Z" });
    expect(badId.ok).toBe(false);
    const badDate = parseNodeStateRecord({ nodeId: "a", output: 1, completedAt: "2025-01-01" });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.error).toContain("completedAt must be a canonical ISO timestamp");
  });
});
