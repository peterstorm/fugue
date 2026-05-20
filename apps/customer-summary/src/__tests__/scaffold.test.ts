import { describe, test, expect } from "bun:test";

describe("scaffolding", () => {
  test("customer-summary entry point exists", async () => {
    // Verify the bootstrap module can be loaded without side effects.
    // We import bootstrap (not index) to avoid triggering the top-level
    // bootstrap() call which starts real OTLP exporters that fail with
    // unhandled rejections when MLflow is unavailable.
    const mod = await import("../bootstrap.js");
    expect(mod.bootstrap).toBeFunction();
  });
});
