/**
 * Centralized adapter for @mlflow/core internal imports.
 *
 * ALL dist/ deep imports are isolated here so that a @mlflow/core version bump
 * breaks exactly ONE file with a clear error message, rather than silently
 * degrading across the codebase.
 *
 * Pinned to @mlflow/core@0.2.0 — if upgrading, verify these internal paths
 * still exist. See: https://github.com/mlflow/mlflow/issues/XXXXX (upstream
 * feature request for public exports).
 */

// @ts-ignore — internal path, pinned to @mlflow/core@0.2.0
import { MlflowSpanProcessor, MlflowSpanExporter } from "@mlflow/core/dist/exporters/mlflow";
// @ts-ignore — internal path, pinned to @mlflow/core@0.2.0
import { createAuthProvider } from "@mlflow/core/dist/auth";
// @ts-ignore — internal path, pinned to @mlflow/core@0.2.0
import { InMemoryTraceManager } from "@mlflow/core/dist/core/trace_manager";

// Re-export with validation — fail fast with a clear message if internals moved
if (typeof MlflowSpanProcessor !== "function") {
  throw new Error(
    "[ai-summary] @mlflow/core internal API changed: MlflowSpanProcessor not found at dist/exporters/mlflow. " +
    "Pin @mlflow/core to 0.2.0 or update mlflow-internals.ts.",
  );
}
if (typeof MlflowSpanExporter !== "function") {
  throw new Error(
    "[ai-summary] @mlflow/core internal API changed: MlflowSpanExporter not found at dist/exporters/mlflow. " +
    "Pin @mlflow/core to 0.2.0 or update mlflow-internals.ts.",
  );
}
if (typeof createAuthProvider !== "function") {
  throw new Error(
    "[ai-summary] @mlflow/core internal API changed: createAuthProvider not found at dist/auth. " +
    "Pin @mlflow/core to 0.2.0 or update mlflow-internals.ts.",
  );
}
if (typeof InMemoryTraceManager?.getInstance !== "function") {
  throw new Error(
    "[ai-summary] @mlflow/core internal API changed: InMemoryTraceManager not found at dist/core/trace_manager. " +
    "Pin @mlflow/core to 0.2.0 or update mlflow-internals.ts.",
  );
}

export { MlflowSpanProcessor, MlflowSpanExporter, createAuthProvider, InMemoryTraceManager };
