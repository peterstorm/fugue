import { describe, test, expect, afterEach } from "bun:test";
import { createApp } from "../server.js";
import { JsonFixtureSource } from "../sources/json-fixture-source.js";
import { FakeLlmClient, InMemoryCheckpointer, dagFingerprint, FRAMEWORK_VERSION, err, ok, runId as mkRunId, nodeId as N, dagId as D, type Checkpointer, type FrameworkError } from "@fuguejs/framework";
import { createFileCheckpointer } from "@fuguejs/framework/file";
import { SummaryResponseSchema } from "../schemas/response.js";
import { createSummaryDag } from "../dag/summary-dag.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppLogger } from "../logger.js";

const fixturesDir = join(import.meta.dir, "../../fixtures/customers");

const throwingDiagnosticsLogger: AppLogger = {
  debug: () => { throw new Error("debug transport failed"); },
  info: () => {},
  warn: () => { throw new Error("warn transport failed"); },
  error: () => { throw new Error("error transport failed"); },
};

const recordingLogger = () => {
  const entries: Array<{ readonly level: string; readonly args: readonly unknown[] }> = [];
  const logger: AppLogger = {
    debug: (...args) => { entries.push({ level: "debug", args }); },
    info: (...args) => { entries.push({ level: "info", args }); },
    warn: (...args) => { entries.push({ level: "warn", args }); },
    error: (...args) => { entries.push({ level: "error", args }); },
  };
  return { logger, entries };
};

const makeSynthesisOutput = () => ({
  overallSentiment: "mixed" as const,
  sentimentScore: 0.3,
  keyTopics: ["billing"],
  summary: "Customer had billing questions.",
  actionItems: [],
  riskLevel: "low" as const,
  customerSatisfaction: "satisfied" as const,
});

const createTestApp = (cp: Checkpointer = new InMemoryCheckpointer()) => {
  const source = new JsonFixtureSource(fixturesDir);
  // FakeLlmClient keyed by model name used in synthesize node
  const llm = new FakeLlmClient(
    new Map([["claude-sonnet-4-20250514", makeSynthesisOutput()]]),
  );
  const prompts = new Map([["synthesis", "Summarize customer {{customerId}}"]]);
  // /summarize requires both checkpoint read/meta and node-output write ports.
  // Tests that intentionally exercise an incomplete pair construct the app directly.
  return createApp({
    source,
    llm,
    prompts,
    checkpointer: cp,
    checkpointWriter: {
      async write(runId, nodeId, output) {
        const saved = await cp.saveNode(runId, { nodeId, output, completedAt: new Date() });
        if (!saved.ok) throw new Error(`test checkpoint write failed: ${saved.error.kind}`);
      },
    },
  });
};

const createDelayedFailureApp = (
  failure: FrameworkError,
  logger: AppLogger,
  requestTimeoutMs = 1,
) => {
  const cp = new InMemoryCheckpointer();
  return createApp({
    source: {
      fetchCustomer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return err(failure);
      },
    },
    llm: new FakeLlmClient(new Map()),
    checkpointer: cp,
    checkpointWriter: {
      async write(runId, nodeId, output) {
        const saved = await cp.saveNode(runId, { nodeId, output, completedAt: new Date() });
        if (!saved.ok) throw new Error(`test checkpoint write failed: ${saved.error.kind}`);
      },
    },
    requestTimeoutMs,
    logger,
  });
};

// Compute the DAG identity that /summarize will compare against on resume.
// Tests that pre-seed checkpoints must store the same fingerprint, otherwise
// the identity check in server.ts rejects with 409.
const currentDagIdentity = () => {
  const source = new JsonFixtureSource(fixturesDir);
  const dag = createSummaryDag(source);
  return {
    dagId: dag.id,
    nodeCount: dag.nodes.length,
    dagFingerprint: dagFingerprint(dag),
    frameworkVersion: FRAMEWORK_VERSION,
  };
};

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const get = (app: ReturnType<typeof createApp>, path: string) =>
  app.fetch(new Request(`http://localhost${path}`));

