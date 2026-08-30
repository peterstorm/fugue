import { describe, expect, it } from "bun:test";
import { buildRuntimeCapabilities } from "../adapters/runtime-capabilities.js";
import { makeConfig } from "./fixtures/host-boot-fakes.js";

describe("runtime capability diagnostics", () => {
  it("keeps optional capability wiring successful when selection logging throws", async () => {
    const config = makeConfig({
      CDRATOR_URL: "https://cdrator.example.test",
      CDRATOR_AUTH_URL: "https://auth.example.test/token",
      CDRATOR_BRAND_KEY: "brand",
      CDRATOR_USERNAME: "operator",
      CDRATOR_PASSWORD: "secret",
    });
    const throwingLogger = {
      info: () => { throw new Error("logger transport unavailable"); },
      warn: () => { throw new Error("logger transport unavailable"); },
      error: () => { throw new Error("logger transport unavailable"); },
    };

    const capabilities = await buildRuntimeCapabilities(config, throwingLogger, { tenant: "acme" });

    expect(capabilities.map((handle) => handle.name)).toEqual(["http", "clock", "authedHttp"]);
  });
});
