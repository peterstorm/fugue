/**
 * @fugue/host/contract — Pure library exports for DAG authors.
 *
 * This module exports the DagRegistration contract types and validation
 * WITHOUT triggering the host's main() bootstrap. Use this entry point
 * from DAG packages that need to import DagRegistration.
 *
 * Usage:
 *   import type { DagRegistration } from "@fugue/host/contract";
 *   import { DagRegistrationSchema, validateDagRegistration, resolveDefaults } from "@fugue/host/contract";
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
