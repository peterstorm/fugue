// Shared deep-freeze primitive for the file backend.
//
// ONE implementation of "recursively Object.freeze a structured value, in
// place" (round-24 tda-4): the job snapshot (`job.ts` `data` getter) and the
// strict event-log reader (`event-log.ts` `readStrict`) both promise
// runtime-immutable results — the former typed `Readonly`, the latter typed
// `readonly` — and both make that promise true with this same walk, so the
// freeze semantics (symbol keys included, Map/Set/Date shallow) can never
// drift between the two promises.
//
// Safe wherever the value is a FRESH tree the caller does not share: the
// job's `structuredClone` output and the reader's freshly parsed JSON records
// are both exactly that. Plain objects and arrays become fully immutable
// (mutation throws in strict mode); Map/Set/Date instances are frozen
// shallowly — their mutation APIs operate on internal slots, so their content
// is guarded by the per-read clone isolation (job) or by never being
// reachable from persisted bytes at all (the strict reader's JSON-only
// records cannot carry Map/Set/Date).

/**
 * Recursively `Object.freeze` a structured value, in place.
 *
 * `Reflect.ownKeys` — not `Object.getOwnPropertyNames` — so objects nested
 * under symbol keys are frozen too. (The current sources never carry
 * symbol-keyed properties: `structuredClone` omits symbol keys, the FR-009
 * boundary rejects symbol-keyed state, and parsed JSON is string-keyed — but
 * the totality keeps the primitive correct for any future source that does
 * carry them, pinned by `__testDeepFreeze` in job.ts.)
 */
export const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};
