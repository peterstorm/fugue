/**
 * buildDocumentsCapability — the SINGLE `documents` capability wiring shared
 * by BOTH host entries (the single-tenant `main.ts` and the multi-tenant
 * `worker-main.ts`), so the adapter selection can never drift between the
 * topologies (ADR-0052).
 *
 *   DOCUMENTS_ADAPTER unset     → undefined — the capability is NOT registered
 *                                 and a DAG declaring `requires: ["documents"]`
 *                                 fails the boot-time capability check (the
 *                                 stock zero-regression baseline — same gating
 *                                 as the oracle / authedHttp capabilities)
 *   DOCUMENTS_ADAPTER=fs        → @fuguejs/fs rooted at DOCUMENTS_FS_ROOT
 *                                 (mounted volume / initContainer-staged files)
 *   DOCUMENTS_ADAPTER=ms-graph  → @fuguejs/ms-graph with app-only client
 *                                 credentials (MSGRAPH_TENANT_ID /
 *                                 MSGRAPH_CLIENT_ID / MSGRAPH_CLIENT_SECRET)
 *                                 via the v2.0 client-credentials token
 *                                 provider (ms-graph-token.ts: single-flight,
 *                                 cached with a 60 s refresh lead).
 *                                 Optional overrides: MSGRAPH_BASE_URL
 *                                 (sovereign cloud — the token scope derives
 *                                 from its origin when MSGRAPH_SCOPE is
 *                                 unset), MSGRAPH_TOKEN_URL, MSGRAPH_SCOPE,
 *                                 MSGRAPH_REQUEST_TIMEOUT_MS.
 *                                 MSGRAPH_RESOLVE_PATHS=true wraps the stock
 *                                 adapter in `createPathResolvingMsGraphAdapter`
 *                                 (peterstorm/fugue#36) for tenants whose Graph
 *                                 backend rejects the documented item-path URL
 *                                 forms tenant-wide.
 *
 * Credentials come only from config; the client secret is NEVER logged — the
 * caller's log line carries the adapter name + base URL + resolve flag at
 * most (FR-041/SC-008, mirroring the oracle capability).
 */

import type { CapabilityHandle } from "@fuguejs/framework";
import type { MsGraphAdapterConfig } from "@fuguejs/ms-graph";
import type { HostConfig } from "../domain/config.js";
import { createMsGraphTokenProvider } from "./ms-graph-token.js";

export const buildDocumentsCapability = async (
  config: HostConfig,
): Promise<CapabilityHandle<"documents"> | undefined> => {
  if (config.DOCUMENTS_ADAPTER === "fs") {
    const { createFsAdapter } = await import("@fuguejs/fs");
    // Config validation (superRefine) guarantees DOCUMENTS_FS_ROOT is set.
    return createFsAdapter({ rootDir: config.DOCUMENTS_FS_ROOT! });
  }

  if (config.DOCUMENTS_ADAPTER === "ms-graph") {
    // Config validation (superRefine) guarantees the three MSGRAPH_* credentials.
    const graphBaseUrl = config.MSGRAPH_BASE_URL;
    const getAccessToken = createMsGraphTokenProvider({
      tenantId: config.MSGRAPH_TENANT_ID!,
      clientId: config.MSGRAPH_CLIENT_ID!,
      clientSecret: config.MSGRAPH_CLIENT_SECRET!,
      ...(config.MSGRAPH_TOKEN_URL !== undefined ? { tokenUrl: config.MSGRAPH_TOKEN_URL } : {}),
      // Sovereign cloud: the scope must match the Graph base's origin. With
      // neither override set, the provider's global-cloud default applies.
      scope:
        config.MSGRAPH_SCOPE ?? (graphBaseUrl !== undefined ? `${new URL(graphBaseUrl).origin}/.default` : undefined),
      ...(config.MSGRAPH_REQUEST_TIMEOUT_MS !== undefined
        ? { requestTimeoutMs: config.MSGRAPH_REQUEST_TIMEOUT_MS }
        : {}),
    });

    const adapterConfig: MsGraphAdapterConfig = {
      getAccessToken,
      ...(graphBaseUrl !== undefined ? { graphBaseUrl } : {}),
      ...(config.MSGRAPH_REQUEST_TIMEOUT_MS !== undefined
        ? { requestTimeoutMs: config.MSGRAPH_REQUEST_TIMEOUT_MS }
        : {}),
    };

    // Dynamic import mirrors the @fuguejs/fs / ioredis pattern — the adapter
    // package loads only when configured.
    const { createMsGraphAdapter, createPathResolvingMsGraphAdapter } = await import("@fuguejs/ms-graph");
    // Opt-in (default false): standard tenants keep the stock adapter's
    // documented item-path URL shape; the path-resolving wrapper is for the
    // tenant class in peterstorm/fugue#36.
    return config.MSGRAPH_RESOLVE_PATHS
      ? createPathResolvingMsGraphAdapter(adapterConfig)
      : createMsGraphAdapter(adapterConfig);
  }

  return undefined;
};

/**
 * The boot log line for the wired `documents` capability — shared by both
 * entries so the wording (and what it reveals) can never drift. Carries the
 * adapter + non-secret config only: never credentials (FR-041/SC-008).
 */
export const describeDocumentsAdapter = (config: HostConfig): string => {
  if (config.DOCUMENTS_ADAPTER === "fs") {
    return `@fuguejs/fs rooted at ${config.DOCUMENTS_FS_ROOT}`;
  }
  if (config.DOCUMENTS_ADAPTER === "ms-graph") {
    const parts: string[] = [];
    if (config.MSGRAPH_BASE_URL !== undefined) parts.push(`base ${config.MSGRAPH_BASE_URL}`);
    if (config.MSGRAPH_RESOLVE_PATHS) parts.push("path-resolving");
    const extra = parts.length > 0 ? ` ${parts.join(", ")}` : "";
    return `@fuguejs/ms-graph app-only (tenant ${config.MSGRAPH_TENANT_ID}${extra})`;
  }
  return "(unconfigured)";
};
