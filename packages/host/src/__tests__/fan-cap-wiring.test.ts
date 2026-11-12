/**
 * Operator fan cap wiring for both host run paths (FR-030, FR-034).
 *
 * `FAN_CHILD_CONCURRENCY_MAX` is one host-wide ceiling on map-fan child
 * concurrency. `executeDag` (host.ts) builds its kernel options through the
 * exported `syncRunOptions` seam, whose cap argument is required, so a sync HTTP
 * run cannot be started without the operator cap. Resumable (HITL) slices build
 * theirs through `sliceRunOptions` (run-executor.ts), whose cap argument is
 * required in the same way and is fed by the executor's required
 * `fanConcurrencyCap` dependency. Both receive the one value the host config
 * parse brands; the executor-level proof that a non-default cap actually
 * reaches a running fan lives in run-executor.test.ts.
 *
 * Pins:
 *   - every resumable slice's kernel options carry the operator's branded cap.
 *   - the branded cap reaches `fanConcurrencyCap` unchanged, for the sequential
 *     setting (1), the default (8) and a larger value.
 *   - minting is passed through untouched, wired or not.
 *   - the options carry nothing else, so no per-run override can ride along.
 */

import { describe, it, expect } from "bun:test";
import { fanConcurrencyCap } from "@fuguejs/framework";
import type { RunOptions } from "@fuguejs/framework";
import { syncRunOptions } from "../host.js";
import { sliceRunOptions } from "../hitl/adapters/run-executor.js";

describe("syncRunOptions - a sync run carries the operator fan cap (FR-030)", () => {
  it.each([1, 8, 32])("forwards an operator cap of %i to the kernel options", (max) => {
    const cap = fanConcurrencyCap(max);

    const opts = syncRunOptions(cap, undefined);

    expect(opts.fanConcurrencyCap).toBe(cap);
    expect(opts.minting).toBeUndefined();
  });

  it("passes a wired minting authority through unchanged alongside the cap", () => {
    const cap = fanConcurrencyCap(2);
    const minting = { marker: "minting" } as unknown as NonNullable<RunOptions["minting"]>;

    const opts = syncRunOptions(cap, minting);

    expect(opts.minting).toBe(minting);
    expect(opts.fanConcurrencyCap).toBe(cap);
  });

  it("carries only minting and the cap, so no per-run override can ride along (FR-034)", () => {
    const opts = syncRunOptions(fanConcurrencyCap(4), undefined);

    expect(Object.keys(opts).sort()).toEqual(["fanConcurrencyCap", "minting"]);
  });
});

describe("sliceRunOptions - a resumable slice carries the operator fan cap (FR-030)", () => {
  type SliceArgs = Parameters<typeof sliceRunOptions>;
  type SliceRequest = SliceArgs[1];
  type SliceJob = SliceArgs[2];
  type SliceFence = SliceArgs[3];

  // Only the fields `sliceRunOptions` reads are populated; building the options
  // closes over the callbacks without invoking them.
  const request = {
    onHumanReview: async () => undefined,
    onDecisionConsumed: async () => undefined,
  } as unknown as SliceRequest;
  const job = { marker: "job" } as unknown as SliceJob;
  const fence = { assertAuthorized: () => undefined } as unknown as SliceFence;

  it.each([1, 8, 32])("forwards an operator cap of %i into the slice's kernel options", (max) => {
    const cap = fanConcurrencyCap(max);

    const opts = sliceRunOptions(cap, request, job, fence, undefined);

    expect(opts.fanConcurrencyCap).toBe(cap);
  });

  it("sets the cap whether or not a minting authority is wired", () => {
    const cap = fanConcurrencyCap(3);
    const minting = { marker: "minting" } as unknown as NonNullable<RunOptions["minting"]>;

    expect(sliceRunOptions(cap, request, job, fence, minting).fanConcurrencyCap).toBe(cap);
    expect(sliceRunOptions(cap, request, job, fence, undefined).fanConcurrencyCap).toBe(cap);
  });
});
