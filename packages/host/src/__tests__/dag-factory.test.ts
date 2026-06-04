import { describe, test, expect } from "bun:test";
import { dagId, gitSha } from "@fuguejs/framework";
import type { DagDef } from "@fuguejs/framework";
import { z } from "zod";
import {
  extractTeam,
  loadResultToRegisteredDag,
  loadResultsToSnapshots,
  DEFAULT_HOST_TIMEOUT_DEFAULTS,
  type HostTimeoutDefaults,
} from "../domain/dag-factory.js";
import type { LoadResult } from "../ports.js";
import type { DagRegistrationConfig } from "../domain/dag-registration.js";

const SHA = gitSha("a".repeat(40));
const NOW = 1_700_000_000_000;

const makeLoadResult = (
  id: string,
  modulePath: string,
  config?: DagRegistrationConfig,
): LoadResult => ({
  id: dagId(id),
  modulePath,
  prompts: new Map(),
  registration: {
    dag: { id: dagId(id), nodes: [], edges: [] } as unknown as DagDef,
    inputSchema: z.object({ q: z.string() }),
    config,
    meta: { description: "d", version: "1.0.0" },
  },
});

describe("extractTeam", () => {
  test("extracts team from the conventional dags/{team}/{name}/dag.ts path", () => {
    expect(extractTeam("/repo/dags/billing/invoice/dag.ts")).toBe("billing");
  });

  test("uses the FIRST dags segment, ignoring a clone dir that merely contains 'dags'", () => {
    expect(extractTeam("/tmp/fugue-dags-123/dags/ops/alerts/dag.ts")).toBe("ops");
  });

  test("returns 'unknown' when the path does not follow the convention", () => {
    expect(extractTeam("/some/random/path/dag.ts")).toBe("unknown");
    expect(extractTeam("dag.ts")).toBe("unknown");
  });

  test("returns 'unknown' when there is no {name}/{file} tail after the team", () => {
    // dags/team only — missing name and file segments.
    expect(extractTeam("/repo/dags/team")).toBe("unknown");
    expect(extractTeam("/repo/dags/team/dag.ts")).toBe("unknown");
  });
});

