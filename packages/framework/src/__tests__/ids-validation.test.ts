import { describe, it, expect } from "bun:test";
import { runId, nodeId, dagId } from "../types/ids.js";

describe("branded ID validation", () => {
  describe("nodeId", () => {
    it("accepts valid identifiers", () => {
      expect(nodeId("fetch-crm")).toBeDefined();
      expect(nodeId("node_1")).toBeDefined();
      expect(nodeId("a:b:c")).toBeDefined();
      expect(nodeId("A")).toBeDefined();
      expect(nodeId("a".repeat(128))).toBeDefined();
    });

    it("rejects empty strings", () => {
      expect(() => nodeId("")).toThrow(/must match/);
    });

    it("rejects strings over 128 chars", () => {
      expect(() => nodeId("a".repeat(129))).toThrow(/must match/);
    });

    it("rejects strings with spaces", () => {
      expect(() => nodeId("hello world")).toThrow(/must match/);
    });

    it("rejects strings with path traversal characters", () => {
      expect(() => nodeId("../foo")).toThrow(/must match/);
      expect(() => nodeId("a/b")).toThrow(/must match/);
    });

    it("rejects strings with special characters", () => {
      expect(() => nodeId("node@1")).toThrow(/must match/);
      expect(() => nodeId("node#1")).toThrow(/must match/);
      expect(() => nodeId("node 1")).toThrow(/must match/);
    });
  });

  describe("runId", () => {
    it("accepts valid UUIDs and namespaced IDs", () => {
      expect(runId("abc-123")).toBeDefined();
      expect(runId("tenant:run-abc")).toBeDefined();
    });

    it("rejects empty strings", () => {
      expect(() => runId("")).toThrow(/must match/);
    });

    it("rejects invalid characters", () => {
      expect(() => runId("run id")).toThrow(/must match/);
    });
  });

  describe("dagId", () => {
    it("accepts valid dag identifiers", () => {
      expect(dagId("customer-summary")).toBeDefined();
      expect(dagId("dag_v2")).toBeDefined();
    });

    it("rejects empty strings", () => {
      expect(() => dagId("")).toThrow(/must match/);
    });
  });
});
