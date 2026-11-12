import type { BudgetCapability } from "../types/budget-capability.js";
import type { FanConcurrencyCap } from "../types/fan-scheduling.js";
import type { MappedChildScope } from "../types/mapped-child-scope.js";
import type { Logger } from "../types/node.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";

/** The root binds this runner only to children included in its preparation. */
export type ExecuteMappedChild = (
  input: unknown,
  scope: MappedChildScope,
) => Promise<Result<unknown, FrameworkError>>;

/**
 * Root-owned fan resources (AD-7, ADR-0086 root authority), built once per
 * root run from the root-validated base context and the operator cap:
 *   - `budget` is READ only — spend and headroom snapshots feed projection;
 *     dispatch and spend authority stay with the root (FR-012). `null` means
 *     the run has no budget capability, which projects as unbudgeted.
 *   - `cap` is the host FAN_CHILD_CONCURRENCY_MAX (FR-030).
 *   - `logger` carries the visible clamp warning (FR-033).
 *   - `tagSpan` is the telemetry sink for the map node's active span
 *     (FR-060). It is a port, not an OTel import, because the fan shell
 *     (`run-mapped-fan.ts`) deliberately imports no OpenTelemetry (SC-006
 *     boundary rule); the root binds it to the active span, tests to a plain
 *     recorder. Callers
 *     treat it as best-effort: it never decides a fan outcome.
 * A map node's `requires` stays `["checkpointer"]`: budget is a fan resource
 * the root lends, not a capability the node demands.
 */
export type FanRuntime = Readonly<{
  budget: BudgetCapability | null;
  cap: FanConcurrencyCap;
  logger: Logger;
  tagSpan: FanSpanTagger;
}>;

/** Set primitive attributes on the currently active node span. */
export type FanSpanTagger = (attributes: Readonly<Record<string, number | boolean>>) => void;

/** Root owns fan dispatch; a child owns only its scoped output address. */
export type ExecutionScope =
  | Readonly<{ kind: "root"; executeMappedChild: ExecuteMappedChild; fan: FanRuntime }>
  | Readonly<{ kind: "mapped-child"; scope: MappedChildScope }>;
