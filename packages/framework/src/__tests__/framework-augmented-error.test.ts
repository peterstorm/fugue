/**
 * Unit tests for `FrameworkAugmentedError`.
 *
 * Validates:
 * - Preserves `frameworkErrorKind` and `frameworkErrorJson`
 * - `cause` is set to the original FrameworkError
 * - JSON round-trip of `frameworkErrorJson` recovers the original error
 * - `name` is set to "FrameworkAugmentedError"
 */

import { describe, it, expect } from "bun:test";
import { FrameworkAugmentedError } from "../types/errors.js";
import type { FrameworkError } from "../types/errors.js";
import { N } from "./_id-helpers.js";

describe("FrameworkAugmentedError", () => {
  const sampleError: FrameworkError = {
    kind: "node-crash",
    nodeId: N("myNode"),
    retriability: "retriable",
    message: "something broke",
  };

  it("is an instanceof Error", () => {
    const err = new FrameworkAugmentedError("msg", sampleError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name = 'FrameworkAugmentedError'", () => {
    const err = new FrameworkAugmentedError("msg", sampleError);
    expect(err.name).toBe("FrameworkAugmentedError");
  });

  it("preserves the message", () => {
    const err = new FrameworkAugmentedError("DAG failed", sampleError);
    expect(err.message).toBe("DAG failed");
  });

  it("frameworkErrorKind matches the error kind", () => {
    const err = new FrameworkAugmentedError("msg", sampleError);
    expect(err.frameworkErrorKind).toBe("node-crash");
  });

  it("frameworkErrorJson round-trips to the original error", () => {
    const err = new FrameworkAugmentedError("msg", sampleError);
    const parsed = JSON.parse(err.frameworkErrorJson);
    expect(parsed.kind).toBe("node-crash");
    expect(parsed.nodeId).toBe("myNode");
    expect(parsed.message).toBe("something broke");
    expect(parsed.retriability).toBe("retriable");
  });

  it("cause is set to the original FrameworkError", () => {
    const err = new FrameworkAugmentedError("msg", sampleError);
    expect(err.cause).toBe(sampleError);
  });

  it("works with different error kinds", () => {
    const aborted: FrameworkError = { kind: "aborted", reason: "timeout" };
    const err = new FrameworkAugmentedError("aborted", aborted);
    expect(err.frameworkErrorKind).toBe("aborted");
    expect(JSON.parse(err.frameworkErrorJson)).toEqual(aborted);
  });

  it("works with retry-exhausted error", () => {
    const exhausted: FrameworkError = {
      kind: "retry-exhausted",
      nodeId: N("n"),
      attempts: 3,
      lastError: "boom",
      rootErrorKind: "transient",
    };
    const err = new FrameworkAugmentedError("msg", exhausted);
    expect(err.frameworkErrorKind).toBe("retry-exhausted");
    const parsed = JSON.parse(err.frameworkErrorJson);
    expect(parsed.attempts).toBe(3);
    expect(parsed.rootErrorKind).toBe("transient");
  });
});
