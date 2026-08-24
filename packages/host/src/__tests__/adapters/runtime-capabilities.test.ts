import { describe, expect, it } from "bun:test";
import { buildRuntimeCapabilities } from "../../adapters/runtime-capabilities.js";
import { makeConfig, testLogger } from "../fixtures/host-boot-fakes.js";

describe("buildRuntimeCapabilities", () => {
  it("always supplies the framework http and clock capabilities", async () => {
    const capabilities = await buildRuntimeCapabilities(makeConfig(), testLogger());
    const byName = new Map(capabilities.map((handle) => [handle.name, handle]));

    expect([...byName.keys()]).toEqual(["http", "clock"]);
    expect(byName.get("http")?.client).toBeDefined();
    expect(byName.get("clock")?.client).toBeDefined();
  });
});
