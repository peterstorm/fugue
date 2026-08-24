/**
 * Regression: the resolution path and the stock byte-I/O path must agree on what
 * `requestTimeoutMs` MEANS. They used to disagree on a non-positive value — the
 * stock `buildSignal` treated it as "no timeout" while the wrapper applied
 * `AbortSignal.timeout(0)`, aborting every resolution request instantly.
 */

import { describe, it, expect } from "bun:test";
import { buildSignal } from "../request-signal.js";
import { createPathResolvingMsGraphAdapter } from "../path-resolving.js";

describe("buildSignal — one meaning for the timeout knob", () => {
  it("treats a non-positive timeout as NO timeout", () => {
    expect(buildSignal(undefined, 0)).toBeUndefined();
    expect(buildSignal(undefined, -1)).toBeUndefined();
  });

  it("returns the caller signal unwrapped when there is no timeout", () => {
    const caller = new AbortController().signal;
    expect(buildSignal({ signal: caller }, 0)).toBe(caller);
  });

  it("composes caller + timeout when both are present", () => {
    const caller = new AbortController().signal;
    const composed = buildSignal({ signal: caller }, 1_000);
    expect(composed).toBeDefined();
    expect(composed).not.toBe(caller);
  });

  it("applies a timeout alone when there is no caller signal", () => {
    expect(buildSignal(undefined, 1_000)).toBeDefined();
  });
});

describe("path-resolving adapter honours the shared signal contract", () => {
  it("attaches NO timeout signal to resolution requests when requestTimeoutMs opts out", async () => {
    // The divergence this closes: the stock byte-I/O path read `requestTimeoutMs: 0`
    // as "no timeout" (no signal at all), while the wrapper's inline composition
    // attached `AbortSignal.timeout(0)` — which fires on the next turn and aborts
    // every resolution request. Same config object, two meanings.
    const signals: (AbortSignal | null | undefined)[] = [];
    const handle = createPathResolvingMsGraphAdapter({
      getAccessToken: async () => "token",
      requestTimeoutMs: 0,
      fetchImpl: async (_url, init) => {
        signals.push(init?.signal);
        return new Response(JSON.stringify({ id: "site-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    // Any call that reaches `graphJson`; the resolution chain may end in an
    // error once the canned payload runs out — the signal handed to the FIRST
    // request is what this pins.
    await handle.listFolder("contoso.sharepoint.com", "/sites/Finance", "/workbooks");

    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0] ?? undefined).toBeUndefined();
  });
});
