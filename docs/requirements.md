# Requirement Traceability

Requirement IDs referenced in source code (`FR-xxx`, `NFR-xxx`, `SC-xxx`) correspond to
the specification document at:

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
