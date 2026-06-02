import { describe, test, expect, afterEach } from "bun:test";
import {
  NoopObserver,
  BufferedObserver,
  alwaysOn,
  errorOnly,
  setFrameworkLogger,
  type ObserverEvent,
  type FoundryTelemetrySink,
  type FrameworkLogger,
  FOUNDRY_EVENT_RUN_SUMMARY,
  FOUNDRY_EVENT_ROUTE_DECISION,
  FOUNDRY_METRIC_RUN_LATENCY,
} from "@fugue/framework";
import {
  composeObservability,
  resolveFoundryLeg,
  FoundryRunSummaryObserver,
  type ObservabilityFactories,
  type SpanExporter,
} from "../observability-composition.js";
import type { ResolvedObservability } from "../observability.js";
import { isFoundryEnabled } from "../observability.js";
import {
  foundrySinkOver,
  createAppInsightsClient,
  type AppInsightsClient,
  type AppInsightsClientSeams,
} from "../foundry-sink.js";

// A recording FrameworkLogger that restores the console default after each test.
const recordingFrameworkLogger = () => {
  const warns: Array<{ msg: string; args: unknown[] }> = [];
  const errors: Array<{ msg: string; args: unknown[] }> = [];
  const logger: FrameworkLogger = {
    debug: () => {},
    info: () => {},
    warn: (msg, ...args) => { warns.push({ msg, args }); },
    error: (msg, ...args) => { errors.push({ msg, args }); },
  };
  setFrameworkLogger(logger);
  return { warns, errors };
};

// Restore a console-backed framework logger after any test that installs a fake,
// so logger state never leaks across suites.
afterEach(() => {
  setFrameworkLogger({
    debug: (m, ...a) => console.debug(m, ...a),
    info: (m, ...a) => console.info(m, ...a),
    warn: (m, ...a) => console.warn(m, ...a),
    error: (m, ...a) => console.error(m, ...a),
  });
});

// ---------------------------------------------------------------------------
// Fakes / seams — NO live Azure, NO global Application Insights pipeline.
// ---------------------------------------------------------------------------

// OTel `ExportResultCode.SUCCESS`. Named locally rather than imported so the app
// test stays decoupled from a direct `@opentelemetry/*` dependency (the app only
// sees `SpanExporter` re-exported through the framework barrel).
const EXPORT_RESULT_SUCCESS = 0;

/** A fake SpanExporter so we can identify exporters by reference/tag. */
const fakeExporter = (tag: string): SpanExporter => ({
  export: (_spans: unknown, cb: (r: { code: number }) => void) => {
    cb({ code: EXPORT_RESULT_SUCCESS });
  },
  shutdown: async () => {},
  // Carry an identifying tag for assertions.
  __tag: tag,
} as unknown as SpanExporter);

const tagOf = (e: SpanExporter): string =>
  (e as unknown as { __tag: string }).__tag;

/** A recording FoundryTelemetrySink fake — captures every track call. */
const recordingSink = () => {
  const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
  const metrics: Array<{ name: string; value: number; properties?: Record<string, string> }> = [];
  let flushes = 0;
  const sink: FoundryTelemetrySink = {
    trackEvent: (e) => { events.push(e); },
    trackMetric: (m) => { metrics.push(m); },
    flush: async () => { flushes++; },
  };
  return { sink, events, metrics, get flushes() { return flushes; } };
};

const factoriesWith = (
  sink: FoundryTelemetrySink,
  tags: { mlflow?: string; foundry?: string } = {},
): ObservabilityFactories => ({
  createMlflowExporter: () => fakeExporter(tags.mlflow ?? "mlflow"),
  createFoundryExporter: () => fakeExporter(tags.foundry ?? "foundry"),
  createFoundrySink: () => sink,
});

// ObserverEvent builders (branded ids are plain strings at runtime).
const runStart = (runId: string, dagId: string): ObserverEvent =>
  ({ type: "run-start", runId, dagId, timestamp: new Date() } as unknown as ObserverEvent);
