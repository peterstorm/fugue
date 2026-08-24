/**
 * Test helpers for branded freshness types.
 * Use these instead of raw object literals to satisfy Witness/ResourceName branding.
 */
import { witness, witnessValue, stampWitness, resourceName, __brandWitness, __brandResourceName, freshnessExecutionEpoch } from "../types/freshness.js";
import type { Witness, WitnessValue, ResourceName, FreshnessExecutionEpoch } from "../types/freshness.js";

export { witness, witnessValue, stampWitness, resourceName, __brandWitness, __brandResourceName, freshnessExecutionEpoch };
export type { Witness, WitnessValue, ResourceName, FreshnessExecutionEpoch };

/** Shorthand for creating a Witness in tests. Defaults to kind="version". */
export const mkWitness = (resource: string, value: string, kind: "version" | "etag" | "timestamp" | "lsn" | "idempotency-key" | "custom" = "version"): Witness =>
  witness(kind, resourceName(resource), value);

/** Shorthand for creating a ResourceName in tests. */
export const RN = (name: string): ResourceName => resourceName(name);

/** Shorthand for creating a durable freshness execution epoch in tests. */
export const FE = (value = 0): FreshnessExecutionEpoch => freshnessExecutionEpoch(value);