describe("loadResultToRegisteredDag", () => {
  const defaults: HostTimeoutDefaults = {
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 120_000,
    defaultMaxConcurrent: 10,
    defaultCacheTtlMs: 300_000,
    defaultCheckpointTtlMs: 86_400_000,
  };

  test("applies host timeout default when the DAG omits its own", () => {
    const reg = loadResultToRegisteredDag(makeLoadResult("d", "/repo/dags/t/d/dag.ts"), SHA, NOW, defaults);
    expect(reg.config.timeout).toBe(60_000);
  });

  test("clamps a per-DAG timeout that exceeds the host maximum", () => {
    const reg = loadResultToRegisteredDag(
      makeLoadResult("d", "/repo/dags/t/d/dag.ts", { timeoutMs: 999_999 }),
      SHA,
      NOW,
      defaults,
    );
    expect(reg.config.timeout).toBe(120_000); // clamped to maxTimeoutMs
  });

  test("uses a per-DAG timeout below the maximum verbatim", () => {
    const reg = loadResultToRegisteredDag(
      makeLoadResult("d", "/repo/dags/t/d/dag.ts", { timeoutMs: 5_000 }),
      SHA,
      NOW,
      defaults,
    );
    expect(reg.config.timeout).toBe(5_000);
  });

  test("resolves concurrency: default when omitted, override when present", () => {
    const dflt = loadResultToRegisteredDag(makeLoadResult("d", "/repo/dags/t/d/dag.ts"), SHA, NOW, defaults);
    expect(dflt.config.maxConcurrency).toBe(10);
    const over = loadResultToRegisteredDag(
      makeLoadResult("d", "/repo/dags/t/d/dag.ts", { maxConcurrent: 3 }),
      SHA,
      NOW,
      defaults,
    );
    expect(over.config.maxConcurrency).toBe(3);
  });

  test("populates TTLs with host defaults when the DAG omits them (FR-040 — no more no-expiry)", () => {
    const reg = loadResultToRegisteredDag(makeLoadResult("d", "/repo/dags/t/d/dag.ts"), SHA, NOW, defaults);
    expect(reg.config.cacheTtlMs).toBe(300_000);
    expect(reg.config.checkpointTtlMs).toBe(86_400_000);
  });

  test("per-DAG TTL overrides take precedence (FR-041)", () => {
    const reg = loadResultToRegisteredDag(
      makeLoadResult("d", "/repo/dags/t/d/dag.ts", { cacheTtlMs: 1_000, checkpointTtlMs: 2_000 }),
      SHA,
      NOW,
      defaults,
    );
    expect(reg.config.cacheTtlMs).toBe(1_000);
    expect(reg.config.checkpointTtlMs).toBe(2_000);
  });

  test("circuitBreaker override is passed through only when declared", () => {
    const without = loadResultToRegisteredDag(makeLoadResult("d", "/repo/dags/t/d/dag.ts"), SHA, NOW, defaults);
    expect(without.config.circuitBreaker).toBeUndefined();

    const withCb = loadResultToRegisteredDag(
      makeLoadResult("d", "/repo/dags/t/d/dag.ts", { circuitBreaker: { failureThreshold: 2 } }),
      SHA,
      NOW,
      defaults,
    );
    expect(withCb.config.circuitBreaker).toEqual({ failureThreshold: 2 });
  });

  test("falls back to DEFAULT_HOST_TIMEOUT_DEFAULTS when no defaults are passed", () => {
    const reg = loadResultToRegisteredDag(makeLoadResult("d", "/repo/dags/t/d/dag.ts"), SHA, NOW);
    expect(reg.config.timeout).toBe(DEFAULT_HOST_TIMEOUT_DEFAULTS.defaultTimeoutMs);
    expect(reg.config.cacheTtlMs).toBe(DEFAULT_HOST_TIMEOUT_DEFAULTS.defaultCacheTtlMs);
  });

  test("uses fugue.yaml team/owner from the LoadResult over the path-derived team", () => {
    const lr = { ...makeLoadResult("d", "/repo/dags/path-team/d/dag.ts"), team: "yaml-team", owner: "platform" };
    const reg = loadResultToRegisteredDag(lr, SHA, NOW, defaults);
    expect(reg.team).toBe("yaml-team"); // overrides path-derived "path-team"
    expect(reg.meta.owner).toBe("platform");
  });

  test("falls back to path-derived team and no owner when the LoadResult omits them", () => {
    const reg = loadResultToRegisteredDag(makeLoadResult("d", "/repo/dags/path-team/d/dag.ts"), SHA, NOW, defaults);
    expect(reg.team).toBe("path-team");
    expect(reg.meta.owner).toBeUndefined();
  });

  test("marks the DAG healthy and carries team + sha", () => {
    const reg = loadResultToRegisteredDag(makeLoadResult("d", "/repo/dags/payments/d/dag.ts"), SHA, NOW, defaults);
    expect(reg.status).toEqual({ kind: "healthy" });
    expect(reg.team).toBe("payments");
    expect(reg.sha).toBe(SHA);
  });
});

describe("loadResultsToSnapshots", () => {
  test("maps load results to id/path/sha snapshots", () => {
    const results = [
      makeLoadResult("a", "/repo/dags/t/a/dag.ts"),
      makeLoadResult("b", "/repo/dags/t/b/dag.ts"),
    ];
    expect(loadResultsToSnapshots(results, SHA)).toEqual([
      { id: dagId("a"), path: "/repo/dags/t/a/dag.ts", sha: SHA },
      { id: dagId("b"), path: "/repo/dags/t/b/dag.ts", sha: SHA },
    ]);
  });
});