const nodeStart = (runId: string, dagId: string, nodeId: string): ObserverEvent =>
  ({ type: "node-start", runId, dagId, nodeId, kind: "llm", timestamp: new Date() } as unknown as ObserverEvent);
const nodeSkippedCheckpoint = (runId: string, dagId: string, nodeId: string): ObserverEvent =>
  ({ type: "node-skipped", runId, dagId, nodeId, reason: "checkpoint", timestamp: new Date() } as unknown as ObserverEvent);
const routeDecided = (runId: string, dagId: string): ObserverEvent =>
  ({
    type: "route-decided", runId, dagId, fromNodeId: "router",
    chosenTargets: ["a"], prunedTargets: ["b"], defaultTaken: false, timestamp: new Date(),
  } as unknown as ObserverEvent);
const runEnd = (runId: string, dagId: string, status: "ok" | "error", duration: number): ObserverEvent =>
  ({ type: "run-end", runId, dagId, status, duration, timestamp: new Date() } as unknown as ObserverEvent);

// ---------------------------------------------------------------------------
// Default path (no Foundry) — byte-for-byte unchanged (SC-006 / FR-003 / FR-027)
// ---------------------------------------------------------------------------
describe("composeObservability — default (MLflow-only) path", () => {
  const resolved: ResolvedObservability = { kind: "mlflow-only", traceBackends: ["mlflow"] };

  test("single MLflow exporter, no Foundry exporter built", () => {
    let foundryBuilds = 0;
    const factories: ObservabilityFactories = {
      createMlflowExporter: () => fakeExporter("mlflow"),
      createFoundryExporter: () => { foundryBuilds++; return fakeExporter("foundry"); },
      createFoundrySink: () => { throw new Error("sink must not be built on default path"); },
    };
    const { exporters } = composeObservability(resolved, alwaysOn(), factories);
    expect(exporters.length).toBe(1);
    expect(tagOf(exporters[0])).toBe("mlflow");
    expect(foundryBuilds).toBe(0);
  });

  test("observer is a NoopObserver (deps.observer unchanged)", () => {
    const { observer } = composeObservability(resolved, alwaysOn(), factoriesWith(recordingSink().sink));
    expect(observer).toBeInstanceOf(NoopObserver);
  });
});

// ---------------------------------------------------------------------------
// Foundry-only path
// ---------------------------------------------------------------------------
describe("composeObservability — Foundry-only path", () => {
  const resolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["foundry"],
    auth: { mode: "connection-string", connectionString: "InstrumentationKey=abc" },
  };

  test("single Foundry exporter, observer is a BufferedObserver", () => {
    const { sink } = recordingSink();
    const { exporters, observer } = composeObservability(resolved, alwaysOn(), factoriesWith(sink));
    expect(exporters.length).toBe(1);
    expect(tagOf(exporters[0])).toBe("foundry");
    expect(observer).toBeInstanceOf(BufferedObserver);
    (observer as BufferedObserver).close();
  });
});

// ---------------------------------------------------------------------------
// Dual-export path — order + both backends (FR-002 / FR-011)
// ---------------------------------------------------------------------------
describe("composeObservability — dual-export path", () => {
  const resolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["mlflow", "foundry"],
    auth: { mode: "entra-id", connectionString: "InstrumentationKey=abc" },
  };

  test("exporters built in traceBackends order [mlflow, foundry]", () => {
    const { sink } = recordingSink();
    const { exporters, observer } = composeObservability(resolved, alwaysOn(), factoriesWith(sink));
    expect(exporters.length).toBe(2);
    expect(tagOf(exporters[0])).toBe("mlflow");
    expect(tagOf(exporters[1])).toBe("foundry");
    expect(observer).toBeInstanceOf(BufferedObserver);
    (observer as BufferedObserver).close();
  });

  test("reversed selection [foundry, mlflow] preserves order", () => {
    const reversed: ResolvedObservability = { ...resolved, traceBackends: ["foundry", "mlflow"] };
    const { sink } = recordingSink();
    const { exporters, observer } = composeObservability(reversed, alwaysOn(), factoriesWith(sink));
    expect(tagOf(exporters[0])).toBe("foundry");
    expect(tagOf(exporters[1])).toBe("mlflow");
    (observer as BufferedObserver).close();
  });
});

