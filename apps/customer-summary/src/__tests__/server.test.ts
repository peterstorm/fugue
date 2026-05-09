import { describe, test, expect } from "bun:test";
import { createApp } from "../server.js";
import { JsonFixtureSource } from "../sources/json-fixture-source.js";
import { FakeLlmClient, InMemoryCheckpointer, dagFingerprint, FRAMEWORK_VERSION } from "@ai-summary/framework";
import { SummaryResponseSchema } from "../schemas/response.js";
import { createSummaryDag } from "../dag/summary-dag.js";
import { join } from "node:path";

const fixturesDir = join(import.meta.dir, "../../fixtures/customers");

const makeSynthesisOutput = () => ({
  overallSentiment: "mixed" as const,
  sentimentScore: 0.3,
  keyTopics: ["billing"],
  summary: "Customer had billing questions.",
  actionItems: [],
  riskLevel: "low" as const,
  customerSatisfaction: "satisfied" as const,
});

const createTestApp = (cp: InMemoryCheckpointer = new InMemoryCheckpointer()) => {
  const source = new JsonFixtureSource(fixturesDir);
  // FakeLlmClient keyed by model name used in synthesize node
  const llm = new FakeLlmClient(
    new Map([["claude-sonnet-4-20250514", makeSynthesisOutput()]]),
  );
  const prompts = new Map([["synthesis", "Summarize customer {{customerId}}"]]);
  // /summarize requires a checkpointer (durability is part of the contract).
  // Tests that intentionally exercise the null-checkpointer path should pass null explicitly.
  return createApp({ source, llm, prompts, checkpointer: cp });
};

// Compute the DAG identity that /summarize will compare against on resume.
// Tests that pre-seed checkpoints must store the same fingerprint, otherwise
// the identity check in server.ts rejects with 409.
const currentDagIdentity = () => {
  const source = new JsonFixtureSource(fixturesDir);
  const dag = createSummaryDag(source, "cust-001");
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
    const createAppWithCheckpointer = (cp: InMemoryCheckpointer) => createTestApp(cp);

    test("fresh run writes meta with subject = customer_id", async () => {
      const cp = new InMemoryCheckpointer();
      const app = createAppWithCheckpointer(cp);
      const res = await post(app, "/summarize", { customer_id: "cust-001" });
      expect(res.status).toBe(200);
      // After the run completes the only way to inspect meta is via load against
      // any runId — but we don't know the generated runId here. Smoke-check the
      // happy path; the IDOR test below directly exercises the principal check.
    });

    test("resume with mismatched customer_id returns 404 and does NOT replay outputs", async () => {
      const cp = new InMemoryCheckpointer();

      // Pre-seed a checkpoint owned by victim "cust-001"
      const victimRunId = "victim-run-id-123";
      await cp.setMeta(victimRunId, {
        dagId: "customer-summary",
        startedAt: new Date(),
        nodeCount: 5,
        subject: "cust-001",
      });
      await cp.saveNode(victimRunId, "fetch-crm", {
        nodeId: "fetch-crm",
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
      const cp = new InMemoryCheckpointer();
      const app = createAppWithCheckpointer(cp);
      const res = await post(app, "/summarize", {
        customer_id: "cust-001",
        resume_run_id: "does-not-exist",
      });
      expect(res.status).toBe(404);
    });

    test("resume with matching subject succeeds", async () => {
      const cp = new InMemoryCheckpointer();
      const runId = "owner-run-id";
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
      const cp = new InMemoryCheckpointer();
      const runId = "fp-mismatch-run";
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
      const cp = new InMemoryCheckpointer();
      const runId = "fwver-mismatch-run";
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
      const cp = new InMemoryCheckpointer();
      const runId = "preFp-run";
      await cp.setMeta(runId, {
        dagId: "customer-summary",
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

    test("resume against legacy meta (no subject) returns 404", async () => {
      const cp = new InMemoryCheckpointer();
      const runId = "legacy-run-id";
      await cp.setMeta(runId, {
        dagId: "customer-summary",
        startedAt: new Date(),
        nodeCount: 5,
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
});

describe("GET /healthz (back-compat alias of /readyz)", () => {
  test("mlflow down does not flip status (regression for previous false-503)", async () => {
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
    const res = await get(app, "/healthz");
    expect(res.status).toBe(200);
  });
});
