// Tests for the composite checkpoint node-key codec (ADR-0075).
//
// Covers: canonical folding rules, parse round-trip (parse(encode(a)) = a)
// over an address matrix, collision-freedom between canonical and composite
// forms (and within the composite space), hostile-encoder-input rejection, and
// fast-check properties over generated valid addresses.

import { afterEach, describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { D, N, R } from "./_id-helpers.js";
import type { NodeId } from "../types/ids.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import {
  DEFAULT_NODE_NAMESPACE,
  compositeNodeKey,
  parseCompositeNodeKey as parseCompositeNodeKeyBranded,
} from "../checkpoint/composite-node-key.js";
import type { CompositeNodeKeyOpts } from "../checkpoint/composite-node-key.js";

/**
 * De-branded mirror of `ParsedCompositeNodeKey`. `parseCompositeNodeKey` carries
 * the `ID_PATTERN` proof forward as a branded `NodeId`; brands erase at runtime
 * and `toEqual` compares structurally, so this file keeps its expectations as
 * plain string literals instead of minting a `NodeId` at every assertion.
 */
type ExpectedParse =
  | { readonly form: "canonical"; readonly nodeId: string }
  | {
      readonly form: "composite";
      readonly namespace: string;
      readonly nodeId: string;
      readonly index: number;
      readonly attempt: number;
    };

const parseCompositeNodeKey = (key: string): ExpectedParse | null =>
  parseCompositeNodeKeyBranded(key) as ExpectedParse | null;

/** Cast a hostile string past the NodeId brand — the codec must still reject it. */
const rawNodeId = (s: string): NodeId => s as unknown as NodeId;

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
const id128 = "id".padEnd(128, "x");

const optsOf = (
  namespace: string | undefined,
  index: number | undefined,
  attempt: number | undefined,
): CompositeNodeKeyOpts => {
  if (index !== undefined) {
    return {
      ...(namespace !== undefined ? { namespace } : {}),
      index,
      ...(attempt !== undefined ? { attempt } : {}),
    };
  }
  if (attempt !== undefined) {
    return { ...(namespace !== undefined ? { namespace } : {}), attempt };
  }
  return {};
};

describe("DEFAULT_NODE_NAMESPACE", () => {
  it("is exactly 'dag'", () => {
    expect(DEFAULT_NODE_NAMESPACE).toBe("dag");
  });
});

describe("compositeNodeKey — canonical folding (ADR-0075)", () => {
  it("returns the bare nodeId when no opts are given", () => {
    expect(compositeNodeKey(N("read-node"))).toBe("read-node");
  });

  it("returns the bare nodeId when index AND attempt are both absent — opts ignored", () => {
    expect(compositeNodeKey(N("read-node"), {})).toBe("read-node");
  });

  it("rejects a namespace supplied without index/attempt as ambiguous (ADR-0075)", () => {
    // A namespace alone can only mean the caller meant a composite address
    // but forgot its addressing component: silently folding would store the
    // entry under the bare canonical nodeId and discard the intent, so the
    // shape is refused instead (parse, don't validate).
    // @ts-expect-error — namespace-only is intentionally unrepresentable.
    expect(() => compositeNodeKey(N("read-node"), { namespace: "sub" })).toThrow(
      /namespace.*without index\/attempt.*ambiguous/,
    );
    // @ts-expect-error — runtime defense still rejects forged JavaScript.
    expect(() => compositeNodeKey(N("read-node"), { namespace: "@@@bad" })).toThrow(/ambiguous/);
    // With an addressing component present, the namespace participates.
    expect(compositeNodeKey(N("read-node"), { namespace: "sub", index: 0 })).toBe("sub@read-node@0@0");
  });

  it("keeps ids with every ID_PATTERN character verbatim", () => {
    expect(compositeNodeKey(N("a"))).toBe("a");
    expect(compositeNodeKey(N("ns:node-1_x"))).toBe("ns:node-1_x");
    expect(compositeNodeKey(N(id128))).toBe(id128);
  });
});

