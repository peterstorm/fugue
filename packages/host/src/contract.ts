/**
 * @fuguejs/host/contract — Pure library exports for DAG authors.
 *
 * This module exports the DagRegistration contract types and validation
 * WITHOUT triggering the host's main() bootstrap. Use this entry point
 * from DAG packages that need to import DagRegistration.
 *
 * Usage:
 *   import type { DagRegistration } from "@fuguejs/host/contract";
 *   import { DagRegistrationSchema, validateDagRegistration, resolveDefaults } from "@fuguejs/host/contract";
 */

export type {
  DagRegistration,
  DagRegistrationConfig,
  DagRegistrationMeta,
  ResolvedDagRegistration,
} from "./domain/dag-registration.js";

export {
  DagRegistrationSchema,
  validateDagRegistration,
  resolveDefaults,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
} from "./domain/dag-registration.js";

// fugue.yaml — exported so DAG repos can validate their deployment config in
// their own CI (pre-merge) instead of discovering a malformed file when the
// host's module loader skips the DAG at boot.
export type { FugueYaml } from "./domain/config.js";
export { FugueYamlSchema, parseFugueYaml } from "./domain/config.js";
