import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TokenCredential } from "@azure/identity";
import {
  AzureMonitorExporter,
  AzureMonitorExporterConfigError,
  createAzureMonitorExporter,
  translateSpanForFoundry,
  type AzureMonitorInnerOpts,
} from "./azure-monitor-exporter.js";
import { setFrameworkLogger, __resetFrameworkLogger, type FrameworkLogger } from "../logger.js";
import { asNonEmptyString } from "../types/non-empty-string.js";

/** Brand a known-good literal connection string for tests (non-blank by inspection). */
const conn = (s: string) => asNonEmptyString(s)!;

// ---------------------------------------------------------------------------
// Test doubles — NO live Azure / network.
// ---------------------------------------------------------------------------

/** Span stand-in carrying real attributes so pass-through can be asserted. */
const fakeSpan = (name: string, attributes: Record<string, unknown> = {}): ReadableSpan =>
  ({ name, attributes }) as unknown as ReadableSpan;

type Behavior = { kind: "success" } | { kind: "result-failed"; message?: string };

/** Fake inner SpanExporter that records calls and behaves per Behavior. */
class FakeInner implements SpanExporter {
  exportCalls: ReadableSpan[][] = [];
  shutdownCalls = 0;
  forceFlushCalls = 0;
  constructor(private readonly behavior: Behavior = { kind: "success" }) {}

  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.exportCalls.push(spans);
    if (this.behavior.kind === "success") {
      cb({ code: ExportResultCode.SUCCESS });
    } else {
      cb({ code: ExportResultCode.FAILED, error: new Error(this.behavior.message ?? "boom") });
    }
  }
  async shutdown(): Promise<void> {
    this.shutdownCalls++;
  }
  async forceFlush(): Promise<void> {
    this.forceFlushCalls++;
  }
}

const exportOnce = (exp: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise((resolve) => exp.export(spans, resolve));

// Recording logger so warn assertions are quiet and inspectable.
let warnings: string[] = [];
const recordingLogger: FrameworkLogger = {
  debug: () => {},
  info: () => {},
  warn: (msg) => warnings.push(String(msg)),
  error: () => {},
};

beforeEach(() => {
  warnings = [];
  setFrameworkLogger(recordingLogger);
});
afterEach(() => {
  __resetFrameworkLogger();
});

/** A throwaway TokenCredential stand-in (never actually called in tests). */
const fakeCredential = (): TokenCredential => ({
  getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 60_000 }),
});

/**
 * Recording inner factory. Captures the EXACT opts the REAL `buildInner`
 * assembled and forwarded, then returns a fake inner so no network is touched.
 */
const recordingFactory = () => {
  let received: AzureMonitorInnerOpts | undefined;
  const factory = (opts: AzureMonitorInnerOpts): SpanExporter => {
    received = opts;
    return new FakeInner();
  };
  return {
    factory,
    get received() {
      return received;
    },
  };
};