describe("compositeNodeKey — composite form", () => {
  it("index-only: defaults namespace to 'dag' and attempt to 0", () => {
    expect(compositeNodeKey(N("read-node"), { index: 3 })).toBe("dag@read-node@3@0");
  });

  it("attempt-only: defaults namespace to 'dag' and index to 0", () => {
    expect(compositeNodeKey(N("read-node"), { attempt: 2 })).toBe("dag@read-node@0@2");
  });

  it("explicit index=0/attempt=0 still selects the composite form (folding requires BOTH absent)", () => {
    expect(compositeNodeKey(N("read-node"), { index: 0 })).toBe("dag@read-node@0@0");
    expect(compositeNodeKey(N("read-node"), { attempt: 0 })).toBe("dag@read-node@0@0");
    expect(compositeNodeKey(N("read-node"), { index: 0, attempt: 0 })).toBe("dag@read-node@0@0");
  });

  it("full form: namespace@nodeId@index@attempt", () => {
    expect(compositeNodeKey(N("read-node"), { namespace: "sub", index: 3, attempt: 2 })).toBe(
      "sub@read-node@3@2",
    );
  });

  it("partial components default to 'dag'/0 while others are kept", () => {
    expect(compositeNodeKey(N("read-node"), { namespace: "sub", attempt: 4 })).toBe(
      "sub@read-node@0@4",
    );
    expect(compositeNodeKey(N("read-node"), { namespace: "sub", index: 7 })).toBe(
      "sub@read-node@7@0",
    );
  });

  it("accepts the full identifier charset and the safe-integer bound", () => {
    expect(compositeNodeKey(N("ns:node-1_x"), { namespace: "a-b_c:d", index: MAX_SAFE })).toBe(
      `a-b_c:d@ns:node-1_x@${MAX_SAFE}@0`,
    );
  });
});

describe("compositeNodeKey — hostile inputs rejected (typed throws)", () => {
  const hostileNodeIds = ["", "..", "a b", "evil@node", "a@b@c", "path/../x", id128 + "y"];
  for (const bad of hostileNodeIds) {
    it(`throws on nodeId ${JSON.stringify(bad)} — even on the folded path`, () => {
      expect(() => compositeNodeKey(rawNodeId(bad))).toThrow();
      expect(() => compositeNodeKey(rawNodeId(bad), { index: 1 })).toThrow();
    });
  }

  const hostileNamespaces = ["", "..", "sub space", "evil@ns", "ns/../x", id128 + "y", "@"];
  for (const bad of hostileNamespaces) {
    it(`throws on namespace ${JSON.stringify(bad)}`, () => {
      expect(() => compositeNodeKey(N("read-node"), { namespace: bad, index: 1 })).toThrow();
    });
  }

  const hostileNumbers: unknown[] = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SAFE + 1, "1", null, { index: 1 }];

  it("throws on non-string id components smuggled past the brand (no regex coercion)", () => {
    // `ID_PATTERN.test(42)` coerces to "42" and would pass — the typeof guard
    // must make a bypassed brand with a number fail closed (mirrors
    // ids.ts's `validate()`).
    expect(() => compositeNodeKey(rawNodeId(42 as unknown as string))).toThrow();
    expect(() => compositeNodeKey(rawNodeId(42 as unknown as string), { index: 1 })).toThrow();
    expect(() => compositeNodeKey(rawNodeId(true as unknown as string), { index: 1 })).toThrow();
    expect(() => compositeNodeKey(rawNodeId(NaN as unknown as string), { index: 1 })).toThrow();
    expect(() =>
      compositeNodeKey(N("read-node"), { namespace: 42 as unknown as string, index: 1 }),
    ).toThrow();
    expect(() =>
      compositeNodeKey(N("read-node"), { namespace: false as unknown as string, index: 1 }),
    ).toThrow();
    // parse side: a number cast through is rejected by the top-level guard.
    expect(parseCompositeNodeKey(42 as unknown as string)).toBeNull();
    expect(parseCompositeNodeKey(true as unknown as string)).toBeNull();
  });

  for (const bad of hostileNumbers) {
    it(`throws on index ${String(bad)}`, () => {
      expect(() => compositeNodeKey(N("read-node"), { index: bad as number })).toThrow();
    });
    it(`throws on attempt ${String(bad)}`, () => {
      expect(() => compositeNodeKey(N("read-node"), { attempt: bad as number })).toThrow();
    });
  }

  // Round-9 C1/A2 — typeof-first ordering + total-message pins. `Number.isSafeInteger`
  // never traps (non-coercing), but the conjunction's TAIL (`value >= 0`) applies
  // ToNumber: a re-ordered guard would trap on a `valueOf`-bearing hostile and the
  // codec would reject RAW with the hostile's own error text. The rejection must
  // name the CODEC'S rule — "expected a non-negative safe integer" — proving the
  // guard rejected before any coercion was observed. The `toString` twin pins the
  // message template's totality: `String(value)` calls the value's `toString`, so
  // the pre-round-9 diagnostic trapped inside the codec's own rejection (raw
  // "toString exploded"); `safeDiagnosticRender` renders via the object tag first.
  const throwingValueOf = { valueOf: () => { throw new Error("valueOf exploded"); } };
  const throwingToString = { toString: () => { throw new Error("toString exploded"); } };
  for (const hostile of [throwingValueOf, throwingToString]) {
    for (const kind of ["index", "attempt"] as const) {
      it(`rejects a throwing-hook ${kind} with the codec's own typed message (never a raw trap)`, () => {
        expect(() => compositeNodeKey(N("read-node"), { [kind]: hostile as unknown as number }))
          .toThrow("expected a non-negative safe integer");
        // And the hostile's error text must not escape — that would be a raw trap.
        try {
          compositeNodeKey(N("read-node"), { [kind]: hostile as unknown as number });
          throw new Error("expected the codec to reject the hostile value");
        } catch (error) {
          expect((error as Error).message).not.toContain("exploded");
        }
      });
    }
  }
});

