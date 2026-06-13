// Fixture: a default export whose `.dag` is a non-null object (so it clears
// `importDagFile`'s shape gate) but has no `nodes`, so `analyzeDag`'s
// `for (const node of dag.nodes)` throws a TypeError at runtime. Exercises
// `runLint`'s analyzer-failed guard — a crashed analyzer must surface as
// `ok: false` (kind `analyzer-failed`), never silently pass lint and hide a
// real fan-in-key-mismatch.

export default {
  dag: {} as never,
  meta: { description: "DAG whose .dag has no nodes", version: "1.0.0" },
};
