/**
 * THE defence against hostile values crossing an extension boundary.
 *
 * A broker plugin, an LLM client, a pricing model, or a persisted ledger record
 * is data this process did not author. Reading it with `value.field` trusts
 * whatever the author put on the prototype chain or behind a getter: an
 * accessor can return a different answer on each read (so a value validated
 * once is not the value later used), throw mid-parse, or be revoked. Every such
 * boundary in this codebase therefore reads through property DESCRIPTORS and
 * accepts only own DATA properties.
 *
 * That rule was hand-rolled five times before round 14 — `types/spend.ts`
 * (`ownValue`, `parseModelArray`), `dag-runtime/run-node.ts` (`readOwnData`),
 * `dag-runtime/run-dag-stateful.ts` (`snapshotOrigin`'s local closures),
 * `host/adapters/metered-llm.ts` (`snapshotDataObject`, `snapshotDataArray`,
 * `snapshotPricingModel`), and `host/adapters/run-spend-authority.ts`
 * (`ownDataValue`) — where a fix to the algorithm had five places to land and
 * nothing kept them in step. `run-node.ts`'s own comment claimed to be "ONE
 * encoding of the getter/proxy defence", which held only inside that file.
 *
 * These functions report failure as STRUCTURED DATA, never as a rendered
 * message: call sites disagree about wording ("Spend.usd.models", "scoped
 * binding 'client'", "request.tools[0]") and about error type (`string`,
 * `FrameworkError`, a thrown `TypeError`). Each keeps its own; only the
 * mechanism is shared.
 */

import { type Result, ok, err } from "./result.js";

/** Why a value could not be read as own data. */
export type OwnDataFailure =
  /** Not an object (or callable) at all. */
  | { readonly kind: "not-an-object" }
  /** The whole value threw on inspection — a revoked Proxy, a hostile trap. */
  | { readonly kind: "uninspectable"; readonly cause: unknown }
  /** Present, but an accessor or inherited rather than an own data property. */
  | { readonly kind: "not-own-data"; readonly key: PropertyKey }
  /** Not an array where one was required. */
  | { readonly kind: "not-an-array" }
  /** `length` was absent, an accessor, or not a non-negative safe integer. */
  | { readonly kind: "bad-length" }
  /** Own keys beyond a dense `0..length-1` index set (a sparse/decorated array). */
  | { readonly kind: "not-dense" }
  /** Fewer elements than the caller requires. */
  | { readonly kind: "too-short"; readonly length: number };

/**
 * Object-like in the sense this boundary cares about: a callable carries own
 * properties too, so refusing functions here would reject valid client objects.
 */
export const isObjectLike = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/**
 * Read one own DATA property. `undefined` means "not present as own data" — it
 * does NOT distinguish an absent key from an accessor, because no call site
 * treats those differently and collapsing them keeps the rule one line.
 */
export const readOwnDataProperty = (
  value: object,
  key: PropertyKey,
): { readonly value: unknown } | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? { value: descriptor.value }
    : undefined;
};

/** `readOwnDataProperty` as a `Result`, for callers already on that rail. */
export const ownDataValue = (
  value: object,
  key: PropertyKey,
): Result<unknown, OwnDataFailure> => {
  const read = readOwnDataProperty(value, key);
  return read !== undefined ? ok(read.value) : err({ kind: "not-own-data", key });
};

/** Every own property descriptor, or the reason the value could not be read. */
export const ownDescriptors = (
  value: unknown,
): Result<Record<PropertyKey, PropertyDescriptor>, OwnDataFailure> => {
  if (!isObjectLike(value)) return err({ kind: "not-an-object" });
  try {
    return ok(
      Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>,
    );
  } catch (cause) {
    return err({ kind: "uninspectable", cause });
  }
};

/** Does `value` carry EXACTLY `expected` as its own keys — no more, no fewer? */
export const hasExactOwnKeys = (
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  expected: readonly string[],
): boolean => {
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key));
};

/**
 * Copy every own data property into a null-prototype, frozen, non-writable
 * snapshot. The copy is the point: the caller then holds a value the original
 * author can no longer change under it.
 */
export const snapshotOwnDataObject = (
  value: unknown,
): Result<Readonly<Record<PropertyKey, unknown>>, OwnDataFailure> => {
  const descriptors = ownDescriptors(value);
  if (!descriptors.ok) return descriptors;
  const snapshot: Record<PropertyKey, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors.value)) {
    const descriptor = descriptors.value[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      return err({ kind: "not-own-data", key });
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: descriptor.enumerable,
      configurable: false,
      writable: false,
    });
  }
  return ok(Object.freeze(snapshot));
};

/**
 * Snapshot a DENSE own-data array — `length` plus exactly the indices
 * `0..length-1`, every one a data property.
 *
 * Density is checked rather than assumed because `Array.isArray` says nothing
 * about holes, extra own keys, or accessor-backed indices: a hostile array can
 * satisfy `Array.isArray` and still hand out different elements on each read.
 *
 * `minLength` is the one axis call sites genuinely disagree on — an unpriced
 * model list must be non-empty, a tools array may legitimately be empty — so it
 * is a parameter rather than a reason to keep two copies of the walk.
 */
export const snapshotOwnDataArray = (
  value: unknown,
  minLength = 0,
): Result<readonly unknown[], OwnDataFailure> => {
  // Even `Array.isArray` throws on a revoked Proxy, so the very first question
  // asked of an untrusted value has to be fenced — there is no inspection
  // primitive a hostile value cannot turn into a throw.
  try {
    if (!Array.isArray(value)) return err({ kind: "not-an-array" });
  } catch (cause) {
    return err({ kind: "uninspectable", cause });
  }
  const descriptors = ownDescriptors(value);
  if (!descriptors.ok) return descriptors;

  const lengthDescriptor = descriptors.value.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    return err({ kind: "bad-length" });
  }
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return err({ kind: "bad-length" });
  }
  if (length < minLength) return err({ kind: "too-short", length });

  const keys = Reflect.ownKeys(descriptors.value);
  const canonicalIndices = keys.every((key) => {
    if (key === "length") return true;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
    return Number(key) < length;
  });
  if (keys.length !== length + 1 || !canonicalIndices) return err({ kind: "not-dense" });

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors.value[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      return err({ kind: "not-own-data", key: String(index) });
    }
    snapshot.push(descriptor.value);
  }
  return ok(Object.freeze(snapshot));
};