describe("parseCompositeNodeKey — classification", () => {
  it("0 separators ⇒ canonical", () => {
    expect(parseCompositeNodeKey("read-node")).toEqual({ form: "canonical", nodeId: "read-node" });
    expect(parseCompositeNodeKey("a")).toEqual({ form: "canonical", nodeId: "a" });
    expect(parseCompositeNodeKey("ns:node-1_x")).toEqual({ form: "canonical", nodeId: "ns:node-1_x" });
  });

  it("exactly 3 separators ⇒ composite with component re-validation", () => {
    expect(parseCompositeNodeKey("dag@read-node@3@2")).toEqual({
      form: "composite",
      namespace: "dag",
      nodeId: "read-node",
      index: 3,
      attempt: 2,
    });
    expect(parseCompositeNodeKey("sub@read-node@0@0")).toEqual({
      form: "composite",
      namespace: "sub",
      nodeId: "read-node",
      index: 0,
      attempt: 0,
    });
    expect(parseCompositeNodeKey(`a-b_c:d@ns:node-1_x@${MAX_SAFE}@${MAX_SAFE}`)).toEqual({
      form: "composite",
      namespace: "a-b_c:d",
      nodeId: "ns:node-1_x",
      index: MAX_SAFE,
      attempt: MAX_SAFE,
    });
  });

  it("1 or 2 separators ⇒ null", () => {
    expect(parseCompositeNodeKey("a@b")).toBeNull();
    expect(parseCompositeNodeKey("a@b@c")).toBeNull();
    expect(parseCompositeNodeKey("@")).toBeNull();
    expect(parseCompositeNodeKey("dag@read-node@3")).toBeNull();
  });

  it("4+ separators ⇒ null", () => {
    expect(parseCompositeNodeKey("a@b@c@d@e")).toBeNull();
    expect(parseCompositeNodeKey("dag@read-node@1@2@extra")).toBeNull();
  });

  it("composite components failing re-validation ⇒ null", () => {
    // namespace / nodeId
    expect(parseCompositeNodeKey("@read-node@0@0")).toBeNull();
    expect(parseCompositeNodeKey("sub space@read-node@0@0")).toBeNull();
    expect(parseCompositeNodeKey("sub@../node@0@0")).toBeNull();
    expect(parseCompositeNodeKey("sub@@0@0")).toBeNull();
    // index / attempt must be strict canonical decimals — non-negative safe integers
    expect(parseCompositeNodeKey("dag@read-node@x@0")).toBeNull();
    expect(parseCompositeNodeKey("dag@read-node@-1@0")).toBeNull();
    expect(parseCompositeNodeKey("dag@read-node@1.5@0")).toBeNull();
    expect(parseCompositeNodeKey("dag@read-node@+1@0")).toBeNull();
    expect(parseCompositeNodeKey("dag@read-node@01@0")).toBeNull(); // leading zero: never encoded
    expect(parseCompositeNodeKey("dag@read-node@0@ ")).toBeNull();
    expect(parseCompositeNodeKey(`dag@read-node@${MAX_SAFE + 1}@0`)).toBeNull(); // unsafe integer
  });

  it("malformed canonical keys (0 separators but out-of-contract) ⇒ null", () => {
    expect(parseCompositeNodeKey("")).toBeNull();
    expect(parseCompositeNodeKey("not valid!")).toBeNull();
    expect(parseCompositeNodeKey("..")).toBeNull();
    expect(parseCompositeNodeKey(id128 + "y")).toBeNull();
    expect(parseCompositeNodeKey(42 as unknown as string)).toBeNull();
  });
});