describe("POST /summarize", () => {
  test("valid customer_id returns 200 with ok status", async () => {
    const app = createTestApp();
    const res = await post(app, "/summarize", { customer_id: "cust-001" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.customerId).toBe("cust-001");
    expect(json.summary).toBeDefined();
    const parsed = SummaryResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
  });

  test("non-existent customer returns 200 with not_found status", async () => {
    const app = createTestApp();
    const res = await post(app, "/summarize", { customer_id: "cust-nonexistent" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("not_found");
    expect(json.customerId).toBe("cust-nonexistent");
    const parsed = SummaryResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
  });

  test("empty body returns 400", async () => {
    const app = createTestApp();
    const res = await app.fetch(
      new Request("http://localhost/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("an unexpected dependency failure remains a structured 500 when error logging throws", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const checkpointer: Checkpointer = {
      load: async () => { throw new Error("checkpoint transport rejected"); },
      saveNode: async () => ok(undefined),
      setMeta: async () => ok(undefined),
    };
    const app = createApp({
      source,
      llm: new FakeLlmClient(new Map()),
      checkpointer,
      checkpointWriter: { write: async () => {} },
      logger: throwingDiagnosticsLogger,
    });

    const res = await post(app, "/summarize", {
      customer_id: "cust-001",
      resume_run_id: "existing-run",
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });

  test("setMeta failure remains a structured 503 when error logging throws", async () => {
    const checkpointer: Checkpointer = {
      load: async () => ok(null),
      saveNode: async () => ok(undefined),
      setMeta: async () => err({
        kind: "cache-error",
        operation: "setMeta",
        message: "checkpoint unavailable",
      }),
    };
    const app = createApp({
      source: new JsonFixtureSource(fixturesDir),
      llm: new FakeLlmClient(new Map()),
      checkpointer,
      checkpointWriter: { write: async () => {} },
      logger: throwingDiagnosticsLogger,
    });

    const response = await post(app, "/summarize", { customer_id: "cust-001" });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("Checkpoint store unavailable");
    expect(typeof body.requestId).toBe("string");
  });

  test("malformed JSON remains a 400 when diagnostic logging throws", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const app = createApp({
      source,
      llm: new FakeLlmClient(new Map()),
      logger: throwingDiagnosticsLogger,
    });

    const res = await app.fetch(new Request("http://localhost/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  test("empty resume_run_id returns 400", async () => {
    const res = await post(createTestApp(), "/summarize", {
      customer_id: "cust-001",
      resume_run_id: "",
    });
    expect(res.status).toBe(400);
  });

  test("malformed resume_run_id returns 400", async () => {
    const res = await post(createTestApp(), "/summarize", {
      customer_id: "cust-001",
      resume_run_id: "contains spaces",
    });
    expect(res.status).toBe(400);
  });

  test("customer with no conversations returns 200 with no_history", async () => {
    const app = createTestApp();
    const res = await post(app, "/summarize", { customer_id: "cust-018" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("no_history");
    expect(json.customerId).toBe("cust-018");
    const parsed = SummaryResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
  });

  describe("resume_run_id principal binding", () => {
    // F6 spec NFR-020 backend-swap pin (pr-test-analyzer): the consumer's resume flow
    // (load + error-kind → HTTP mapping + subject binding + fingerprint/version
    // gates) must hold for ANY Checkpointer backend — the file backend is the F6
    // production one, and this handler is the only production resume consumer.
    // The Redis leg is pinned at the port level by the shared `checkpointerSuite`
    // (F6 spec SC-001); the app-level test does not bring up Redis.
    const fileDirs: string[] = [];
    const backends: ReadonlyArray<readonly [name: string, create: () => Checkpointer]> = [
      ["in-memory", () => new InMemoryCheckpointer()],
      [
        "file",
        () => {
          const dir = mkdtempSync(join(tmpdir(), "server-resume-file-"));
          fileDirs.push(dir);
          return createFileCheckpointer(dir);
        },
      ],
    ];

    afterEach(() => {
      for (const dir of fileDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    for (const [backendName, createCp] of backends) {
      describe(backendName, () => {
        const createAppWithCheckpointer = (cp: Checkpointer) => createTestApp(cp);

        test("fresh run writes meta with subject = customer_id", async () => {
          const cp = createCp();
          const app = createAppWithCheckpointer(cp);
          const res = await post(app, "/summarize", { customer_id: "cust-001" });
          expect(res.status).toBe(200);
          // After the run completes the only way to inspect meta is via load against
          // any runId — but we don't know the generated runId here. Smoke-check the
          // happy path; the IDOR test below directly exercises the principal check.
        });

        test("resume with mismatched customer_id returns 404 and does NOT replay outputs", async () => {
          const cp = createCp();
          const id = currentDagIdentity();

          // Pre-seed a checkpoint owned by victim "cust-001"
          const victimRunId = mkRunId("victim-run-id-123");
          await cp.setMeta(victimRunId, {
            dagId: id.dagId,
            startedAt: new Date(),
            nodeCount: id.nodeCount,
            subject: "cust-001",
            dagFingerprint: id.dagFingerprint,
            frameworkVersion: id.frameworkVersion,
          });
          await cp.saveNode(victimRunId, {
            nodeId: N("fetch-crm"),
            output: { customer: { customerId: "cust-001", secret: "victim-data" } },
            completedAt: new Date(),
          });

          const app = createAppWithCheckpointer(cp);
          // Attacker uses a different customer_id but the victim's runId
          const res = await post(app, "/summarize", {
            customer_id: "cust-attacker",
            resume_run_id: victimRunId,
          });

          expect(res.status).toBe(404);
          const json = await res.json();
          expect(json.error).toBe("Run not found");
        });

        test("resume with unknown runId returns 404", async () => {
          const cp = createCp();
          const app = createAppWithCheckpointer(cp);
          const res = await post(app, "/summarize", {
            customer_id: "cust-001",
            resume_run_id: "does-not-exist",
          });
          expect(res.status).toBe(404);
        });

        test("resume with matching subject succeeds", async () => {
          const cp = createCp();
          const runId = mkRunId("owner-run-id");
          const id = currentDagIdentity();
          await cp.setMeta(runId, {
            dagId: id.dagId,
            startedAt: new Date(),
            nodeCount: id.nodeCount,
            subject: "cust-001",
            dagFingerprint: id.dagFingerprint,
            frameworkVersion: id.frameworkVersion,
          });

          const app = createAppWithCheckpointer(cp);
          const res = await post(app, "/summarize", {
            customer_id: "cust-001",
            resume_run_id: runId,
          });
          expect(res.status).toBe(200);
        });

        test("resume rejects with 409 on dagFingerprint mismatch (codex finding #2)", async () => {
          const cp = createCp();
          const runId = mkRunId("fp-mismatch-run");
          const id = currentDagIdentity();
          await cp.setMeta(runId, {
            dagId: id.dagId,
            startedAt: new Date(),
            nodeCount: id.nodeCount,
            subject: "cust-001",
            dagFingerprint: "deadbeef-stale-fingerprint",
            frameworkVersion: id.frameworkVersion,
          });

          const app = createAppWithCheckpointer(cp);
          const res = await post(app, "/summarize", {
            customer_id: "cust-001",
            resume_run_id: runId,
          });
          expect(res.status).toBe(409);
          const json = await res.json();
          expect(json.error).toBe("Checkpoint incompatible with current DAG");
        });

        test("resume rejects with 409 on frameworkVersion mismatch", async () => {
          const cp = createCp();
          const runId = mkRunId("fwver-mismatch-run");
          const id = currentDagIdentity();
          await cp.setMeta(runId, {
            dagId: id.dagId,
            startedAt: new Date(),
            nodeCount: id.nodeCount,
            subject: "cust-001",
            dagFingerprint: id.dagFingerprint,
            frameworkVersion: "0", // older framework version
          });

          const app = createAppWithCheckpointer(cp);
          const res = await post(app, "/summarize", {
            customer_id: "cust-001",
            resume_run_id: runId,
          });
          expect(res.status).toBe(409);
        });

        test("resume rejects with 409 when meta predates fingerprint binding", async () => {
          // Pre-fingerprint checkpoints have subject set but no dagFingerprint or
          // frameworkVersion. They must not be replayed against the current DAG.
          const cp = createCp();
          const runId = mkRunId("preFp-run");
          await cp.setMeta(runId, {
            dagId: D("customer-summary"),
            startedAt: new Date(),
            nodeCount: 5,
            subject: "cust-001",
            // no dagFingerprint, no frameworkVersion
          });

          const app = createAppWithCheckpointer(cp);
          const res = await post(app, "/summarize", {
            customer_id: "cust-001",
            resume_run_id: runId,
          });
          expect(res.status).toBe(409);
        });

        test("resume against legacy meta (no subject) returns 404", async () => {
          const cp = createCp();
          const id = currentDagIdentity();
          const runId = mkRunId("legacy-run-id");
          await cp.setMeta(runId, {
            dagId: id.dagId,
            startedAt: new Date(),
            nodeCount: id.nodeCount,
            dagFingerprint: id.dagFingerprint,
            frameworkVersion: id.frameworkVersion,
            // no subject — pre-fix data
          });

          const app = createAppWithCheckpointer(cp);
          const res = await post(app, "/summarize", {
            customer_id: "cust-001",
            resume_run_id: runId,
          });
          expect(res.status).toBe(404);
        });
      });
    }

    test("resume fails closed when the checkpointer reports a corrupt node address", async () => {
      const base = new InMemoryCheckpointer();
      const id = currentDagIdentity();
      const runId = mkRunId("corrupt-node-run");
      await base.setMeta(runId, {
        dagId: id.dagId,
        startedAt: new Date(),
        nodeCount: id.nodeCount,
        subject: "cust-001",
        dagFingerprint: id.dagFingerprint,
        frameworkVersion: id.frameworkVersion,
      });
      await base.saveNode(runId, {
        nodeId: N("fetch-crm"),
        output: { customer: { customerId: "cust-001", secret: "must-not-resume" } },
        completedAt: new Date(),
      });
      const corrupting: Checkpointer = {
        load: async (requestedRunId, opts) => {
          const loaded = await base.load(requestedRunId, opts);
          if (!loaded.ok || loaded.value === null) return loaded;
          return ok({
            ...loaded.value,
            corruptNodeAddresses: [{ kind: "node-key", nodeKey: "fetch-crm" }],
          });
        },
        saveNode: (requestedRunId, state, opts) => base.saveNode(requestedRunId, state, opts),
        setMeta: (requestedRunId, meta) => base.setMeta(requestedRunId, meta),
      };

      const res = await post(createTestApp(corrupting), "/summarize", {
        customer_id: "cust-001",
        resume_run_id: runId,
      });

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Resume failed");
    });

    test("/summarize returns 503 when checkpointer is null (codex finding #1)", async () => {
      const source = new JsonFixtureSource(fixturesDir);
      const llm = new FakeLlmClient(
        new Map([["claude-sonnet-4-20250514", makeSynthesisOutput()]]),
      );
      const prompts = new Map([["synthesis", "Summarize customer {{customerId}}"]]);
      const app = createApp({ source, llm, prompts, checkpointer: null });
      const res = await post(app, "/summarize", { customer_id: "cust-001" });
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe("Checkpoint store unavailable");
    });

    test("/summarize returns 503 when the node-output checkpoint writer is missing", async () => {
      const source = new JsonFixtureSource(fixturesDir);
      const llm = new FakeLlmClient(
        new Map([["claude-sonnet-4-20250514", makeSynthesisOutput()]]),
      );
      const app = createApp({
        source,
        llm,
        prompts: new Map([["synthesis", "Summarize customer {{customerId}}"]]),
        checkpointer: new InMemoryCheckpointer(),
      });

      const res = await post(app, "/summarize", { customer_id: "cust-001" });

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Checkpoint store unavailable");
    });

    test("/summarize returns 503 even when resume_run_id is provided but checkpointer null", async () => {
      // Belt-and-suspenders: prior bug let this through with a generated runId.
      const source = new JsonFixtureSource(fixturesDir);
      const llm = new FakeLlmClient(
        new Map([["claude-sonnet-4-20250514", makeSynthesisOutput()]]),
      );
      const prompts = new Map([["synthesis", "Summarize customer {{customerId}}"]]);
      const app = createApp({ source, llm, prompts, checkpointer: null });
      const res = await post(app, "/summarize", {
        customer_id: "cust-001",
        resume_run_id: "any-id",
      });
      expect(res.status).toBe(503);
    });

  });

  test("rejects an invalid request timeout at app construction", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createApp({
        source: new JsonFixtureSource(fixturesDir),
        llm: new FakeLlmClient(new Map()),
        requestTimeoutMs: invalid,
      })).toThrow("requestTimeoutMs must be a positive safe integer");
    }
  });

  test("the hard request deadline returns 504 and logs its cause", async () => {
    const { logger, entries } = recordingLogger();
    const app = createDelayedFailureApp(
      { kind: "aborted", reason: "signal" },
      logger,
    );

    const response = await post(app, "/summarize", { customer_id: "cust-timeout" });

    expect(response.status).toBe(504);
    expect(entries.some(({ level, args }) =>
      level === "warn" && String(args[0]).includes("cause=hard request deadline expired")
    )).toBe(true);

    await Bun.sleep(20);
    expect(entries.some(({ level, args }) =>
      level === "error" && String(args[0]).includes("DAG failed after timeout")
    )).toBe(true);
  });

  test("a non-abort failure settling before the deadline remains a logged 500", async () => {
    const { logger, entries } = recordingLogger();
    const app = createDelayedFailureApp(
      {
        kind: "node-crash",
        nodeId: N("fetch-crm"),
        retriability: "non-retriable",
        message: "checkpoint writer exploded after timeout",
      },
      logger,
      50,
    );

    const response = await post(app, "/summarize", { customer_id: "cust-race" });

    expect(response.status).toBe(500);
    expect(entries.some(({ level, args }) =>
      level === "error" && args.some((arg) => String(arg).includes("checkpoint writer exploded after timeout"))
    )).toBe(true);
    expect(entries.some(({ level }) => level === "warn")).toBe(false);
  });

  test("an abort-insensitive source cannot hold the request past its deadline", async () => {
    const cp = new InMemoryCheckpointer();
    const app = createApp({
      source: { fetchCustomer: () => new Promise(() => {}) },
      llm: new FakeLlmClient(new Map()),
      checkpointer: cp,
      checkpointWriter: { write: async () => {} },
      requestTimeoutMs: 5,
    });

    const response = await Promise.race([
      post(app, "/summarize", { customer_id: "cust-hung" }),
      Bun.sleep(250).then(() => { throw new Error("request remained wedged"); }),
    ]);

    expect(response.status).toBe(504);
    expect((await response.json()).error).toBe("Request timeout");
  });

  test("all response variants match SummaryResponseSchema", async () => {
    const app = createTestApp();

    // ok
    const okRes = await post(app, "/summarize", { customer_id: "cust-001" });
    expect(SummaryResponseSchema.safeParse(await okRes.json()).success).toBe(true);

    // not_found
    const nfRes = await post(app, "/summarize", { customer_id: "no-such" });
    expect(SummaryResponseSchema.safeParse(await nfRes.json()).success).toBe(true);

    // no_history
    const nhRes = await post(app, "/summarize", { customer_id: "cust-018" });
    expect(SummaryResponseSchema.safeParse(await nhRes.json()).success).toBe(true);
  });
});

describe("GET /livez", () => {
  test("always returns 200 alive", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    // Even with all deps down, /livez stays 200 — k8s should restart only on hang.
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => false,
        checkMlflow: async () => false,
      },
    });
    const res = await get(app, "/livez");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("alive");
  });
});

describe("GET /readyz", () => {
  test("returns 200 ready when all deps up", async () => {
    const app = createTestApp();
    const res = await get(app, "/readyz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ready");
    expect(json.redis).toBe(true);
    expect(json.mlflow).toBe(true);
  });

  test("mlflow down does NOT gate readiness — 200 ready-degraded", async () => {
    // Tracing outage must not pull pods out of rotation.
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => true,
        checkMlflow: async () => false,
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ready-degraded");
    expect(json.redis).toBe(true);
    expect(json.mlflow).toBe(false);
  });

  test("redis down returns 503 not-ready", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => false,
        checkMlflow: async () => true,
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("not-ready");
    expect(json.redis).toBe(false);
  });

  test("redis check throws — treated as down (503)", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => { throw new Error("connection refused"); },
        checkMlflow: async () => true,
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("not-ready");
  });

  test("a synchronous readiness probe throw is contained and logged", async () => {
    const { logger, entries } = recordingLogger();
    const app = createApp({
      source: new JsonFixtureSource(fixturesDir),
      llm: new FakeLlmClient(new Map()),
      logger,
      health: {
        checkRedis: () => { throw new Error("synchronous redis probe fault"); },
        checkMlflow: async () => true,
      },
    });

    const response = await get(app, "/readyz");

    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe("not-ready");
    expect(entries.some(({ level, args }) =>
      level === "debug" && args.some((arg) => String(arg).includes("synchronous redis probe fault"))
    )).toBe(true);
  });

  test("rejecting readiness probe remains not-ready when diagnostic logging throws", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const app = createApp({
      source,
      llm: new FakeLlmClient(new Map()),
      logger: throwingDiagnosticsLogger,
      health: {
        checkRedis: async () => { throw new Error("redis probe failed"); },
        checkMlflow: async () => true,
      },
    });

    const res = await get(app, "/readyz");

    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("not-ready");
  });

  test("unavailable LLM (unconfigured fake fallback) gates readiness — 503 not-ready", async () => {
    // The bootstrap no-API-key fallback puts the app on the unconfigured
    // FakeLlmClient: every /summarize is guaranteed to fail, so readiness must
    // report not-ready (silent-failure-hunter-2) instead of serving traffic in.
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => true,
        checkLlm: async () => false,
        checkMlflow: async () => true,
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("not-ready");
    expect(json.redis).toBe(true);
    expect(json.llm).toBe(false);
  });

  test("checkLlm probe throws — treated as down (503)", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => true,
        checkLlm: async () => { throw new Error("llm probe fault"); },
        checkMlflow: async () => true,
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("not-ready");
    expect(json.llm).toBe(false);
  });

  test("a failing secondary trace backend degrades the signal but does NOT gate readiness (observability spec FR-026)", async () => {
    // Multi-backend deployment where one exporter (e.g. Foundry) keeps failing
    // while MLflow succeeds. This must surface as ready-degraded@200 with the
    // per-child counts visible — never 503 (a Foundry fault must not remove the pod).
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => true,
        checkMlflow: async () => true,
        tracingExporterFailures: () => [
          { index: 0, failures: 0 },
          { index: 1, failures: 42 },
        ],
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ready-degraded");
    expect(json.redis).toBe(true);
    expect(json.mlflow).toBe(true);
    // The counts are surfaced for the operator.
    expect(json.tracingExporterFailures).toEqual([
      { index: 0, failures: 0 },
      { index: 1, failures: 42 },
    ]);
  });

  test("a synchronous tracing counter throw returns structured ready-degraded", async () => {
    const { logger, entries } = recordingLogger();
    const app = createApp({
      source: new JsonFixtureSource(fixturesDir),
      llm: new FakeLlmClient(new Map()),
      logger,
      health: {
        checkRedis: async () => true,
        checkMlflow: async () => true,
        tracingExporterFailures: () => { throw new Error("counter getter fault"); },
      },
    });

    const response = await get(app, "/readyz");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ready-degraded");
    expect(body.tracingExporterFailures).toBeUndefined();
    expect(entries.some(({ level, args }) =>
      level === "debug" && args.some((arg) => String(arg).includes("counter getter fault"))
    )).toBe(true);
  });

  test("a synchronous tracing counter throw stays structured when diagnostic logging throws", async () => {
    const app = createApp({
      source: new JsonFixtureSource(fixturesDir),
      llm: new FakeLlmClient(new Map()),
      logger: throwingDiagnosticsLogger,
      health: {
        checkRedis: async () => true,
        checkMlflow: async () => true,
        tracingExporterFailures: () => { throw new Error("counter getter fault"); },
      },
    });

    const response = await get(app, "/readyz");

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ready-degraded");
  });

  test("multi-backend with zero failures stays fully ready and reports the counts", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => true,
        checkMlflow: async () => true,
        tracingExporterFailures: () => [
          { index: 0, failures: 0 },
          { index: 1, failures: 0 },
        ],
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ready");
    expect(json.tracingExporterFailures).toEqual([
      { index: 0, failures: 0 },
      { index: 1, failures: 0 },
    ]);
  });

  test("single-backend deployment (null counts) omits the field and stays ready", async () => {
    const source = new JsonFixtureSource(fixturesDir);
    const llm = new FakeLlmClient(new Map());
    const app = createApp({
      source,
      llm,
      health: {
        checkRedis: async () => true,
        checkMlflow: async () => true,
        tracingExporterFailures: () => null,
      },
    });
    const res = await get(app, "/readyz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ready");
    expect(json.tracingExporterFailures).toBeUndefined();
  });
});