// ---------------------------------------------------------------------------
// Policy sharing — discarded trace produces NO domain events (FR-021 / SC-010)
// ---------------------------------------------------------------------------
describe("composeObservability — shared policy gating (FR-021 / SC-010)", () => {
  const resolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["mlflow", "foundry"],
    auth: { mode: "connection-string", connectionString: "InstrumentationKey=abc" },
  };

  test("errorOnly policy: an OK run emits NO domain events through the sink", () => {
    const { sink, events, metrics } = recordingSink();
    // Same policy instance the trace pipeline would use.
    const policy = errorOnly();
    const { observer } = composeObservability(resolved, policy, factoriesWith(sink));
    const bo = observer as BufferedObserver;

    bo.observe(runStart("r1", "d1"));
    bo.observe(routeDecided("r1", "d1"));
    bo.observe(runEnd("r1", "d1", "ok", 100));

    // errorOnly drops OK runs → buffered events never replay → nothing emitted.
    expect(events).toEqual([]);
    expect(metrics).toEqual([]);
    bo.close();
  });

  test("errorOnly policy: an ERROR run flushes the run summary + route decision", () => {
    const { sink, events } = recordingSink();
    const policy = errorOnly();
    const { observer } = composeObservability(resolved, policy, factoriesWith(sink));
    const bo = observer as BufferedObserver;

    bo.observe(runStart("r2", "d1"));
    bo.observe(routeDecided("r2", "d1"));
    bo.observe(runEnd("r2", "d1", "error", 200));

    const names = events.map((e) => e.name);
    expect(names).toContain(FOUNDRY_EVENT_ROUTE_DECISION);
    expect(names).toContain(FOUNDRY_EVENT_RUN_SUMMARY);
    bo.close();
  });
});

