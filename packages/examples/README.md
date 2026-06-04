# @fuguejs/examples

Golden, **lint-tested** DAG examples — the canonical copy-paste source for
authoring Fugue DAGs. One file per topology and capability pattern.

These are not toys that drift: every example is validated by the build.

- `bun run typecheck` proves the types are correct — including that each node's
  `requires: [...]` names a real capability and that `ctx.<cap>` is typed.
- `bun test` runs each example through the same `runLint` the `fugue` CLI uses,
  proving the DAG is structurally sound.

So if an example compiles and the suite is green, you can paste it and it works.

## The examples

| File | Pattern | Helper / capability |
|---|---|---|
| `dags/01-linear.ts` | Sequential A→B→C | `defineLinearDag` |
| `dags/02-fan-out.ts` | One source → N parallel branches → join | `defineFanOut` |
| `dags/03-diamond.ts` | Fan-out with a **required** join | `defineDiamond` |
| `dags/04-router.ts` | Classifier with a **required** default | `defineRouter` |
| `dags/05-guardrail.ts` | Non-blocking validation | `createGuardrailNode` |
| `dags/06-http-capability.ts` | A node requiring a **built-in** capability | `requires: ["http"]` |
| `dags/07-documents-capability.ts` | A node requiring an **adapter-provided** capability | `requires: ["documents"]` |

## See also

- `docs/llm-dag-authoring.md` — the full authoring reference (cross-links here).
- `docs/llm-document-source.md` — reading files via the `documents` capability.
- `docs/adapter-authoring.md` — writing your own capability adapter.
- Run `fugue capabilities` for the live list of built-in capability names.