describe("createAzureMonitorExporter — factory + config", () => {
  it("builds an exporter via the createInner test seam (no network)", () => {
    const inner = new FakeInner();
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    expect(exp).toBeInstanceOf(AzureMonitorExporter);
  });

  it("createInner-only seam works with NO auth and Azure is never constructed", async () => {
    const inner = new FakeInner();
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    const result = await exportOnce(exp, [fakeSpan("s1")]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(inner.exportCalls).toHaveLength(1);
  });

  it("createInner-only seam receives empty opts (no auth to assemble)", () => {
    const spy = recordingFactory();
    createAzureMonitorExporter({ createInner: spy.factory });
    expect(spy.received).toEqual({});
  });
});

// These tests exercise the REAL createAzureMonitorExporter → buildInner →
// resolveOpts assembly path and assert on the opts the REAL code forwarded to
// the seam. NO hand-wired spread, NO live Azure. A regression that drops a
// credential or swaps a key in buildInner WILL fail here.
describe("auth branches: REAL buildInner forwards the expected auth shape to the inner factory", () => {
  it("connection-string only (FR-022): forwards { connectionString }, no credential, no stray keys", () => {
    const spy = recordingFactory();
    const connectionString = conn("InstrumentationKey=abc;IngestionEndpoint=https://x");
    createAzureMonitorExporter({ auth: { connectionString }, createInner: spy.factory });
    expect(spy.received).toEqual({ connectionString });
    expect(Object.keys(spy.received!)).toEqual(["connectionString"]);
  });

  it("credential only (FR-023): forwards { credential }, no connectionString, no stray keys", () => {
    const credential = fakeCredential();
    const spy = recordingFactory();
    createAzureMonitorExporter({ auth: { credential }, createInner: spy.factory });
    expect(spy.received).toEqual({ credential });
    expect(spy.received!.credential).toBe(credential);
    expect(Object.keys(spy.received!)).toEqual(["credential"]);
  });

  it("connection-string + credential (Entra ID, FR-023): forwards BOTH, no stray keys", () => {
    const credential = fakeCredential();
    const connectionString = conn("InstrumentationKey=abc;IngestionEndpoint=https://x");
    const spy = recordingFactory();
    createAzureMonitorExporter({ auth: { connectionString, credential }, createInner: spy.factory });
    expect(spy.received).toEqual({ connectionString, credential });
    expect(spy.received!.connectionString).toBe(connectionString);
    expect(spy.received!.credential).toBe(credential);
    expect(new Set(Object.keys(spy.received!))).toEqual(new Set(["connectionString", "credential"]));
  });
});

// Integration smoke test for the ONE path every other test routes around: the
// REAL synchronous load `createRequire(__filename)` →
// `require("@azure/monitor-opentelemetry-exporter")` → destructure
// `{ AzureMonitorTraceExporter }` → `new AzureMonitorTraceExporter(opts)`, with
// NO `createInner` seam. It constructs the live exporter OBJECT only — the OTel
// exporter is passive (a BatchSpanProcessor drives batching/timers, not the
// exporter), so construction touches no network and starts no background work.
// A regression in the package's export shape (renamed/removed
// `AzureMonitorTraceExporter`) or in the `__filename` require anchor surfaces
// HERE instead of only at production startup (closes the seam-only gap).
describe("real Azure exporter load path (no seam) — integration smoke", () => {
  // Well-formed connection string: zero-GUID instrumentation key + a parseable
  // ingestion endpoint. The SDK parses this in its constructor; it never dials.
  const realConn = conn(
    "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.com/",
  );

  it("loads the Azure SDK and constructs a usable SpanExporter without a seam", () => {
    let exp: SpanExporter | undefined;
    expect(() => {
      exp = createAzureMonitorExporter({ auth: { connectionString: realConn } });
    }).not.toThrow();
    expect(exp).toBeInstanceOf(AzureMonitorExporter);
    // Lifecycle is delegated to the real inner exporter; both must be present.
    expect(typeof exp!.export).toBe("function");
    expect(typeof exp!.shutdown).toBe("function");
  });
});

describe("pass-through translation leaves spans untouched", () => {
  it("translateSpanForFoundry returns the SAME span reference (empty ATTR_MAP = identity)", () => {
    const span = fakeSpan("llm", {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-3",
      "ai.llm.cost_usd": 0.0012,
      "ai.node.id": "node-1",
    });
    const out = translateSpanForFoundry(span);
    expect(out).toBe(span);
    expect(out.attributes).toEqual(span.attributes);
  });

  it("export forwards spans with attributes unchanged to the inner exporter", async () => {
    const inner = new FakeInner();
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    const attrs = {
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 42,
      "ai.llm.cost_usd": 0.005,
      "ai.node.id": "n2",
      "ai.node.kind": "llm",
      "ai.dag.id": "dag-1",
      "ai.run.id": "run-1",
    };
    const span = fakeSpan("llm", attrs);
    await exportOnce(exp, [span]);
    expect(inner.exportCalls).toHaveLength(1);
    const exported = inner.exportCalls[0]!;
    expect(exported).toHaveLength(1);
    // FR-008 + FR-009: GenAI + enrichment attrs survive intact.
    expect(exported[0]!.attributes).toEqual(attrs);
    // FR-012: the exporter does not re-filter — no content keys were stripped/added.
    expect(Object.keys(exported[0]!.attributes)).toEqual(Object.keys(attrs));
  });

  it("export forwards an EMPTY span batch verbatim (no spurious work, SUCCESS)", async () => {
    const inner = new FakeInner();
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    const result = await exportOnce(exp, []);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(inner.exportCalls).toHaveLength(1);
    expect(inner.exportCalls[0]!).toHaveLength(0);
  });

  it("export forwards a MULTI-span batch, each span identity-translated in order", async () => {
    const inner = new FakeInner();
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    const spans = [
      fakeSpan("s1", { "ai.node.id": "n1" }),
      fakeSpan("s2", { "ai.node.id": "n2" }),
      fakeSpan("s3", { "ai.node.id": "n3" }),
    ];
    await exportOnce(exp, spans);
    expect(inner.exportCalls).toHaveLength(1);
    const exported = inner.exportCalls[0]!;
    expect(exported).toHaveLength(3);
    // Identity pass-through preserves both order and span references.
    expect(exported.map((s) => s.name)).toEqual(["s1", "s2", "s3"]);
    spans.forEach((s, i) => expect(exported[i]).toBe(s));
  });

  it("MULTI-span batch surfaces the inner FAILED code and logs the batch size", async () => {
    const inner = new FakeInner({ kind: "result-failed", message: "ingest 500" });
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    const result = await exportOnce(exp, [fakeSpan("a"), fakeSpan("b")]);
    expect(result.code).toBe(ExportResultCode.FAILED);
    // The failure log interpolates `${spans.length}` — exercise it with N>1.
    expect(warnings.some((w) => w.includes("ingest 500"))).toBe(true);
  });
});

describe("SpanExporter contract delegates to inner", () => {
  it("export delegates and surfaces the inner result code", async () => {
    const inner = new FakeInner({ kind: "result-failed", message: "ingest 503" });
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    const result = await exportOnce(exp, [fakeSpan("s")]);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(warnings.some((w) => w.includes("ingest 503"))).toBe(true);
  });

  it("shutdown delegates to inner", async () => {
    const inner = new FakeInner();
    const exp = createAzureMonitorExporter({ createInner: () => inner });
    await exp.shutdown();
    expect(inner.shutdownCalls).toBe(1);
  });

  it("forceFlush delegates to inner", async () => {
    const inner = new FakeInner();
    const exp = createAzureMonitorExporter({ createInner: () => inner }) as AzureMonitorExporter;
    await exp.forceFlush();
    expect(inner.forceFlushCalls).toBe(1);
  });
});

describe("illegal states are unrepresentable (Fix 2) + defense-in-depth runtime throw", () => {
  it("empty config does NOT compile (compile-time invariant, no runtime throw fires)", () => {
    // This closure is NEVER executed — it exists only so `tsc`/typecheck
    // exercises the @ts-expect-error directive. If `{}` ever started
    // typechecking against AzureMonitorExporterConfig, the unused directive
    // would itself become an error and break the build. That is the guard.
    const _neverRun = (): void => {
      // @ts-expect-error — {} is not assignable: the union requires `auth` or
      // `createInner`, so the empty-auth state is unrepresentable.
      createAzureMonitorExporter({});
    };
    expect(typeof _neverRun).toBe("function");
  });

  it("auth with neither field also does NOT compile", () => {
    const _neverRun = (): void => {
      // @ts-expect-error — { auth: {} } violates AzureMonitorAuth: at least one
      // of {connectionString, credential} is required by the type.
      createAzureMonitorExporter({ auth: {} });
    };
    expect(typeof _neverRun).toBe("function");
  });

  it("defense-in-depth: a dynamic (untyped, e.g. T5/env) caller smuggling empty auth fails CLOSED at runtime", () => {
    // Simulate the dynamic config boundary T5 will build from parsed env, where
    // a hole could yield an `auth` object with neither field. The runtime throw
    // is the last line of defense (the type already forbids this statically).
    const dynamicConfig = { auth: {} } as unknown as Parameters<typeof createAzureMonitorExporter>[0];
    let err: unknown;
    try {
      createAzureMonitorExporter(dynamicConfig);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AzureMonitorExporterConfigError);
    expect((err as Error).message).toContain("connectionString");
    expect((err as Error).message).toContain("credential");
  });

  it("defense-in-depth: dynamic auth with explicit undefined fields still fails closed", () => {
    const dynamicConfig = {
      auth: { connectionString: undefined, credential: undefined },
    } as unknown as Parameters<typeof createAzureMonitorExporter>[0];
    expect(() => createAzureMonitorExporter(dynamicConfig)).toThrow(
      AzureMonitorExporterConfigError,
    );
  });
});
