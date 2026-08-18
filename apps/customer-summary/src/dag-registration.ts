/**
 * DagRegistration — host-compatible contract for the customer-summary DAG.
 *
 * Re-expresses the existing customer-summary DAG as a DagRegistration default export.
 * The standalone server.ts remains for backward compatibility during migration;
 * this module is the NEW contract consumed by the Fugue host.
 *
 * @satisfies host spec SC-004 — Existing integration tests pass unchanged
 * @satisfies host spec FR-011 — Custom route override (/summarize) for backward compatibility
 */

import { z } from "zod";
import type { DagRegistration } from "@fuguejs/host/contract";
import { createSummaryDag } from "./dag/summary-dag.js";
import { join } from "node:path";
import { JsonFixtureSource } from "./sources/json-fixture-source.js";

// ---------------------------------------------------------------------------
// Input schema — extracted from server.ts SummarizeRequestSchema
// ---------------------------------------------------------------------------

export const SummarizeInputSchema = z.object({
  customerId: z.string().min(1),
  resume_run_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// DAG factory — creates a summary DAG with a default fixture source.
//
// NOTE: The existing createSummaryDag requires a ConversationSource and
// customerId at construction time (DAG nodes close over them). For the host
// registration, we create the DAG with a placeholder source; the actual
// source resolution happens per-request inside the node's execute() function
// via NodeContext (the node already handles this pattern internally).
//
// In the host model, per-request parameters (customer_id) arrive via the
// validated input payload and are threaded through node execution context.
// The DAG structure itself is static.
// ---------------------------------------------------------------------------

const createRegisteredDag = () => {
  // The fixture source is used as the default for standalone mode.
  // When hosted, the source is injected per-request via NodeContext.
  // Resolve fixtures relative to this module, not process CWD.
  // Ensures the DAG works whether loaded by the standalone server or the Fugue host.
  const fixturesDir = join(import.meta.dir, "..", "fixtures", "customers");
  const defaultSource = new JsonFixtureSource(fixturesDir);
  return createSummaryDag(defaultSource, "placeholder");
};

// ---------------------------------------------------------------------------
// DagRegistration — default export consumed by the Fugue host
// ---------------------------------------------------------------------------

const registration: DagRegistration = {
  dag: createRegisteredDag(),
  inputSchema: SummarizeInputSchema,
  route: "/summarize",
  config: {
    timeoutMs: 90_000,
    maxConcurrent: 5,
  },
  meta: {
    description: "Customer summary DAG — generates structured summaries from CRM data",
    version: "1.0.0",
  },
};

export default registration;
