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

  describe("checkpointWriteFailed", () => {
    it("preserves the required branded runId/nodeId shape after narrowing", () => {
      const error = frameworkError.checkpointWriteFailed("run-write", "node-write", "disk full");
      expect(error.kind).toBe("checkpoint-write-failed");
      if (error.kind === "checkpoint-write-failed") {
        expect(String(error.runId)).toBe("run-write");
        expect(String(error.nodeId)).toBe("node-write");
        expect(error.invalidRunId).toBeUndefined();
        expect(error.invalidNodeId).toBeUndefined();
      }
    });

    it("truthful branding: an invalid raw id never inhabits the branded field — the documented placeholder takes it and the rejected RAW bytes are preserved additively", () => {
      const error = frameworkError.checkpointWriteFailed("../escape", "not a valid id!", "disk full");
      expect(error.kind).toBe("checkpoint-write-failed");
      if (error.kind === "checkpoint-write-failed") {
        expect(String(error.runId)).toBe("checkpoint_invalid_run");
        expect(String(error.nodeId)).toBe("checkpoint_invalid_node");
        expect(error.invalidRunId).toBe("../escape");
        expect(error.invalidNodeId).toBe("not a valid id!");
        expect(error.message).toBe("disk full");
      }
    });

    it("never throws for hostile raw ids — a raw throw from an error constructor would violate the FR-040 surface (the documented invalid* case is constructable through the public factory)", () => {
      const hostileRunId = {
        toString: () => {
          throw new Error("boom");
        },
      } as unknown as string;
      expect(() =>
        frameworkError.checkpointWriteFailed(hostileRunId, "ok-node", "disk full"),
      ).not.toThrow();
      const error = frameworkError.checkpointWriteFailed(hostileRunId, "ok-node", "disk full");
      expect(error.kind).toBe("checkpoint-write-failed");
      if (error.kind === "checkpoint-write-failed") {
        expect(String(error.runId)).toBe("checkpoint_invalid_run");
        expect(error.invalidRunId).toBe("<unprintable>");
        expect(String(error.nodeId)).toBe("ok-node");
        expect(error.invalidNodeId).toBeUndefined();
      }
    });

    it("a numeric brand bypass (non-string at runtime) routes through the placeholder, not a raw throw", () => {
      const numericRunId = 42 as unknown as string;
      expect(() => frameworkError.checkpointWriteFailed(numericRunId, "ok-node", "disk full")).not.toThrow();
      const error = frameworkError.checkpointWriteFailed(numericRunId, "ok-node", "disk full");
      if (error.kind === "checkpoint-write-failed") {
        expect(String(error.runId)).toBe("checkpoint_invalid_run");
        expect(error.invalidRunId).toBe("42");
        expect(String(error.nodeId)).toBe("ok-node");
      }
    });
  });

  describe("other factories keep the brand-constructor invariant (invalid plain strings throw)", () => {
    it("transient still throws for a grammar-invalid nodeId — only checkpointWriteFailed is the documented exception", () => {
      expect(() => frameworkError.transient("bad id with spaces", "nope")).toThrow();
      const branded = frameworkError.transient(nodeId("ok-node"), "nope");
      expect(branded.kind).toBe("transient");
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
