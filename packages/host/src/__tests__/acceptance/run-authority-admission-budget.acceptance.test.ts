/**
 * CT-1 acceptance — the run-start validation budget (AS-036, NFR-003).
 *
 * The lean variant of the behaviour tests' world (acceptance-world.ts), so the
 * measured path is theirs: a delegated HITL submission enters at
 * proxyToWorker, crosses an in-process UDS transport into a worker app
 * mounting createAuthMiddleware then createRunDagHandler in createRouter's
 * order, and is admitted by composeRunAuthorityWiring's two-pass admission:
 * realm JWT authentication, planning, the real Entra user-token verifier over
 * an in-process JWKS, claim validation and binding. hitl.startRun is a
 * recording observation point, so establishment (CT-3) is outside the measured
 * path. Every transport answers instantly, so each measured millisecond is
 * host-added; the warm-up absorbs the first signing-key fetch.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { proxyToWorker } from "../../supervisor/uds-proxy.js";
import { createAuthMiddleware } from "../../http/middleware/auth.js";
import { createRunDagHandler } from "../../http/handlers/run-dag.js";
import { errorResponse } from "../../http/response.js";
import { TEAM_A, acceptanceDag, createAcceptanceSigners, createAcceptanceWorld, identityDeploymentOf } from "./support/acceptance-world.js";
import type { AcceptanceSigners, RunPathSeams, Submission } from "./support/acceptance-world.js";
import { TIMED_SAMPLES, WARM_UP_ITERATIONS, measureLatency } from "./support/latency-budget.js";

const BUDGET_MS = 50;

const CALENDAR_READ = "msgraph:calendar.read";

const hitlDelegatedDag = acceptanceDag("hitl-delegated-dag", TEAM_A, [
  { id: "read", requires: [CALENDAR_READ], humanReview: true },
]);

/** The run path's production seams; the wiring module loads in the testcase, so while it is missing the testcase fails, not collection. */
const runPathSeams = async (): Promise<RunPathSeams> => {
  const { composeRunAuthorityWiring } = await import("../../adapters/run-authority-wiring.js");
  return { proxyToWorker, createAuthMiddleware, createRunDagHandler, errorResponse, composeRunAuthorityWiring };
};

let signers: AcceptanceSigners;

beforeAll(async () => {
  signers = await createAcceptanceSigners();
});

describe("CT-1 run-start validation budget", () => {
  test(
    "AS-036: run-start validation ≤ 50 ms p95 through proxyToWorker",
    async () => {
      const world = await createAcceptanceWorld({
        seams: await runPathSeams(),
        signers,
        dags: { hitlDelegated: hitlDelegatedDag },
        catalog: { [CALENDAR_READ]: { authority: "delegated", resource: "graph" } },
        deployment: identityDeploymentOf({ mappedDags: [hitlDelegatedDag.id] }),
        variant: { kind: "lean" },
      });
      const submission: Submission<"hitlDelegated"> = {
        dag: "hitlDelegated",
        authorization: `Bearer ${await world.realmUserToken()}`,
        delegated: `Bearer ${await world.entraUserToken()}`,
      };

      const report = await measureLatency({
        label: "AS-036 run-start validation through proxyToWorker",
        budgetMs: BUDGET_MS,
        warmUps: WARM_UP_ITERATIONS,
        samples: TIMED_SAMPLES,
        prepare: () => world.requestOf(submission),
        run: async (inbound) => {
          const { status } = await world.forward(inbound);
          if (status !== 202) throw new Error(`expected an admitted 202, got ${status}`);
        },
      });

      // Every sample was admitted through the real verifier, over one cached signing-key fetch.
      expect(world.observed.hitlStarts.length).toBe(WARM_UP_ITERATIONS + TIMED_SAMPLES);
      expect(world.fakes.requests.entraJwks).toHaveLength(1);
      expect(world.fakes.onBehalfOfExchanges()).toHaveLength(0);
      expect(report.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
    },
    120_000,
  );
});
