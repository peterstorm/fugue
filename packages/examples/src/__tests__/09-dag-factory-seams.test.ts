// Proves the point of 09-dag-factory-seams.ts: the factory's injected seams
// make an otherwise-untestable DAG (wall clock + live LLM) deterministic. We
// pin the clock and route the LLM node to a FakeLlmClient — both through
// `createReportDag(opts)`, with zero env or global mutation.

import { describe, it, expect } from "bun:test";
import { runDag, makeNodeContext } from "@fuguejs/framework";
import { FakeLlmClient } from "@fuguejs/framework/testing";
import { createReportDag } from "../../dags/09-dag-factory-seams.js";

const FIXED = new Date("2026-01-02T03:04:05.000Z");

describe("09 dag-factory-seams", () => {
  it("pins the clock and the LLM via the factory's seams", async () => {
    // Fake LLM keyed by the (fake) model id the factory wires in.
    const llm = new FakeLlmClient(
      new Map([["fake-model", { summary: "FAKE SUMMARY", confidence: "high" }]]),
    );
    const ctx = makeNodeContext({
      runId: "test-run",
      dagId: "factory-seams-report",
      llm,
      prompts: {
        get: (name: string) =>
          name === "report" ? "Subject: {{subject}} asOf: {{asOf}}" : null,
      },
    });

    const dag = createReportDag({ now: () => FIXED, model: "fake-model" });
    const result = await runDag(dag, { subject: "Q1" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        subject: "Q1",
        asOf: FIXED.toISOString(), // clock seam pinned — not the wall clock
        summary: "FAKE SUMMARY", // model seam routed to the fake
      });
    }
  });
});
