import { describe, test, expect } from "bun:test";
import {
  NoopObserver,
  BufferedObserver,
  type TracingHandle,
  type FoundryTelemetrySink,
} from "@fugue/framework";
import { setUpTracing, type TracingSeams } from "../bootstrap.js";
import type { ResolvedObservability } from "../observability.js";
import type { SpanExporter } from "../observability-composition.js";
import type { AppLogger } from "../logger.js";

// A recording AppLogger so tests assert WHAT was logged (the "continuing
// without tracing" error vs. the "Tracing initialized" info line).
const recordingLogger = () => {
  const info: string[] = [];
  const errors: Array<{ msg: string; args: unknown[] }> = [];
  const log: AppLogger = {
    debug: () => {},
    info: (msg) => { info.push(msg); },
    warn: () => {},
    error: (msg, ...args) => { errors.push({ msg, args }); },
  };
  return { log, info, errors };
};

const TRACING_CONFIG = {
  TRACE_SAMPLE_RATIO: 0.1,
  MLFLOW_TRACKING_URI: "http://mlflow.local",
  MLFLOW_EXPERIMENT_ID: "exp-1",
} as const;

/** A fake SpanExporter (never used for real export in these tests). */
const fakeExporter = (): SpanExporter =>
  ({ export: (_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 }), shutdown: async () => {} } as unknown as SpanExporter);

/** A fake started tracing pipeline — identity-checked, never driven. */
const fakeHandle = (): TracingHandle => ({} as unknown as TracingHandle);

/** A fake Foundry sink — identity-checked, never driven. */
const fakeSink = (): FoundryTelemetrySink => ({} as unknown as FoundryTelemetrySink);

const MLFLOW_ONLY: ResolvedObservability = { kind: "mlflow-only", traceBackends: ["mlflow"] };
const WITH_FOUNDRY: ResolvedObservability = {
  kind: "with-foundry",
  traceBackends: ["mlflow", "foundry"],
  auth: { mode: "connection-string", connectionString: "InstrumentationKey=abc" },
};

// A seam set that never touches live Azure/OTel: fake exporters/sink/handle.
const hermeticSeams = (over: Partial<TracingSeams> = {}): TracingSeams => ({
  initTracing: async () => fakeHandle(),
  buildMlflowExporter: () => fakeExporter(),
  buildFoundryExporter: () => fakeExporter(),
  buildFoundrySink: () => fakeSink(),
  ...over,
});

describe("setUpTracing — fault-tolerant tracing startup", () => {
  test("initTracing failure → coherent un-traced state, app keeps booting", async () => {
    const { log, info, errors } = recordingLogger();
    const boom = new Error("OTel pipeline refused to start");

    const result = await setUpTracing(
      MLFLOW_ONLY,
      TRACING_CONFIG,
      log,
      hermeticSeams({
        initTracing: async () => {
          throw boom;
        },
      }),
    );

    // The catch returns a COHERENT degraded state — no half-wired observer/sink.
    expect(result.tracing).toBeNull();
    expect(result.observer).toBeInstanceOf(NoopObserver);
    expect(result.foundrySinkForFlush).toBeNull();

    // The failure MUST be observable, and the "initialized" line MUST NOT print.
    expect(errors.length).toBe(1);
    expect(errors[0]!.msg).toContain("continuing without tracing");
    expect(errors[0]!.args).toContain(boom);
    expect(info.length).toBe(0);
  });

  test("mlflow-only success → tracing handle, NoopObserver, no Foundry sink", async () => {
    const { log, info, errors } = recordingLogger();
    const handle = fakeHandle();

    const result = await setUpTracing(
      MLFLOW_ONLY,
      TRACING_CONFIG,
      log,
      hermeticSeams({ initTracing: async () => handle }),
    );

    expect(result.tracing).toBe(handle);
    expect(result.observer).toBeInstanceOf(NoopObserver);
    expect(result.foundrySinkForFlush).toBeNull();
    expect(errors.length).toBe(0);
    expect(info[0]).toContain("Tracing initialized");
  });

  test("with-foundry success → BufferedObserver + retained Foundry sink for shutdown drain", async () => {
    const { log, errors } = recordingLogger();
    const sink = fakeSink();

    const result = await setUpTracing(
      WITH_FOUNDRY,
      TRACING_CONFIG,
      log,
      hermeticSeams({ buildFoundrySink: () => sink }),
    );

    expect(result.tracing).not.toBeNull();
    expect(result.observer).toBeInstanceOf(BufferedObserver);
    expect(result.foundrySinkForFlush).toBe(sink);
    expect(errors.length).toBe(0);
    // Release the BufferedObserver's sweep timer so the test process can exit.
    (result.observer as BufferedObserver).close();
  });

  test("Foundry CONSTRUCTION fault is isolated → MLflow tracing stays live (catch NOT hit)", async () => {
    const { log, info, errors } = recordingLogger();

    const result = await setUpTracing(
      WITH_FOUNDRY,
      TRACING_CONFIG,
      log,
      hermeticSeams({
        buildFoundryExporter: () => {
          throw new Error("Foundry exporter ctor blew up");
        },
      }),
    );

    // resolveFoundryLeg degrades to MLflow-only: tracing is LIVE, no Foundry sink.
    expect(result.tracing).not.toBeNull();
    expect(result.observer).toBeInstanceOf(NoopObserver);
    expect(result.foundrySinkForFlush).toBeNull();
    // The outer "continuing without tracing" catch must NOT have fired — the
    // Foundry fault was absorbed by the isolation boundary, and tracing succeeded.
    expect(info[0]).toContain("Tracing initialized");
    expect(errors.some((e) => e.msg.includes("continuing without tracing"))).toBe(false);
  });
});