describe("round-trip — parse(encode(a)) deep-equals a", () => {
  interface Address {
    readonly nodeId: string;
    readonly opts?: CompositeNodeKeyOpts;
  }

  const expectRoundTrip = (address: Address, expected: ExpectedParse): void => {
    const key = compositeNodeKey(N(address.nodeId), address.opts);
    expect(parseCompositeNodeKey(key)).toEqual(expected);
  };

  it("canonical addresses", () => {
    expectRoundTrip({ nodeId: "a" }, { form: "canonical", nodeId: "a" });
    expectRoundTrip({ nodeId: "read-node" }, { form: "canonical", nodeId: "read-node" });
    expectRoundTrip({ nodeId: "ns:node-1_x" }, { form: "canonical", nodeId: "ns:node-1_x" });
    expectRoundTrip({ nodeId: id128 }, { form: "canonical", nodeId: id128 });
  });

  it("composite addresses", () => {
    expectRoundTrip(
      { nodeId: "read-node", opts: { index: 0 } },
      { form: "composite", namespace: "dag", nodeId: "read-node", index: 0, attempt: 0 },
    );
    expectRoundTrip(
      { nodeId: "read-node", opts: { index: 5, attempt: 9 } },
      { form: "composite", namespace: "dag", nodeId: "read-node", index: 5, attempt: 9 },
    );
    expectRoundTrip(
      { nodeId: "read-node", opts: { namespace: "sub", index: 2 } },
      { form: "composite", namespace: "sub", nodeId: "read-node", index: 2, attempt: 0 },
    );
    expectRoundTrip(
      { nodeId: "read-node", opts: { namespace: "sub", attempt: 4 } },
      { form: "composite", namespace: "sub", nodeId: "read-node", index: 0, attempt: 4 },
    );
    expectRoundTrip(
      { nodeId: "ns:node-1_x", opts: { namespace: "a-b_c:d", index: MAX_SAFE, attempt: MAX_SAFE } },
      { form: "composite", namespace: "a-b_c:d", nodeId: "ns:node-1_x", index: MAX_SAFE, attempt: MAX_SAFE },
    );
    expectRoundTrip(
      { nodeId: id128, opts: { namespace: id128, index: 0, attempt: 0 } },
      { form: "composite", namespace: id128, nodeId: id128, index: 0, attempt: 0 },
    );
  });

  it("canonical and composite forms never encode to the same key", () => {
    const canonical = compositeNodeKey(N("read-node"));
    const composite = compositeNodeKey(N("read-node"), { index: 0, attempt: 0 });
    expect(canonical).toBe("read-node");
    expect(composite).toBe("dag@read-node@0@0");
    expect(canonical).not.toBe(composite);
    // And the canonical key contains no separator, so it can never equal ANY composite key.
    expect(canonical.includes("@")).toBe(false);
  });
});

