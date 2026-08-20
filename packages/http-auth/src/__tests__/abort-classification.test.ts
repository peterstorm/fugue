import { describe, expect, it } from "bun:test";
import { classifyAbort } from "../abort-classification.js";

const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe("classifyAbort", () => {
  it("classifies the package timeout reason before the fetch AbortError", () => {
    const controller = new AbortController();
    controller.abort(new Error("timeout"));
    expect(classifyAbort(controller.signal, namedError("AbortError", "aborted"))).toBe("timeout");
  });

  it("recognizes timeout-shaped errors when no signal is available", () => {
    expect(classifyAbort(undefined, namedError("TimeoutError", "deadline"))).toBe("timeout");
    expect(classifyAbort(undefined, new Error("timeout"))).toBe("timeout");
  });

  it("classifies caller and foreign cancellation as abort", () => {
    const controller = new AbortController();
    controller.abort();
    expect(classifyAbort(controller.signal, controller.signal.reason)).toBe("abort");
    expect(classifyAbort(undefined, namedError("AbortError", "cancelled"))).toBe("abort");
  });

  it("leaves ordinary network failures unclassified", () => {
    expect(classifyAbort(undefined, new Error("ECONNRESET"))).toBe("other");
    expect(classifyAbort(undefined, "socket closed")).toBe("other");
  });
});