// ---------------------------------------------------------------------------
// SC-008 — full run summary (nodeCount / retryCount / cacheHitCount)
// ---------------------------------------------------------------------------
describe("FoundryRunSummaryObserver — full FR-019 summary (SC-008)", () => {
  test("run-end emits ONE summary carrying nodeCount/retryCount/cacheHitCount", () => {
    const { sink, events, metrics } = recordingSink();
    const obs = new FoundryRunSummaryObserver(sink);

    // 2 distinct nodes, n1 started twice (a retry), one checkpoint cache hit.
    obs.observe(nodeStart("r1", "d1", "n1"));
    obs.observe(nodeStart("r1", "d1", "n1"));
    obs.observe(nodeStart("r1", "d1", "n2"));
    obs.observe(nodeSkippedCheckpoint("r1", "d1", "n3"));
    obs.observe(runEnd("r1", "d1", "ok", 500));

    const summaries = events.filter((e) => e.name === FOUNDRY_EVENT_RUN_SUMMARY);
    expect(summaries.length).toBe(1); // exactly one — not bare + full
    const m = summaries[0]!.measurements!;
    expect(m.durationMs).toBe(500);
    expect(m.nodeCount).toBe(3); // n1, n2, n3
    expect(m.retryCount).toBe(1); // n1 started twice
    expect(m.cacheHitCount).toBe(1); // n3 checkpoint skip

    // run-latency metric dimensioned by dagId is present.
    const latency = metrics.filter((x) => x.name === FOUNDRY_METRIC_RUN_LATENCY);
    expect(latency.length).toBe(1);
    expect(latency[0]!.value).toBe(500);
    expect(latency[0]!.properties?.dagId).toBe("d1");
  });

  test("run summary properties carry runId/dagId/status", () => {
    const { sink, events } = recordingSink();
    const obs = new FoundryRunSummaryObserver(sink);
    obs.observe(runEnd("rX", "dX", "error", 42));
    const summary = events.find((e) => e.name === FOUNDRY_EVENT_RUN_SUMMARY)!;
    expect(summary.properties).toMatchObject({ runId: "rX", dagId: "dX", status: "error" });
  });

  test("fail-tolerant: a throwing sink does not escape observe()", () => {
    const throwing: FoundryTelemetrySink = {
      trackEvent: () => { throw new Error("boom"); },
      trackMetric: () => { throw new Error("boom"); },
      flush: async () => {},
    };
    const obs = new FoundryRunSummaryObserver(throwing);
    expect(() => obs.observe(runEnd("r", "d", "ok", 1))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// foundrySinkOver — adapter contract over a fake AppInsightsClient
// ---------------------------------------------------------------------------
describe("foundrySinkOver — Application Insights adapter", () => {
  const fakeClient = () => {
    const tracked: Array<{ kind: string; payload: unknown }> = [];
    let flushed = 0;
    const client: AppInsightsClient = {
      trackEvent: (t) => tracked.push({ kind: "event", payload: t }),
      trackMetric: (t) => tracked.push({ kind: "metric", payload: t }),
      flush: async () => { flushed++; },
    };
    return { client, tracked, get flushed() { return flushed; } };
  };

  test("trackEvent forwards name + properties + measurements", () => {
    const f = fakeClient();
    const sink = foundrySinkOver(f.client);
    sink.trackEvent({ name: "e", properties: { a: "1" }, measurements: { m: 2 } });
    expect(f.tracked).toEqual([
      { kind: "event", payload: { name: "e", properties: { a: "1" }, measurements: { m: 2 } } },
    ]);
  });

  test("trackMetric forwards name + value + properties", () => {
    const f = fakeClient();
    const sink = foundrySinkOver(f.client);
    sink.trackMetric({ name: "m", value: 3, properties: { dagId: "d" } });
    expect(f.tracked).toEqual([
      { kind: "metric", payload: { name: "m", value: 3, properties: { dagId: "d" } } },
    ]);
  });

  test("flush delegates to the client", async () => {
    const f = fakeClient();
    const sink = foundrySinkOver(f.client);
    await sink.flush();
    expect(f.flushed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createAppInsightsClient — auth translation (FR-022 / FR-023)
// connection-string vs entra-id → DefaultAzureCredential / global pipeline.
// NO live Azure: every effectful seam (credential, useAzureMonitor,
// TelemetryClient ctor) is a fake.
// ---------------------------------------------------------------------------
describe("createAppInsightsClient — auth translation", () => {
  /** Recording seams capturing which branch ran and with what args. */
  const recordingSeams = () => {
    const credentialCalls: number[] = [];
    const fakeCredential = { getToken: async () => null } as unknown as ReturnType<
      AppInsightsClientSeams["credentialFactory"]
    >;
    const pipelineInits: Array<{ connectionString: string; credentialIsFake: boolean }> = [];
    const clientCalls: Array<{ connectionString: string; options?: { useGlobalProviders: boolean } }> = [];
    const fakeClient: AppInsightsClient = {
      trackEvent: () => {},
      trackMetric: () => {},
      flush: () => {},
    };
    const seams: AppInsightsClientSeams = {
      credentialFactory: () => {
        credentialCalls.push(1);
        return fakeCredential;
      },
      configureGlobalPipeline: (init) => {
        pipelineInits.push({
          connectionString: init.azureMonitorExporterOptions.connectionString,
          credentialIsFake: init.azureMonitorExporterOptions.credential === fakeCredential,
        });
      },
      newClient: (connectionString, options) => {
        clientCalls.push(options === undefined ? { connectionString } : { connectionString, options });
        return fakeClient;
      },
    };
    return {
      seams,
      get credentialInvocations() { return credentialCalls.length; },
      pipelineInits,
      clientCalls,
    };
  };

  test("entra-id mode: invokes credentialFactory + configures the global pipeline", () => {
    const r = recordingSeams();
    createAppInsightsClient(
      { mode: "entra-id", connectionString: "InstrumentationKey=entra" },
      r.seams,
    );
    // The credential factory IS invoked (FR-023).
    expect(r.credentialInvocations).toBe(1);
    // The global Azure Monitor pipeline branch runs with that credential + conn string.
    expect(r.pipelineInits.length).toBe(1);
    expect(r.pipelineInits[0]).toEqual({
      connectionString: "InstrumentationKey=entra",
      credentialIsFake: true,
    });
    // The client is constructed WITHOUT the isolation flag (relies on globals).
    expect(r.clientCalls.length).toBe(1);
    expect(r.clientCalls[0]!.options).toBeUndefined();
  });

  test("connection-string mode: NO credential, NO global pipeline, isolated client", () => {
    const r = recordingSeams();
    createAppInsightsClient(
      { mode: "connection-string", connectionString: "InstrumentationKey=conn" },
      r.seams,
    );
    // credentialFactory must NOT be invoked (no Entra path).
    expect(r.credentialInvocations).toBe(0);
    // The global pipeline must NOT be configured (no global side effects).
    expect(r.pipelineInits.length).toBe(0);
    // Isolated client: useGlobalProviders:false MUST be passed (regression guard).
    expect(r.clientCalls.length).toBe(1);
    expect(r.clientCalls[0]!.options).toEqual({ useGlobalProviders: false });
    expect(r.clientCalls[0]!.connectionString).toBe("InstrumentationKey=conn");
  });

  test("swapping the two modes would fail: branches are distinct", () => {
    const entra = recordingSeams();
    createAppInsightsClient({ mode: "entra-id", connectionString: "x" }, entra.seams);
    const conn = recordingSeams();
    createAppInsightsClient({ mode: "connection-string", connectionString: "x" }, conn.seams);

    // entra-id touches the global pipeline; connection-string never does.
    expect(entra.pipelineInits.length).toBe(1);
    expect(conn.pipelineInits.length).toBe(0);
    // connection-string isolates; entra-id does not.
    expect(conn.clientCalls[0]!.options).toEqual({ useGlobalProviders: false });
    expect(entra.clientCalls[0]!.options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — run-summary sink failures are swallowed AND logged (silent-failure #4a)
// ---------------------------------------------------------------------------
describe("FoundryRunSummaryObserver — throwing sink is swallowed AND logged", () => {
  test("a throwing sink on the run-summary path is swallowed and warns via fwLogger", () => {
    const { warns } = recordingFrameworkLogger();
    const throwing: FoundryTelemetrySink = {
      trackEvent: () => { throw new Error("event-boom"); },
      trackMetric: () => { throw new Error("metric-boom"); },
      flush: async () => {},
    };
    const obs = new FoundryRunSummaryObserver(throwing);

    // run-end triggers the direct-to-sink emission path.
    expect(() => obs.observe(runEnd("rLog", "dLog", "error", 7))).not.toThrow();

    // Every swallowed emission MUST be logged (no silent failure).
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.every((w) => w.msg.includes("[FoundryRunSummaryObserver]"))).toBe(true);
    expect(warns.some((w) => w.msg.includes("swallowed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — Foundry construction failure must NOT disable MLflow tracing
// (FR-026 / SC-006 / SC-009)
// ---------------------------------------------------------------------------
describe("resolveFoundryLeg — Foundry construction is isolated from MLflow", () => {
  const dualResolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["mlflow", "foundry"],
    auth: { mode: "connection-string", connectionString: "InstrumentationKey=abc" },
  };

  test("Foundry exporter factory throws → effective selection is MLflow-only + logged", () => {
    const errors: Array<{ msg: string; args: unknown[] }> = [];
    const log = { error: (msg: string, ...args: unknown[]) => { errors.push({ msg, args }); } };

    const leg = resolveFoundryLeg(
      dualResolved,
      () => { throw new Error("azure-exporter-boom"); },
      () => recordingSink().sink,
      log,
    );

    // Foundry leg degraded: inactive outcome (no prebuilt instances), foundry
    // dropped from the effective selection.
    expect(leg.outcome).toBe("inactive");
    expect(isFoundryEnabled(leg.effective)).toBe(false);
    expect(leg.effective.traceBackends).toEqual(["mlflow"]);
    // The failure is observable.
    expect(errors.length).toBe(1);
    expect(errors[0]!.msg).toContain("MLflow tracing continues");
  });

  test("Foundry SINK factory throws (exporter built first) → MLflow-only + logged", () => {
    // The exporter constructs fine but the sink construction faults. Both are
    // built inside the same try, so this branch must degrade identically to the
    // exporter-throws case — otherwise a half-built leg (exporter, no sink)
    // could wire an exporter with no observer.
    const errors: Array<{ msg: string; args: unknown[] }> = [];
    const log = { error: (msg: string, ...args: unknown[]) => { errors.push({ msg, args }); } };

    const leg = resolveFoundryLeg(
      dualResolved,
      () => fakeExporter("foundry"),
      () => { throw new Error("appinsights-sink-boom"); },
      log,
    );

    expect(leg.outcome).toBe("inactive");
    expect(isFoundryEnabled(leg.effective)).toBe(false);
    expect(leg.effective.traceBackends).toEqual(["mlflow"]);
    expect(errors.length).toBe(1);
    expect(errors[0]!.msg).toContain("MLflow tracing continues");
  });

  test("degraded selection still composes a non-null MLflow exporter (MLflow unaffected)", () => {
    const errors: string[] = [];
    const log = { error: (msg: string) => { errors.push(msg); } };

    const leg = resolveFoundryLeg(
      dualResolved,
      () => { throw new Error("boom"); },
      () => recordingSink().sink,
      log,
    );

    // Feed the degraded selection into the composition (as bootstrap does).
    const { exporters, observer } = composeObservability(
      leg.effective,
      alwaysOn(),
      // Foundry factories must NOT be called on the degraded path.
      {
        createMlflowExporter: () => fakeExporter("mlflow"),
        createFoundryExporter: () => { throw new Error("must not build foundry on degraded path"); },
        createFoundrySink: () => { throw new Error("must not build foundry sink on degraded path"); },
      },
    );

    // initTracing would receive the MLflow exporter and a NoopObserver — tracing live.
    expect(exporters.length).toBe(1);
    expect(tagOf(exporters[0])).toBe("mlflow");
    expect(observer).toBeInstanceOf(NoopObserver);
  });

  test("Foundry-only selection that fails falls back to MLflow (tracing still initializes)", () => {
    const foundryOnly: ResolvedObservability = {
      kind: "with-foundry",
      traceBackends: ["foundry"],
      auth: { mode: "entra-id", connectionString: "InstrumentationKey=abc" },
    };
    const leg = resolveFoundryLeg(
      foundryOnly,
      () => { throw new Error("boom"); },
      () => recordingSink().sink,
      { error: () => {} },
    );
    expect(isFoundryEnabled(leg.effective)).toBe(false);
    expect(leg.effective.traceBackends).toEqual(["mlflow"]);
  });

  test("success path: prebuilt exporter + sink returned, selection unchanged", () => {
    const exporter = fakeExporter("foundry");
    const { sink } = recordingSink();
    const leg = resolveFoundryLeg(
      dualResolved,
      () => exporter,
      () => sink,
      { error: () => { throw new Error("must not log on success"); } },
    );
    expect(leg.outcome).toBe("active");
    // Narrow on the discriminant to reach the prebuilt instances.
    if (leg.outcome !== "active") throw new Error("expected active leg");
    expect(leg.foundryExporter).toBe(exporter);
    expect(leg.foundrySink).toBe(sink);
    expect(leg.effective).toBe(dualResolved);
  });

  test("not enabled: passthrough with no Foundry construction", () => {
    const mlflowOnly: ResolvedObservability = { kind: "mlflow-only", traceBackends: ["mlflow"] };
    const leg = resolveFoundryLeg(
      mlflowOnly,
      () => { throw new Error("must not build"); },
      () => { throw new Error("must not build"); },
      { error: () => { throw new Error("must not log"); } },
    );
    expect(leg.effective).toBe(mlflowOnly);
    expect(leg.outcome).toBe("inactive");
  });
});
