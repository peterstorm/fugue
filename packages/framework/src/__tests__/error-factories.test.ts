/**
 * Unit tests for error factory functions (`frameworkError.*`).
 *
 * Validates:
 * - Each factory produces the correct `kind` discriminant
 * - String node IDs are branded via smart constructor
 * - Optional fields are correctly included/excluded
 */

import { describe, it, expect } from "bun:test";
import { frameworkError } from "../types/error-factories.js";
import { nodeId } from "../types/ids.js";
import { N } from "./_id-helpers.js";

describe("frameworkError factories", () => {
  describe("validation", () => {
    it("produces kind=validation with branded nodeId from string", () => {
      const e = frameworkError.validation("myNode", "bad input");
      expect(e.kind).toBe("validation");
      if (e.kind === "validation") {
        expect(e.nodeId).toBe(nodeId("myNode"));
        expect(e.message).toBe("bad input");
        expect(e.path).toBeUndefined();
      }
    });

    it("includes path when provided", () => {
      const e = frameworkError.validation("n", "msg", "/foo/bar");
      if (e.kind === "validation") {
        expect(e.path).toBe("/foo/bar");
      }
    });

    it("accepts pre-branded NodeId", () => {
      const e = frameworkError.validation(N("n"), "msg");
      if (e.kind === "validation") {
        expect(e.nodeId).toBe(N("n"));
      }
    });
  });

  describe("nodeCrash", () => {
    it("defaults to retriable", () => {
      const e = frameworkError.nodeCrash("n", "boom");
      if (e.kind === "node-crash") {
        expect(e.retriability).toBe("retriable");
        expect(e.message).toBe("boom");
        expect(e.stack).toBeUndefined();
      }
    });

    it("respects non-retriable override", () => {
      const e = frameworkError.nodeCrash("n", "perm", { retriability: "non-retriable" });
      if (e.kind === "node-crash") {
        expect(e.retriability).toBe("non-retriable");
      }
    });

    it("includes stack when provided", () => {
      const e = frameworkError.nodeCrash("n", "msg", { stack: "Error: msg\n  at ..." });
      if (e.kind === "node-crash") {
        expect(e.stack).toBe("Error: msg\n  at ...");
      }
    });
  });

  describe("transient", () => {
    it("produces kind=transient", () => {
      const e = frameworkError.transient("n", "rate limited");
      expect(e.kind).toBe("transient");
      if (e.kind === "transient") {
        expect(e.message).toBe("rate limited");
      }
    });

    it("includes httpStatus when provided", () => {
      const e = frameworkError.transient("n", "not found", 404);
      if (e.kind === "transient") {
        expect(e.httpStatus).toBe(404);
      }
    });

    it("omits httpStatus when not provided (no undefined-valued key)", () => {
      const e = frameworkError.transient("n", "rate limited");
      if (e.kind === "transient") {
        expect(e.httpStatus).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(e, "httpStatus")).toBe(false);
      }
    });
  });

  describe("missingCapability", () => {
    it("single miss → missing tuple of length 1 carrying the branded nodeId", () => {
      const e = frameworkError.missingCapability("fetch-users", "llm");
      expect(e.kind).toBe("missing-capability");
      if (e.kind === "missing-capability") {
        expect(e.missing).toHaveLength(1);
        expect(e.missing[0].nodeId).toBe(nodeId("fetch-users"));
        expect(e.missing[0].capability).toBe("llm");
      }
    });

    it("head + rest → ordered tuple, head first", () => {
      const e = frameworkError.missingCapability("a", "llm", [
        { nodeId: "b", capability: "cache" },
        { nodeId: "c", capability: "prompts" },
      ]);
      if (e.kind === "missing-capability") {
        expect(e.missing).toHaveLength(3);
        expect(e.missing.map((m) => [String(m.nodeId), m.capability])).toEqual([
          ["a", "llm"],
          ["b", "cache"],
          ["c", "prompts"],
        ]);
      }
    });

    it("brands string node IDs across head and rest", () => {
      const e = frameworkError.missingCapability("a", "llm", [{ nodeId: "b", capability: "cache" }]);
      if (e.kind === "missing-capability") {
        expect(e.missing[0].nodeId).toBe(N("a"));
        expect(e.missing[1].nodeId).toBe(N("b"));
      }
    });
  });

  describe("rejected", () => {
    it("produces kind=rejected", () => {
      const e = frameworkError.rejected("n", "quality too low");
      expect(e.kind).toBe("rejected");
      if (e.kind === "rejected") {
        expect(e.reason).toBe("quality too low");
      }
    });
  });

  describe("invalidReroute", () => {
    it("produces kind=invalid-reroute", () => {
      const e = frameworkError.invalidReroute("target", "no such node");
      expect(e.kind).toBe("invalid-reroute");
      if (e.kind === "invalid-reroute") {
        expect(e.targetNodeId).toBe(nodeId("target"));
        expect(e.message).toBe("no such node");
      }
    });
  });
});
