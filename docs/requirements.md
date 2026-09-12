# Requirement Traceability

Unqualified requirement IDs referenced in host source (`FR-xxx`, `NFR-xxx`,
`SC-xxx`) correspond to the specification document at:

```
.claude/specs/2026-05-20-fugue-host/spec.md
```

## Prefix Meanings

| Prefix | Meaning |
|--------|---------|
| **FR** | Functional Requirement — what the system must do |
| **NFR** | Non-Functional Requirement — performance, reliability, security constraints |
| **SC** | Scenario — acceptance criteria expressed as Given/When/Then |

## Source Code Convention

Requirements are referenced via JSDoc `@satisfies` tags:

```typescript
/**
 * @satisfies FR-001 — Poll git branch at configurable interval
 * @satisfies NFR-012 — Sync failures must not crash existing DAGs
 */
```

This enables grepping for coverage:

```bash
# Find all files satisfying a specific requirement
grep -rn "@satisfies FR-001" packages/host/src/
```

## F1 — Runtime-width fan-out

The `FR-F1-*` namespace belongs to
[`docs/plans/2026-09-06-f1-runtime-width-fanout.md`](plans/2026-09-06-f1-runtime-width-fanout.md),
not the host specification above. PR #45 supplied composite-address backend parity;
PR #46 supplied the runtime/host map contract; PR-C supplies authored maps and plate
rendering. PR-D whole-fan budget projection remains separate.

| Requirement | Traceability |
|---|---|
| FR-F1-001 | `createMapNode` applies one prepared child DAG over a runtime array and gathers through a typed reducer. |
| FR-F1-002 | `maxWidth` is a positive safe integer parsed at definition/authoring time. |
| FR-F1-003 | `resolveMappedItems` refuses over-width input without truncation. |
| FR-F1-004 | Zero-width fans reduce successfully from `[]`. |
| FR-F1-005 | Missing/non-array `widthFrom` values fail with `map-width-invalid`. |
| FR-F1-006 | Composite map/index/epoch addresses keep child instances distinct on every backend and host output writer. |
| FR-F1-007 | Durable resume reuses acknowledged indices and reruns only missing work in the current execution epoch. |
| FR-F1-008 | Canonical non-map checkpoint keys remain byte-identical; no migration. |
| FR-F1-009 | `DescribedNode` exposes bounded map metadata and Mermaid renders one plate, never runtime-width boxes. |
| FR-F1-010 | The closed `AuthoredDag` map-node variant parses a direct array field, bounded inline static child, and collect gather; codegen emits no expressions. |
| FR-F1-011 | Nested child maps and child human review are rejected before execution; gather then review at root level. |
