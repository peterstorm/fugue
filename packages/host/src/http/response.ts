/**
 * Typed response builders for the Fugue host HTTP layer.
 *
 * All responses are JSON. Error responses follow the ErrorResponse shape
 * from the spec. Success responses wrap arbitrary DAG output.
 */

import type { Context } from "hono";
import type { DescribedDag } from "@fuguejs/framework";
import type { HostState } from "../domain/host-state.js";
import { canServeRequests } from "../domain/host-state.js";

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

interface ErrorResponse {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
  readonly details?: unknown;
  readonly dagId?: string;
  readonly runId?: string;
}

interface SuccessResponse<T = unknown> {
  readonly ok: true;
  readonly data: T;
  readonly runId?: string;
  readonly durationMs?: number;
}

export interface DagListItem {
  readonly id: string;
  readonly route: string;
  readonly description: string;
  readonly version: string;
  readonly healthy: boolean;
  readonly team: string;
  /** Owner from the DAG's fugue.yaml, when declared. */
  readonly owner?: string;
}

interface DagListResponse {
  readonly dags: readonly DagListItem[];
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Manifest response — GET /dags/:id/manifest
//
// The per-DAG fields are imported verbatim from `@fuguejs/framework`'s
// `DescribedDag` so the host's HTTP contract stays in lockstep with what
// `fugue describe` emits. Host-specific deployment metadata (team, healthy,
// sha, loadedAt) is appended on top of that shape.
// ---------------------------------------------------------------------------


export interface DagManifestResponse extends DescribedDag {
  readonly team: string;
  readonly healthy: boolean;
  readonly sha: string;
  readonly loadedAt: number;
}

interface HealthResponse {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly timestamp: string;
}

interface ReadinessResponse {
  readonly ready: boolean;
  readonly dagCount: number;
  readonly phase: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Hono's StatusCode type is limited — this helper bypasses it safely for known HTTP codes. */
type HttpStatus = 200 | 400 | 403 | 404 | 408 | 410 | 429 | 500 | 503;
const jsonWithStatus = <T>(c: Context, body: T, status: HttpStatus | number): Response =>
  c.json(body, status as 200);

export const errorResponse = (
  c: Context,
  status: number,
  error: string,
  message: string,
  opts?: { details?: unknown; dagId?: string; runId?: string; headers?: Record<string, string> },
): Response => {
  const body: ErrorResponse = {
    ok: false,
    error,
    message,
    ...(opts?.details !== undefined && { details: opts.details }),
    ...(opts?.dagId && { dagId: opts.dagId }),
    ...(opts?.runId && { runId: opts.runId }),
  };

  if (opts?.headers) {
    for (const [key, value] of Object.entries(opts.headers)) {
      c.header(key, value);
    }
  }

  return jsonWithStatus(c, body, status);
};

/** Return the canonical 503 response when the host lifecycle cannot serve. */
export const hostUnavailableResponse = (c: Context, state: HostState): Response | null =>
  canServeRequests(state)
    ? null
    : errorResponse(c, 503, "host-unavailable", `Host is ${state.phase} — not accepting requests`, {
        details: { phase: state.phase },
      });

export const successResponse = <T>(
  c: Context,
  data: T,
  opts?: { runId?: string; durationMs?: number },
): Response => {
  const body: SuccessResponse<T> = {
    ok: true,
    data,
    ...(opts?.runId && { runId: opts.runId }),
    ...(opts?.durationMs !== undefined && { durationMs: opts.durationMs }),
  };
  return c.json(body, 200);
};

export const dagListResponse = (c: Context, dags: readonly DagListItem[]): Response => {
  const body: DagListResponse = { dags, count: dags.length };
  return c.json(body, 200);
};

export const healthResponse = (
  c: Context,
  status: "ok" | "degraded" | "unavailable",
): Response => {
  const body: HealthResponse = { status, timestamp: new Date().toISOString() };
  const httpStatus = status === "unavailable" ? 503 : 200;
  return jsonWithStatus(c, body, httpStatus);
};

export const readinessResponse = (
  c: Context,
  ready: boolean,
  dagCount: number,
  phase: string,
): Response => {
  const body: ReadinessResponse = { ready, dagCount, phase };
  const httpStatus = ready ? 200 : 503;
  return jsonWithStatus(c, body, httpStatus);
};
