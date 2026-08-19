import { describe, test, expect, afterEach } from "bun:test";
import {
  NoopObserver,
  BufferedObserver,
  alwaysOn,
  errorOnly,
  anyOf,
  hadRetry,
  ratio,
  initTracing,
  type PersistencePolicy,
  setFrameworkLogger,
  asNonEmptyString,
  type ObserverEvent,
  type FoundryTelemetrySink,
  type FiniteNumber,
  type FrameworkLogger,
  FOUNDRY_EVENT_RUN_SUMMARY,
  FOUNDRY_EVENT_ROUTE_DECISION,
  FOUNDRY_METRIC_RUN_LATENCY,
} from "@fuguejs/framework";
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
  createFoundrySink,
  type AppInsightsClient,
  type AppInsightsClientSeams,
} from "../foundry-sink.js";

/**
 * Brand a known-good literal connection string for tests (non-blank by
 * inspection). Named `nes` here to avoid colliding with the local `conn`
 * recordingSeams variable used in the mode-distinction tests.
 */
const nes = (s: string) => asNonEmptyString(s)!;

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

// Brand a literal as a FiniteNumber for tests that drive the sink port directly.
// In production every value reaching the sink is branded by `mapEventToFoundry`'s
// `asFinite`; tests calling `trackEvent`/`trackMetric` by hand must brand too
// (the port's numeric channels are `FiniteNumber`, not bare `number`).
const finite = (n: number): FiniteNumber => n as FiniteNumber;

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
// Default path (no Foundry) — byte-for-byte unchanged (observability spec SC-006 / FR-003 / FR-027)
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
    auth: { mode: "connection-string", connectionString: nes("InstrumentationKey=abc") },
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
// Dual-export path — order + both backends (observability spec FR-002 / FR-011)
// ---------------------------------------------------------------------------
describe("composeObservability — dual-export path", () => {
  const resolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["mlflow", "foundry"],
    auth: { mode: "entra-id", connectionString: nes("InstrumentationKey=abc") },
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
// Policy sharing — discarded trace produces NO domain events (observability spec FR-021 / SC-010)
// ---------------------------------------------------------------------------
describe("composeObservability — shared policy gating (observability spec FR-021 / SC-010)", () => {
  const resolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["mlflow", "foundry"],
    auth: { mode: "connection-string", connectionString: nes("InstrumentationKey=abc") },
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
// observability spec SC-008 — full run summary (nodeCount / retryCount / cacheHitCount)
// ---------------------------------------------------------------------------
describe("FoundryRunSummaryObserver — full observability spec FR-019 summary (observability spec SC-008)", () => {
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
    sink.trackEvent({ name: "e", properties: { a: "1" }, measurements: { m: finite(2) } });
    expect(f.tracked).toEqual([
      { kind: "event", payload: { name: "e", properties: { a: "1" }, measurements: { m: 2 } } },
    ]);
  });

  test("trackMetric forwards name + value + properties", () => {
    const f = fakeClient();
    const sink = foundrySinkOver(f.client);
    sink.trackMetric({ name: "m", value: finite(3), properties: { dagId: "d" } });
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
// createAppInsightsClient — auth translation (observability spec FR-022 / FR-023)
// BOTH modes build an ISOLATED client (useGlobalProviders:false); entra-id adds
// a credential via config.aadTokenCredential — NO global useAzureMonitor distro,
// so the sink never collides with the framework's global TracerProvider.
// NO live Azure: every effectful seam (credential, credential application,
// TelemetryClient ctor) is a fake.
// ---------------------------------------------------------------------------
describe("createAppInsightsClient — auth translation", () => {
  /** Recording seams capturing which branch ran and with what args. */
  const recordingSeams = () => {
    const credentialCalls: number[] = [];
    const fakeCredential = { getToken: async () => null } as unknown as ReturnType<
      AppInsightsClientSeams["credentialFactory"]
    >;
    const credentialApplications: Array<{ toFakeClient: boolean; credentialIsFake: boolean }> = [];
    const clientCalls: Array<{ connectionString: string; options: { useGlobalProviders: boolean } }> = [];
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
      newClient: (connectionString, options) => {
        clientCalls.push({ connectionString, options });
        return fakeClient;
      },
      applyCredential: (client, credential) => {
        credentialApplications.push({
          toFakeClient: client === fakeClient,
          credentialIsFake: credential === fakeCredential,
        });
      },
    };
    return {
      seams,
      get credentialInvocations() { return credentialCalls.length; },
      credentialApplications,
      clientCalls,
    };
  };

  test("entra-id mode: isolated client + credential applied to it", () => {
    const r = recordingSeams();
    createAppInsightsClient(
      { mode: "entra-id", connectionString: nes("InstrumentationKey=entra") },
      r.seams,
    );
    // The credential factory IS invoked (observability spec FR-023).
    expect(r.credentialInvocations).toBe(1);
    // The credential is applied to the SAME isolated client (config.aadTokenCredential),
    // not configured through a global pipeline.
    expect(r.credentialApplications.length).toBe(1);
    expect(r.credentialApplications[0]).toEqual({ toFakeClient: true, credentialIsFake: true });
    // The client is ISOLATED — useGlobalProviders:false even for entra-id.
    expect(r.clientCalls.length).toBe(1);
    expect(r.clientCalls[0]!.options).toEqual({ useGlobalProviders: false });
    expect(r.clientCalls[0]!.connectionString).toBe("InstrumentationKey=entra");
  });

  test("connection-string mode: NO credential, isolated client", () => {
    const r = recordingSeams();
    createAppInsightsClient(
      { mode: "connection-string", connectionString: nes("InstrumentationKey=conn") },
      r.seams,
    );
    // credentialFactory must NOT be invoked (no Entra path).
    expect(r.credentialInvocations).toBe(0);
    // No credential is applied.
    expect(r.credentialApplications.length).toBe(0);
    // Isolated client: useGlobalProviders:false MUST be passed (regression guard).
    expect(r.clientCalls.length).toBe(1);
    expect(r.clientCalls[0]!.options).toEqual({ useGlobalProviders: false });
    expect(r.clientCalls[0]!.connectionString).toBe("InstrumentationKey=conn");
  });

  test("swapping the two modes would fail: branches are distinct", () => {
    const entra = recordingSeams();
    createAppInsightsClient({ mode: "entra-id", connectionString: nes("x") }, entra.seams);
    const conn = recordingSeams();
    createAppInsightsClient({ mode: "connection-string", connectionString: nes("x") }, conn.seams);

    // entra-id applies a credential; connection-string never does.
    expect(entra.credentialApplications.length).toBe(1);
    expect(conn.credentialApplications.length).toBe(0);
    // BOTH isolate the client — neither registers a global provider.
    expect(entra.clientCalls[0]!.options).toEqual({ useGlobalProviders: false });
    expect(conn.clientCalls[0]!.options).toEqual({ useGlobalProviders: false });
  });

  test("default applyCredential lands the credential on config.aadTokenCredential", () => {
    // Override ONLY credentialFactory + newClient; let the REAL default
    // applyCredential run so we assert the actual wiring that replaces the
    // global useAzureMonitor distro: an isolated client authenticates via AAD
    // purely through config.aadTokenCredential (which the shim forwards to its
    // Azure Monitor exporter on lazy initialize()).
    const fakeCredential = { getToken: async () => null } as unknown as ReturnType<
      AppInsightsClientSeams["credentialFactory"]
    >;
    const client = {
      config: {} as { aadTokenCredential?: unknown },
      trackEvent: () => {},
      trackMetric: () => {},
      flush: () => {},
    };
    createAppInsightsClient(
      { mode: "entra-id", connectionString: nes("InstrumentationKey=entra") },
      {
        credentialFactory: () => fakeCredential,
        newClient: () => client as unknown as AppInsightsClient,
      },
    );
    expect(client.config.aadTokenCredential).toBe(fakeCredential);
  });
});

// ---------------------------------------------------------------------------
// createFoundrySink — production composer (createAppInsightsClient → foundrySinkOver)
// The two constituents are covered above; this asserts the one-line wiring:
// the resolved auth reaches createAppInsightsClient, the seams pass through, and
// the returned value is a working FoundryTelemetrySink over that client.
// ---------------------------------------------------------------------------
describe("createFoundrySink — production composer", () => {
  test("wires resolved auth + seams through to a sink over the isolated client", () => {
    const events: Array<{ name: string }> = [];
    const fakeClient: AppInsightsClient = {
      trackEvent: (e) => {
        events.push({ name: e.name });
      },
      trackMetric: () => {},
      flush: () => {},
    };
    const clientCalls: Array<{ connectionString: string; options: { useGlobalProviders: boolean } }> = [];
    const seams: Partial<AppInsightsClientSeams> = {
      newClient: (connectionString, options) => {
        clientCalls.push({ connectionString, options });
        return fakeClient;
      },
    };

    const sink = createFoundrySink(
      { mode: "connection-string", connectionString: nes("InstrumentationKey=compose") },
      seams,
    );

    // The auth's connection string reached the (isolated) client constructor.
    expect(clientCalls).toEqual([
      { connectionString: "InstrumentationKey=compose", options: { useGlobalProviders: false } },
    ]);
    // The returned sink forwards onto that exact client.
    sink.trackEvent({ name: "composed-event" });
    expect(events).toEqual([{ name: "composed-event" }]);
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
// Round-21 atl-2 — the observer bounds its OWN buffer (TTL orphan sweep,
// BufferedObserver parity): a run that never emits `run-end` must not leak.
// Round-22 cr-1 — eviction is INACTIVITY-based: a run that is still emitting
// events is alive and must never be dropped mid-run (SC-008); only buffers
// idle past the TTL are evicted.
// ---------------------------------------------------------------------------
describe("FoundryRunSummaryObserver — orphan-buffer eviction (round-21 atl-2 / round-22 cr-1)", () => {
  test("a run whose run-end never arrives is evicted after the TTL", () => {
    const { warns } = recordingFrameworkLogger();
    const { sink, events } = recordingSink();
    let t = 1_000;
    const obs = new FoundryRunSummaryObserver(sink, {
      ttlMs: 500,
      sweepIntervalMs: 0, // no timer — eviction is driven explicitly
      now: () => t,
    });

    obs.observe(nodeStart("rOrphan", "d1", "n1"));
    obs.observe(nodeSkippedCheckpoint("rOrphan", "d1", "n2"));
    expect(obs.evicted).toBe(0);

    // Advance past the TTL (inactivity-based: last activity at t=1_000,
    // cutoff at t=1_500) and sweep: the orphaned buffer is dropped and
    // counted — the class is memory-safe standalone, not only under the
    // production wrapper.
    t = 1_600;
    obs.evictStale();
    expect(obs.evicted).toBe(1);
    expect(warns.some((w) => w.msg.includes("evicted stale run buffer for runId 'rOrphan'"))).toBe(true);

    // A LATE run-end after eviction sees an empty buffer: the summary is the
    // run-end-only baseline — no leak, no crash.
    obs.observe(runEnd("rOrphan", "d1", "ok", 10));
    const summaries = events.filter((e) => e.name === FOUNDRY_EVENT_RUN_SUMMARY);
    expect(summaries).toHaveLength(1);
  });

  test("an ACTIVE run spanning the TTL is never evicted mid-run (round-22 cr-1)", () => {
    const { sink, events } = recordingSink();
    let t = 0;
    const obs = new FoundryRunSummaryObserver(sink, {
      ttlMs: 500,
      sweepIntervalMs: 0,
      now: () => t,
    });

    // Events keep arriving, far past the TTL (a long-running DAG /
    // awaiting-human run): each event refreshes lastActivityAt, so every
    // sweep sees the run alive.
    obs.observe(nodeStart("rActive", "d1", "n1"));     // lastActivityAt = 0 (opened)
    t = 400;
    obs.observe(nodeSkippedCheckpoint("rActive", "d1", "n2")); // lastActivityAt = 400
    t = 800;
    obs.evictStale(); // cutoff 300 — 400 ≥ 300: alive (activity refresh won)
    expect(obs.evicted).toBe(0);
    obs.observe(nodeSkippedCheckpoint("rActive", "d1", "n3")); // lastActivityAt = 800
    t = 1_200;
    obs.evictStale(); // cutoff 700 — 800 ≥ 700: still alive
    expect(obs.evicted).toBe(0);

    // The run-end finally arrives: the full summary is emitted — the buffer
    // was NEVER dropped, so nodeCount reflects the real run.
    t = 1_300;
    obs.observe(runEnd("rActive", "d1", "ok", 10));
    const summaries = events.filter((e) => e.name === FOUNDRY_EVENT_RUN_SUMMARY);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0] as { measurements?: { nodeCount?: number } };
    expect(summary.measurements?.nodeCount).toBe(3);
  });

  test("an already-open buffer absorbs events even when the clock misbehaves (round-22 cr-2)", () => {
    const { sink, events } = recordingSink();
    let t = 1_000;
    let broken = false;
    const obs = new FoundryRunSummaryObserver(sink, {
      ttlMs: 500,
      sweepIntervalMs: 0,
      now: () => {
        if (broken) throw new Error("clock boom");
        return t;
      },
    });
    obs.observe(nodeStart("rHostile", "d1", "n1")); // opens the buffer
    // The clock breaks for subsequent events of the SAME run: the open buffer
    // must still absorb them (no stamp needed) — events are only dropped when
    // a NEW buffer would have to be opened unstampable.
    broken = true;
    obs.observe(nodeSkippedCheckpoint("rHostile", "d1", "n2"));
    obs.observe(nodeSkippedCheckpoint("rHostile", "d1", "n3"));
    expect(obs.droppedEvents).toBe(0);
    broken = false;
    obs.observe(runEnd("rHostile", "d1", "ok", 10));
    const summaries = events.filter((e) => e.name === FOUNDRY_EVENT_RUN_SUMMARY);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0] as { measurements?: { nodeCount?: number } };
    expect(summary.measurements?.nodeCount).toBe(3);
  });

  test("a run that emits run-end on time is never touched by the sweep", () => {
    const { sink } = recordingSink();
    let t = 1_000;
    const obs = new FoundryRunSummaryObserver(sink, {
      ttlMs: 500,
      sweepIntervalMs: 0,
      now: () => t,
    });
    obs.observe(nodeStart("rFresh", "d1", "n1"));
    t = 1_400; // inside the TTL
    obs.evictStale();
    expect(obs.evicted).toBe(0);

    t = 1_500; // still inside the TTL at run-end time
    obs.observe(runEnd("rFresh", "d1", "ok", 5));
    expect(obs.evicted).toBe(0);
  });

  test("a hostile injected clock cannot break observe() and disables eviction loudly for that cycle", () => {
    const { warns } = recordingFrameworkLogger();
    const { sink } = recordingSink();
    let t: number | null = 1_000;
    const obs = new FoundryRunSummaryObserver(sink, {
      ttlMs: 500,
      sweepIntervalMs: 0,
      now: () => {
        if (t === null) throw new Error("clock boom");
        return t;
      },
    });
    // observe() skips buffering when the clock is untrustworthy (never throws).
    expect(() => obs.observe(nodeStart("rHostile", "d1", "n1"))).not.toThrow();
    const obs2 = new FoundryRunSummaryObserver(sink, {
      ttlMs: 500,
      sweepIntervalMs: 0,
      now: () => Number.NaN,
    });
    obs2.observe(nodeStart("rNaN", "d1", "n1"));
    obs2.evictStale();
    expect(warns.some((w) => w.msg.includes("clock returned a non-finite stamp"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — Foundry construction failure must NOT disable MLflow tracing
// (observability spec FR-026 / SC-006 / SC-009)
// ---------------------------------------------------------------------------
describe("resolveFoundryLeg — Foundry construction is isolated from MLflow", () => {
  const dualResolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["mlflow", "foundry"],
    auth: { mode: "connection-string", connectionString: nes("InstrumentationKey=abc") },
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
      auth: { mode: "entra-id", connectionString: nes("InstrumentationKey=abc") },
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

// ---------------------------------------------------------------------------
// Bootstrap wiring — ONE shared persistence-policy instance reaches BOTH the
// trace pipeline (initTracing) and the domain-event observer (observability spec FR-021 / SC-010).
//
// The composition layer above proves the observer gates on its given policy, and
// init.test.ts proves initTracing exposes the policy it was handed. The gap this
// closes is bootstrap-specific: that the SAME instance flows to both consumers.
// A regression creating two policies would let a run persist spans while
// dropping events (or vice versa). We reproduce bootstrap's exact three-step
// wiring (resolveFoundryLeg → composeObservability → initTracing) with a SINGLE
// policy const and assert the instance is shared end-to-end.
// ---------------------------------------------------------------------------
describe("bootstrap wiring — single shared policy instance (observability spec FR-021 / SC-010)", () => {
  const dualResolved: ResolvedObservability = {
    kind: "with-foundry",
    traceBackends: ["mlflow", "foundry"],
    auth: { mode: "connection-string", connectionString: nes("InstrumentationKey=abc") },
  };

  test("the SAME policy instance flows to initTracing and gates the observer", async () => {
    // A deterministic, controllable policy so the behavioural half is exact (no
    // ratio() randomness). `flush` toggles the single instance's decision.
    let flush = false;
    const policy: PersistencePolicy = { shouldFlush: () => flush };

    const { sink, events } = recordingSink();
    // Reproduce bootstrap: leg → compose (observer) → initTracing, ONE `policy`.
    const leg = resolveFoundryLeg(
      dualResolved,
      () => fakeExporter("foundry"),
      () => sink,
      { error: () => { throw new Error("must not log on success"); } },
    );
    const composed = composeObservability(leg.effective, policy, factoriesWith(sink));
    const tracing = await initTracing({ exporter: composed.exporters, policy });
    const bo = composed.observer as BufferedObserver;

    try {
      // 1. initTracing received the EXACT instance (referential identity).
      expect(tracing.policy).toBe(policy);

      // 2. The observer's flush/drop decision is governed by that SAME instance:
      //    with flush=false a completed run emits nothing through the sink.
      bo.observe(runStart("rShared", "dShared"));
      bo.observe(routeDecided("rShared", "dShared"));
      bo.observe(runEnd("rShared", "dShared", "ok", 100));
      expect(events).toEqual([]);

      // Flip the same instance → the next run flushes its buffered events.
      flush = true;
      bo.observe(runStart("rShared2", "dShared"));
      bo.observe(routeDecided("rShared2", "dShared"));
      bo.observe(runEnd("rShared2", "dShared", "ok", 100));
      expect(events.map((e) => e.name)).toContain(FOUNDRY_EVENT_RUN_SUMMARY);
    } finally {
      bo.close();
      await tracing.shutdown();
    }
  });

  test("bootstrap's actual policy shape (anyOf/errorOnly/hadRetry/ratio) is the instance initTracing exposes", async () => {
    // Use the literal policy expression bootstrap builds so a refactor that
    // changes the policy type still exercises the shared-instance contract.
    const policy = anyOf(errorOnly(), hadRetry(), ratio(0.25));
    const { sink } = recordingSink();
    const composed = composeObservability(dualResolved, policy, factoriesWith(sink));
    const tracing = await initTracing({ exporter: composed.exporters, policy });
    try {
      expect(tracing.policy).toBe(policy);
    } finally {
      (composed.observer as BufferedObserver).close();
      await tracing.shutdown();
    }
  });
});
