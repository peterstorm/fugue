/**
 * Tests for the extensible capability registry (ADR-0051).
 *
 * Validates:
 * - Custom capabilities via module augmentation are validated at run start
 * - Custom capabilities are accessible in node `run` via dynamic properties
 * - Built-in `http` capability works with `createFetchNode`
 * - `CapabilityHandle` lifecycle (connect/close) contract
 * - `createFetchNode` with `requires` provides typed capability access
 * - Custom capabilities combine with built-in capabilities
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { N, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { runDag } from "../executor/run-dag.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createTransformNode } from "../nodes/transform.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import type { NodeDef, BaseNodeContext, Capability } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err, isOk, isErr } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { CapabilityHandle } from "../types/capability-handle.js";
import { createFakeHttpCapability } from "../http/http-capability.js";
import { NoopObserver } from "../observer/observer.js";

// ---------------------------------------------------------------------------
// Module augmentation: register a custom "db" capability for tests
// ---------------------------------------------------------------------------

interface TestDbCapability {
  query<T>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T[], FrameworkError>>;
  queryOne<T>(schema: z.ZodType<T>, sql: string, params?: unknown[]): Promise<Result<T | null, FrameworkError>>;
}

declare module "../types/node.js" {
  interface CapabilityRegistry {
    db: TestDbCapability;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const noop = async () => ({ ok: true as const, value: undefined });
const noopTracer = { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() };

const makeNode = (id: string, requires: readonly Capability[]): NodeDef<unknown, unknown> => ({
  id: N(id),
  kind: "fetch",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: requires as any,
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
});

const makeCtx = (overrides: Partial<BaseNodeContext> = {}): BaseNodeContext => ({
  runId: "r1" as any,
  dagId: "d1" as any,
  logger: { warn: () => {}, error: () => {} },
  tracer: noopTracer as any,
  observer: new NoopObserver(),
  cache: null,
  llm: null,
  prompts: null,
  judgeLlm: null,
  http: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extensible capability registry (ADR-0051)", () => {
  describe("custom capability validation", () => {
    it("custom capability 'db' missing → Err with missing-capability", () => {
      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("fetch-users", ["db"] as const)],
        edges: [],
      });
      const result = validateCapabilities(dag, makeCtx());
      expect(isErr(result)).toBe(true);
      if (!result.ok && result.error.kind === "missing-capability") {
        expect(result.error.capability).toBe("db");
        expect(result.error.nodeId).toBe(N("fetch-users"));
      }
    });

    it("custom capability 'db' present → Ok", () => {
      const fakeDb: TestDbCapability = {
        query: async () => ok([]),
        queryOne: async () => ok(null),
      };
      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("fetch-users", ["db"] as const)],
        edges: [],
      });
      // Custom capabilities set as dynamic properties on the context
      const ctx = Object.assign(makeCtx(), { db: fakeDb });
      const result = validateCapabilities(dag, ctx);
      expect(isOk(result)).toBe(true);
    });

    it("mixed built-in + custom capabilities validates both", () => {
      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("a", ["llm", "db"] as const)],
        edges: [],
      });
      // Only db present, llm missing
      const fakeDb: TestDbCapability = {
        query: async () => ok([]),
        queryOne: async () => ok(null),
      };
      const ctx = Object.assign(makeCtx(), { db: fakeDb });
      const result = validateCapabilities(dag, ctx);
      expect(isErr(result)).toBe(true);
      if (!result.ok && result.error.kind === "missing-capability") {
        expect(result.error.capability).toBe("llm");
        expect(result.error.missing).toHaveLength(1);
      }
    });
  });

  describe("makeNodeContext with capabilities record", () => {
    it("capabilities record sets custom capability on context", () => {
      const fakeDb: TestDbCapability = {
        query: async () => ok([]),
        queryOne: async () => ok(null),
      };
      const ctx = makeNodeContext({
        runId: "r1",
        dagId: "d1",
        capabilities: { db: fakeDb } as any,
      });
      expect((ctx as any).db).toBe(fakeDb);
    });

    it("built-in capabilities in capabilities record work", () => {
      const fakeHttp = createFakeHttpCapability({});
      const ctx = makeNodeContext({
        runId: "r1",
        dagId: "d1",
        capabilities: { http: fakeHttp.client },
      });
      expect(ctx.http).toBe(fakeHttp.client);
    });

    it("top-level fields take precedence over capabilities record", () => {
      const httpDirect = createFakeHttpCapability({}).client;
      const httpBag = createFakeHttpCapability({}).client;
      const ctx = makeNodeContext({
        runId: "r1",
        dagId: "d1",
        http: httpDirect,
        capabilities: { http: httpBag },
      });
      expect(ctx.http).toBe(httpDirect);
    });

    it("built-in capability sourced from the bag lands on the named field", () => {
      const fakeCache = { get: async () => null, set: async () => {} };
      const ctx = makeNodeContext({
        runId: "r1",
        dagId: "d1",
        capabilities: { cache: fakeCache } as any,
      });
      expect(ctx.cache).toBe(fakeCache as any);
    });

    it("a null capability in the bag is filtered out → surfaces as missing-capability downstream", () => {
      const ctx = makeNodeContext({
        runId: "r1",
        dagId: "d1",
        capabilities: { db: null } as any,
      });
      // null is filtered, so the dynamic property is absent on the context.
      expect("db" in (ctx as any)).toBe(false);

      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("needs-db", ["db"] as const)],
        edges: [],
      });
      const result = validateCapabilities(dag, ctx);
      expect(isErr(result)).toBe(true);
      if (!result.ok && result.error.kind === "missing-capability") {
        expect(result.error.capability).toBe("db");
      }
    });

    it("a custom capability named like a reserved field cannot shadow framework infrastructure", () => {
      // `Capability` is open to augmentation, so a malicious/colliding adapter
      // could register `tracer`/`logger`/`observer`. The runtime-guaranteed
      // infrastructure must survive — the bag entry must NOT overwrite it.
      const evilTracer = { withSpan: () => { throw new Error("hijacked"); } };
      const evilLogger = { warn: () => {}, error: () => {}, hijacked: true };
      const ctx = makeNodeContext({
        runId: "r1",
        dagId: "d1",
        capabilities: { tracer: evilTracer, logger: evilLogger, observer: { observe: () => { throw new Error("hijacked"); } } } as any,
      });
      expect(ctx.tracer).not.toBe(evilTracer as any);
      expect(ctx.logger).not.toBe(evilLogger as any);
      expect((ctx.logger as any).hijacked).toBeUndefined();
      // The real no-op tracer is intact and does not throw.
      expect(ctx.tracer).toBeDefined();
    });
  });

  describe("createFetchNode with requires", () => {
    it("creates a fetch node with capability requirements", () => {
      const UserSchema = z.object({ id: z.string(), name: z.string() });
      const node = createFetchNode({
        id: "fetch-user",
        inputSchema: z.object({ userId: z.string() }),
        outputSchema: UserSchema,
        requires: ["http"] as const,
        fetch: async (input, ctx) => {
          return ctx.http.get(`/users/${input.userId}`, { schema: UserSchema });
        },
      });
      expect(node.requires).toEqual(["http"]);
      expect(node.kind).toBe("fetch");
    });

    it("fetch node with custom capability can be validated and run", async () => {
      const UserSchema = z.object({ id: z.string(), name: z.string() });
      const fakeDb: TestDbCapability = {
        query: async <T,>(_schema: z.ZodType<T>, _sql: string, _params?: unknown[]) =>
          ok([{ id: "u1", name: "Alice" }]) as Result<T[], FrameworkError>,
        queryOne: async <T,>(_schema: z.ZodType<T>, _sql: string, _params?: unknown[]) =>
          ok({ id: "u1", name: "Alice" }) as Result<T | null, FrameworkError>,
      };

      const fetchUserNode = createFetchNode({
        id: "fetch-user",
        inputSchema: z.object({ userId: z.string() }),
        outputSchema: UserSchema,
        requires: ["db"] as const,
        fetch: async (input, ctx): Promise<Result<z.infer<typeof UserSchema>, FrameworkError>> => {
          const result = await ctx.db.queryOne(UserSchema, "SELECT * FROM users WHERE id = $1", [input.userId]);
          if (!result.ok) return result;
          if (result.value == null) return err({ kind: "node-crash", nodeId: N("fetch-user"), message: "not found", retriability: "non-retriable" });
          return ok(result.value);
        },
      });

      // Execute the node directly with a context that has the custom capability
      const ctx = Object.assign(makeCtx(), { db: fakeDb }) as any;
      const result = await fetchUserNode.run({ userId: "u1" }, ctx);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ id: "u1", name: "Alice" });
      }
    });
  });

  describe("http capability integration", () => {
    it("validates http capability requirement", () => {
      const dag = defineDagFromArray({
        id: "d",
        nodes: [makeNode("a", ["http"])],
        edges: [],
      });
      const result = validateCapabilities(dag, makeCtx({ http: null }));
      expect(isErr(result)).toBe(true);

      const fakeHttp = createFakeHttpCapability({});
      const ctxWithHttp = makeCtx({ http: fakeHttp.client });
      const result2 = validateCapabilities(dag, ctxWithHttp);
      expect(isOk(result2)).toBe(true);
    });

    it("fake http capability matches routes", async () => {
      const fakeHttp = createFakeHttpCapability({
        "GET /users/123": { id: "123", name: "Alice" },
        "POST /orders": { body: { orderId: "ord-1" } },
      });

      const UserSchema = z.object({ id: z.string(), name: z.string() });
      const result = await fakeHttp.client.get("/users/123", { schema: UserSchema });
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ id: "123", name: "Alice" });
      }
    });

    it("fake http capability returns error for unmatched routes", async () => {
      const fakeHttp = createFakeHttpCapability({});
      const result = await fakeHttp.client.get("/unknown", { schema: z.any() });
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe("transient");
      }
    });
  });

  describe("CapabilityHandle lifecycle", () => {
    it("handle exposes name and client", () => {
      const fakeHttp = createFakeHttpCapability({});
      expect(fakeHttp.name).toBe("http");
      expect(fakeHttp.client).toBeDefined();
    });

    it("custom handle with connect/close", async () => {
      let connected = false;
      let closed = false;

      const handle: CapabilityHandle<"db"> = {
        name: "db",
        client: {
          query: async () => ok([]),
          queryOne: async () => ok(null),
        },
        connect: async () => { connected = true; },
        close: async () => { closed = true; },
      };

      expect(connected).toBe(false);
      await handle.connect?.();
      expect(connected).toBe(true);

      expect(closed).toBe(false);
      await handle.close?.();
      expect(closed).toBe(true);
    });
  });

  describe("end-to-end DAG with custom capability", () => {
    it("runs a DAG with a custom db capability", async () => {
      const UserSchema = z.object({ id: z.string(), name: z.string() });
      const GreetingSchema = z.object({ greeting: z.string() });

      const fakeDb: TestDbCapability = {
        query: async <T,>(_schema: z.ZodType<T>, _sql: string, _params?: unknown[]) =>
          ok([{ id: "u1", name: "Alice" }]) as Result<T[], FrameworkError>,
        queryOne: async <T,>(_schema: z.ZodType<T>, _sql: string, _params?: unknown[]) =>
          ok({ id: "u1", name: "Alice" }) as Result<T | null, FrameworkError>,
      };

      const fetchUser = createFetchNode({
        id: "fetch-user",
        inputSchema: z.object({ userId: z.string() }),
        outputSchema: UserSchema,
        requires: ["db"] as const,
        fetch: async (input, ctx): Promise<Result<z.infer<typeof UserSchema>, FrameworkError>> => {
          const result = await ctx.db.queryOne(UserSchema, "SELECT * FROM users WHERE id = $1", [input.userId]);
          if (!result.ok) return result;
          if (result.value == null) return err({ kind: "node-crash", nodeId: N("fetch-user"), message: "not found", retriability: "non-retriable" });
          return ok(result.value);
        },
      });

      const greet = createTransformNode({
        id: "greet",
        inputSchema: UserSchema,
        outputSchema: GreetingSchema,
        transform: (user) => ok({ greeting: `Hello, ${user.name}!` }),
      });

      const dag = defineDagFromArray({
        id: "user-greeting",
        nodes: [fetchUser, greet],
        edges: [{ from: "fetch-user", to: "greet" }],
        outputNodeId: "greet",
      });

      const ctx = makeNodeContext({
        runId: "r1",
        dagId: "user-greeting",
        capabilities: { db: fakeDb } as any,
      });

      const result = await runDag(dag, { userId: "u1" }, ctx);
      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ greeting: "Hello, Alice!" });
      }
    });
  });
});
