// @fugue/framework/testing — stable subpath for test utilities.
// FakeLlmClient is also reachable from the main barrel (via llm/index.ts)
// for convenience; this subpath exists as the documented, stable import
// path for test tooling.

export { FakeLlmClient } from "./llm/fake-client.js";
export { createFakeHttpCapability, type FakeHttpRoute } from "./http/http-capability.js";
