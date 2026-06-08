/**
 * Test helpers for branded freshness types.
 * Use these instead of raw object literals to satisfy Witness/ResourceName branding.
 */
import { witness, witnessValue, stampWitness, resourceName, __brandWitness, __brandResourceName } from "../types/freshness.js";
import type { Witness, WitnessValue, ResourceName } from "../types/freshness.js";

export { witness, witnessValue, stampWitness, resourceName, __brandWitness, __brandResourceName };
export type { Witness, WitnessValue, ResourceName };

/** Shorthand for creating a Witness in tests. Defaults to kind="version". */
export const mkWitness = (resource: string, value: string, kind: "version" | "etag" | "timestamp" | "lsn" | "idempotency-key" | "custom" = "version"): Witness =>
  witness(kind, resource, value);

/** Shorthand for creating a ResourceName in tests. */
export const RN = (name: string): ResourceName => resourceName(name);
