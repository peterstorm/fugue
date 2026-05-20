/**
 * Test helpers for branded freshness types.
 * Use these instead of raw object literals to satisfy Witness/ResourceName branding.
 */
import { witness, resourceName, __brandWitness, __brandResourceName } from "../types/freshness.js";
import type { Witness, ResourceName } from "../types/freshness.js";

export { witness, resourceName, __brandWitness, __brandResourceName };
export type { Witness, ResourceName };

/** Shorthand for creating a Witness in tests. Defaults to kind="version". */
export const mkWitness = (resource: string, value: string, kind: "version" | "etag" | "timestamp" | "lsn" | "idempotency-key" | "custom" = "version"): Witness =>
  witness(kind, resource, value);

/** Shorthand for creating a ResourceName in tests. */
export const RN = (name: string): ResourceName => resourceName(name);
