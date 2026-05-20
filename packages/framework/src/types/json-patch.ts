/**
 * RFC 6902 JSON Patch types.
 *
 * Lives in `types/` so the event layer (`types/events.ts`) can reference
 * `JsonPatch` without an upward import into `shared/`.
 * The runtime helper `computeJsonPatch` lives in `shared/json-patch.ts`.
 */

export type JsonPatchOp =
  | { readonly op: "add"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "replace"; readonly path: string; readonly value: unknown };

export type JsonPatch = readonly JsonPatchOp[];
