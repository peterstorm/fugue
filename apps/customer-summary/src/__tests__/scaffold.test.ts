import { describe, test, expect } from "bun:test";

describe("scaffolding", () => {
  test("customer-summary entry point exists", async () => {
    // Just verify the module can be loaded
    const mod = await import("../index.js");
    expect(mod).toBeDefined();
  });
});
