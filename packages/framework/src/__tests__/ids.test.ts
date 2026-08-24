import { describe, expect, it } from "bun:test";
import {
  __brandDagId,
  dagId,
  tryDagId,
} from "../types/ids.js";

describe("DagId constructors", () => {
  it("keeps the public and validating internal constructors on the same no-colon grammar", () => {
    expect(String(dagId("tenant-dag"))).toBe("tenant-dag");
    expect(String(__brandDagId("tenant_dag"))).toBe("tenant_dag");
    expect(() => dagId("tenant:dag")).toThrow(/colons not allowed/i);
    expect(() => __brandDagId("tenant:dag")).toThrow(/colons not allowed/i);
    expect(tryDagId("tenant:dag").ok).toBe(false);
  });
});