describe("collision-freedom", () => {
  it("canonical keys never contain '@' — for the entire ID charset", () => {
    const ids = ["a", "z", "A", "Z", "0", "9", "_", ":", "-", "ns:node-1_x", "a:b-c_d", id128];
    for (const id of ids) {
      const key = compositeNodeKey(N(id));
      expect(key.includes("@")).toBe(false);
      expect(key).toBe(id);
    }
  });

  it("every composite key contains '@' — so it can never collide with a canonical key", () => {
    const composites = [
      { index: 0 },
      { attempt: 0 },
      { index: 1 },
      { attempt: 1 },
      { namespace: "sub", index: 0, attempt: 0 },
      { namespace: "a-b_c:d", index: MAX_SAFE, attempt: MAX_SAFE },
    ];
    for (const opts of composites) {
      const key = compositeNodeKey(N("read-node"), opts);
      expect(key.includes("@")).toBe(true);
      const separators = key.split("").filter((c) => c === "@").length;
      expect(separators).toBe(3);
    }
  });

  it("distinct composite addresses ⇒ distinct keys (component-wise permutations)", () => {
    const nodeIds = ["read-node", "write-node", "read-node", "read-node"];
    const namespaces = [undefined, "sub", "sub", "other"];
    const indexes = [undefined, 1, 2, 1];
    const attempts = [undefined, undefined, undefined, 9];
    const keys = new Set<string>();
    const addresses = new Set<string>();
    for (let i = 0; i < nodeIds.length; i += 1) {
      // Immutable construction — `undefined` components mean "absent" to the codec.
      const opts = optsOf(namespaces[i], indexes[i], attempts[i]);
      const key = compositeNodeKey(N(nodeIds[i]), opts);
      keys.add(key);
      addresses.add(JSON.stringify([nodeIds[i], opts.namespace ?? null, opts.index ?? null, opts.attempt ?? null]));
    }
    expect(addresses.size).toBe(keys.size);

    // Explicit cross-product: same node, every single-component delta yields a new key.
    const deltas: Array<[CompositeNodeKeyOpts, CompositeNodeKeyOpts]> = [
      [{ index: 1 }, { index: 2 }],
      [{ attempt: 1 }, { attempt: 2 }],
      [{ namespace: "a", index: 1 }, { namespace: "b", index: 1 }],
      [{ index: 0 }, { index: 1, attempt: 0 }],
      [{ index: 1, attempt: 0 }, { index: 1, attempt: 1 }],
      [{ index: 0, attempt: 0 }, { namespace: "sub", index: 0, attempt: 0 }],
    ];
    for (const [a, b] of deltas) {
      expect(compositeNodeKey(N("read-node"), a)).not.toBe(compositeNodeKey(N("read-node"), b));
    }
  });
});

