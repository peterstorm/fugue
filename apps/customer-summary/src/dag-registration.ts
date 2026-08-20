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
// Input boundary — preserve server.ts's snake-case /summarize wire contract,
// then translate once into the DAG's camel-case domain input.
// ---------------------------------------------------------------------------

export const SummarizeInputSchema = z.object({
  customer_id: z.string().min(1),
  resume_run_id: z.string().optional(),
}).transform(({ customer_id, resume_run_id }) => ({
  customerId: customer_id,
  ...(resume_run_id !== undefined ? { resume_run_id } : {}),
}));

// ---------------------------------------------------------------------------
// DAG factory — creates a summary DAG with a default fixture source.
//
// The source is construction-scoped infrastructure. Customer identity is
// request-scoped domain data: explicit DAG-input edges deliver the parsed
// `customerId` to both fetching and response assembly, so every response
// variant is correlated to the request that produced it.
// ---------------------------------------------------------------------------

const createRegisteredDag = () => {
  // Resolve fixtures relative to this module, not process CWD. This keeps the
  // registration loadable by both the standalone server and Fugue host.
  const fixturesDir = join(import.meta.dir, "..", "fixtures", "customers");
  const defaultSource = new JsonFixtureSource(fixturesDir);
  return createSummaryDag(defaultSource);
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
