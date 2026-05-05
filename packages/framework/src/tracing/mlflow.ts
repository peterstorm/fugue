/**
 * Shared lazy-loader for @mlflow/core.
 * Single source of truth — eliminates triple duplication across executor, llm, eval-judge.
 */

export interface MlflowExports {
  withSpan: typeof import("@mlflow/core").withSpan;
  SpanType: typeof import("@mlflow/core").SpanType;
  SpanStatusCode: typeof import("@mlflow/core").SpanStatusCode;
  getCurrentActiveSpan: typeof import("@mlflow/core").getCurrentActiveSpan;
}

let _mlflow: Partial<MlflowExports> = {};
let _loaded = false;

export const loadMlflow = async (): Promise<void> => {
  if (_loaded) return;
  _loaded = true;
  try {
    const m = await import("@mlflow/core");
    _mlflow = {
      withSpan: m.withSpan,
      SpanType: m.SpanType,
      SpanStatusCode: m.SpanStatusCode,
      getCurrentActiveSpan: m.getCurrentActiveSpan,
    };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      console.warn(`[tracing] @mlflow/core import failed: ${(e as Error)?.message}`);
    }
  }
};

/** Access loaded mlflow exports. Call loadMlflow() first. */
export const mlflow = (): Readonly<Partial<MlflowExports>> => _mlflow;