describe("fast-check properties", () => {
  // ID_PATTERN charset, bounded well under the 128-char cap so the property
  // explores many distinct ids per run.
  const idArb = fc.stringMatching(/^[A-Za-z0-9_:-]{1,20}$/);
  const maybeId = fc.option(idArb, { nil: undefined });
  const smallInt = fc.integer({ min: 0, max: 100_000 });
  const maybeInt = fc.option(smallInt, { nil: undefined });

  const addressArb = fc.record({
    nodeId: idArb,
    namespace: maybeId,
    index: maybeInt,
    attempt: maybeInt,
  });

  const toOpts = (a: { readonly nodeId: string; readonly namespace?: string; readonly index?: number; readonly attempt?: number }): CompositeNodeKeyOpts =>
    optsOf(a.namespace, a.index, a.attempt);

  const isCanonical = (a: { readonly index?: number; readonly attempt?: number }): boolean =>
    a.index === undefined && a.attempt === undefined;

  /** Valid addresses only: a namespace WITHOUT index/attempt is ambiguous and
   *  refused by the codec (ADR-0075 — the shape is unrepresentable). */
  const isValidAddress = (a: { readonly namespace?: string; readonly index?: number; readonly attempt?: number }): boolean =>
    !isCanonical(a) || a.namespace === undefined;

  it("parse(encode(a)) = a for every generated valid address", () => {
    fc.assert(
      fc.property(addressArb, (a) => {
        fc.pre(isValidAddress(a));
        const key = compositeNodeKey(N(a.nodeId), toOpts(a));
        const parsed = parseCompositeNodeKey(key);
        const expected: ExpectedParse = isCanonical(a)
          ? { form: "canonical", nodeId: a.nodeId }
          : {
              form: "composite",
              namespace: a.namespace ?? DEFAULT_NODE_NAMESPACE,
              nodeId: a.nodeId,
              index: a.index ?? 0,
              attempt: a.attempt ?? 0,
            };
        expect(parsed).toEqual(expected);
      }),
      { numRuns: 500 },
    );
  });

  it("addresses equal under the codec's normalization map to the same key (determinism)", () => {
    // Canonical form: the opts record is inert — `{}` and `undefined` are the
    // SAME address. (A namespace alone is rejected as ambiguous, so the
    // canonical form can never carry namespace intent.)
    expect(compositeNodeKey(N("read-node"))).toBe(compositeNodeKey(N("read-node"), {}));
    // @ts-expect-error — compile-time rejection is the advisory's invariant.
    expect(() => compositeNodeKey(N("read-node"), { namespace: "sub" })).toThrow(/ambiguous/);
    // Composite form: absent components and explicit defaults are the same
    // address — the twins the old `?? null` property key counted as distinct.
    expect(compositeNodeKey(N("read-node"), { index: 1 })).toBe(
      compositeNodeKey(N("read-node"), { namespace: "dag", index: 1 }),
    );
    expect(compositeNodeKey(N("read-node"), { index: 1, attempt: 0 })).toBe(
      compositeNodeKey(N("read-node"), { namespace: DEFAULT_NODE_NAMESPACE, index: 1, attempt: 0 }),
    );
    // Explicit `undefined` components are "absent" — the same address as omitted.
    const withUndefined: CompositeNodeKeyOpts = { namespace: undefined, index: 1, attempt: undefined };
    expect(compositeNodeKey(N("read-node"), withUndefined)).toBe(
      compositeNodeKey(N("read-node"), { index: 1 }),
    );
    // Canonical vs composite are DIFFERENT addresses even when the defaulted
    // components coincide — the form is part of the address.
    expect(compositeNodeKey(N("read-node"))).not.toBe(compositeNodeKey(N("read-node"), { index: 0, attempt: 0 }));
  });

  it("distinct composite addresses modulo default normalization ⇒ distinct keys (injectivity)", () => {
    fc.assert(
      fc.property(fc.array(addressArb, { minLength: 1, maxLength: 80 }), (addresses) => {
        // Scope: composite-form addresses only (index or attempt present).
        // The canonical form folds to the bare nodeId with the WHOLE opts
        // record inert, so general-space injectivity under this tuple would
        // be false (two canonical addresses differing only in namespace
        // encode identically) — and canonical vs composite keys are separated
        // by the "@" construction, never by tuple equality.
        const composite = addresses.filter((a) => a.index !== undefined || a.attempt !== undefined);
        const keyByAddress = new Map<string, string>();
        for (const a of composite) {
          // Normalize with the codec's own defaults BEFORE comparing:
          // {index: 1} and {namespace: "dag", index: 1} are the SAME
          // composite address and must map to the same key.
          const addressKey = JSON.stringify([
            a.nodeId,
            a.namespace ?? DEFAULT_NODE_NAMESPACE,
            a.index ?? 0,
            a.attempt ?? 0,
          ]);
          const key = compositeNodeKey(N(a.nodeId), toOpts(a));
          const prev = keyByAddress.get(addressKey);
          if (prev !== undefined) {
            expect(key).toBe(prev); // same address ⇒ same key (determinism)
          } else {
            keyByAddress.set(addressKey, key);
          }
        }
        // Injectivity on the distinct normalized composite addresses: N
        // distinct addresses must map to N distinct keys — a collision would
        // shrink the key set below the address set.
        expect(new Set(keyByAddress.values()).size).toBe(keyByAddress.size);
      }),
      { numRuns: 200 },
    );
  });

  it("canonical keys never contain '@'", () => {
    fc.assert(
      fc.property(addressArb, (a) => {
        if (!isCanonical(a)) return; // property scope: canonical (folded) addresses only
        fc.pre(isValidAddress(a)); // namespace-alone is not a valid address
        const key = compositeNodeKey(N(a.nodeId), toOpts(a));
        expect(key).toBe(a.nodeId);
        expect(key.includes("@")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("any composite key is unparseable as canonical and vice versa (form disjointness)", () => {
    fc.assert(
      fc.property(addressArb, (a) => {
        fc.pre(isValidAddress(a));
        const key = compositeNodeKey(N(a.nodeId), toOpts(a));
        const parsed = parseCompositeNodeKey(key);
        if (parsed === null) throw new Error("encoder output must always parse");
        expect(parsed.form === "canonical").toBe(isCanonical(a));
        expect(parsed.form === "composite").toBe(!isCanonical(a));
      }),
      { numRuns: 500 },
    );
  });
});

describe("InMemoryCheckpointer — composite opts (FR-023)", () => {
  afterEach(() => {
    __resetFrameworkLogger();
  });

  const meta = { dagId: D("dag-1"), startedAt: new Date("2026-08-12T00:00:00Z"), nodeCount: 1 };
  const nodeState = { nodeId: N("n1"), output: { x: 42 }, completedAt: new Date("2026-08-12T00:00:01Z") };

  it("storage and return behavior stay identical to a canonical save", async () => {
    const withOpts = new InMemoryCheckpointer();
    const canonical = new InMemoryCheckpointer();
    for (const cp of [withOpts, canonical]) {
      await cp.setMeta(R("run-1"), meta);
    }

    const withOptsResult = await withOpts.saveNode(
      R("run-1"),
      nodeState,
      { namespace: "sub", index: 3, attempt: 1 },
    );
    const canonicalResult = await canonical.saveNode(R("run-1"), nodeState);
    expect(withOptsResult).toEqual(canonicalResult);

    const a = await withOpts.load(R("run-1"));
    const b = await canonical.load(R("run-1"));
    expect(a).toEqual(b);
    if (a.ok && a.value !== null) {
      expect(Object.keys(a.value.nodes)).toEqual(["n1"]);
      expect(a.value.nodes["dag@n1@3@1"]).toBeUndefined();
    }
  });

  it("ignores every composite option shape, including malformed runtime values", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("run-1"), meta);
    const malformed = Object.freeze({ namespace: "../ignored", index: -1, attempt: Number.NaN });
    const result = await cp.saveNode(R("run-1"), nodeState, malformed);

    expect(result).toEqual({ ok: true, value: undefined });
    const loaded = await cp.load(R("run-1"));
    if (!loaded.ok || loaded.value === null) throw new Error("expected loaded state");
    expect(Object.keys(loaded.value.nodes)).toEqual(["n1"]);
  });

  it("emits no warning or other logger-observable behavior for composite options", async () => {
    const calls: string[] = [];
    setFrameworkLogger({
      debug: (message) => calls.push(`debug:${message}`),
      info: (message) => calls.push(`info:${message}`),
      warn: (message) => calls.push(`warn:${message}`),
      error: (message) => calls.push(`error:${message}`),
    });
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("run-1"), meta);
    await cp.saveNode(R("run-1"), nodeState, { index: 1, attempt: 2 });

    expect(calls).toEqual([]);
  });
});
