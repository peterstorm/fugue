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
// NOTE: createSummaryDag requires a ConversationSource and customerId at
// construction time (DAG nodes close over them: createFetchCustomerNode closes
// over the source; createAssembleResponseNode closes over the customerId). For
// the host registration we pass a REAL fixture source (JsonFixtureSource) with
// a placeholder customerId — the fetch node consumes the per-request
// customer_id from the validated input payload via node execution context, so
// the DAG structure itself is static while the customer comes from the request.
// ---------------------------------------------------------------------------

const createRegisteredDag = () => {
  // The fixture source is the default for standalone mode; when hosted, the
  // per-request customerId arrives via the validated input payload (the
  // customerId "placeholder" below is only the assembly node's closure).
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
