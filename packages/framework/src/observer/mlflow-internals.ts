/**
 * Centralized adapter for @mlflow/core internal imports.
 *
 * ALL dist/ deep imports are isolated here so that a @mlflow/core version bump
 * breaks exactly ONE file with a clear error message, rather than silently
 * degrading across the codebase.
 *
 * Pinned to @mlflow/core@0.2.0 — if upgrading, verify these internal paths
 * still exist.
 *
 * Note: We only need MlflowSpanProcessor (for InMemoryTraceManager maintenance).
 * MlflowSpanExporter is no longer used — we export via OTLP instead.
 */

// @ts-ignore — internal path, pinned to @mlflow/core@0.2.0
import { MlflowSpanProcessor } from "@mlflow/core/dist/exporters/mlflow";

// Re-export with validation — fail fast with a clear message if internals moved
if (typeof MlflowSpanProcessor !== "function") {
  throw new Error(
    "[ai-summary] @mlflow/core internal API changed: MlflowSpanProcessor not found at dist/exporters/mlflow. " +
    "Pin @mlflow/core to 0.2.0 or update mlflow-internals.ts.",
  );
}

export { MlflowSpanProcessor };
