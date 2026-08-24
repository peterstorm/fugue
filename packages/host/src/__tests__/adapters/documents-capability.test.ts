import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostConfig } from "../../domain/config.js";
import {
  buildDocumentsCapability,
  describeDocumentsAdapter,
  type DocumentsCapabilitySeams,
} from "../../adapters/documents-capability.js";
import type { MsGraphTokenProviderConfig } from "../../adapters/ms-graph-token.js";
import { localPathRef } from "@fuguejs/fs";
import type { MsGraphAdapterConfig } from "@fuguejs/ms-graph";
import type { CapabilityHandle } from "@fuguejs/framework";

/**
 * buildDocumentsCapability — the SINGLE documents-adapter wiring shared by
 * both host entries (ADR-0052): gating (unset → undefined), the fs and
 * ms-graph selections, the path-resolving opt-in (peterstorm/fugue#36), and
 * the log-line hygiene (the client secret never appears).
 */

const validEnv = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
};

const msgGraphEnv = {
  MSGRAPH_TENANT_ID: "tenant-1",
  MSGRAPH_CLIENT_ID: "client-1",
  MSGRAPH_CLIENT_SECRET: "secret-1",
};

const config = (extra: Record<string, string | undefined>) => {
  const r = parseHostConfig({ ...validEnv, ...extra });
  if (!r.ok) throw new Error(`unexpected config failure: ${JSON.stringify(r.error)}`);
  return r.value;
};

describe("buildDocumentsCapability", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fugue-docs-"));
    await writeFile(join(root, "sheet.xlsx"), new Uint8Array([1, 2, 3]));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("unconfigured (DOCUMENTS_ADAPTER unset) → undefined — capability not registered", async () => {
    expect(await buildDocumentsCapability(config({}))).toBeUndefined();
  });

  it("fs → a handle that reads files from DOCUMENTS_FS_ROOT", async () => {
    const handle = await buildDocumentsCapability(config({ DOCUMENTS_ADAPTER: "fs", DOCUMENTS_FS_ROOT: root }));
    expect(handle).toBeDefined();
    if (handle === undefined) return;
    expect(handle.name).toBe("documents");
    const r = await handle.client.getContent(localPathRef("sheet.xlsx"));
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.value]).toEqual([1, 2, 3]);
  });

  it("ms-graph → the stock adapter handle (no listFolder — standard-tenant URL shape)", async () => {
    const handle = await buildDocumentsCapability(config({ DOCUMENTS_ADAPTER: "ms-graph", ...msgGraphEnv }));
    expect(handle).toBeDefined();
    if (handle === undefined) return;
    expect(handle.name).toBe("documents");
    expect("listFolder" in handle).toBe(false);
  });

  it("ms-graph + MSGRAPH_RESOLVE_PATHS → the path-resolving wrapper (listFolder present)", async () => {
    const handle = await buildDocumentsCapability(
      config({ DOCUMENTS_ADAPTER: "ms-graph", ...msgGraphEnv, MSGRAPH_RESOLVE_PATHS: "true" }),
    );
    expect(handle).toBeDefined();
    if (handle === undefined) return;
    expect(handle.name).toBe("documents");
    expect(typeof (handle as unknown as { listFolder?: unknown }).listFolder).toBe("function");
  });

  it("construction never touches the network — the host connects at boot, the builder only wires", async () => {
    // Both ms-graph variants must build without any token/Graph call — the
    // token provider is lazy and connect() is the host's job.
    const stock = await buildDocumentsCapability(config({ DOCUMENTS_ADAPTER: "ms-graph", ...msgGraphEnv }));
    const resolving = await buildDocumentsCapability(
      config({ DOCUMENTS_ADAPTER: "ms-graph", ...msgGraphEnv, MSGRAPH_RESOLVE_PATHS: "1" }),
    );
    expect(stock).toBeDefined();
    expect(resolving).toBeDefined();
  });

  it("derives sovereign scope and propagates request timeout to token and Graph adapters", async () => {
    let tokenConfig: MsGraphTokenProviderConfig | undefined;
    let adapterConfig: MsGraphAdapterConfig | undefined;
    const fakeHandle = {
      name: "documents",
      client: {},
    } as unknown as CapabilityHandle<"documents">;
    const seams: DocumentsCapabilitySeams = {
      createTokenProvider: (captured) => {
        tokenConfig = captured;
        return async () => "token";
      },
      loadMsGraphAdapters: async () => ({
        createMsGraphAdapter: (captured) => {
          adapterConfig = captured;
          return fakeHandle;
        },
        createPathResolvingMsGraphAdapter: () => fakeHandle,
      }),
    };

    await buildDocumentsCapability(
      config({
        DOCUMENTS_ADAPTER: "ms-graph",
        ...msgGraphEnv,
        MSGRAPH_BASE_URL: "https://graph.microsoft.us/v1.0",
        MSGRAPH_REQUEST_TIMEOUT_MS: "4321",
      }),
      seams,
    );

    expect(tokenConfig?.scope).toBe("https://graph.microsoft.us/.default");
    expect(tokenConfig?.requestTimeoutMs).toBe(4321);
    expect(adapterConfig?.graphBaseUrl).toBe("https://graph.microsoft.us/v1.0");
    expect(adapterConfig?.requestTimeoutMs).toBe(4321);
  });

  it("an explicit MSGRAPH_SCOPE overrides base-URL scope derivation", async () => {
    let tokenConfig: MsGraphTokenProviderConfig | undefined;
    const fakeHandle = {
      name: "documents",
      client: {},
    } as unknown as CapabilityHandle<"documents">;
    const seams: DocumentsCapabilitySeams = {
      createTokenProvider: (captured) => {
        tokenConfig = captured;
        return async () => "token";
      },
      loadMsGraphAdapters: async () => ({
        createMsGraphAdapter: () => fakeHandle,
        createPathResolvingMsGraphAdapter: () => fakeHandle,
      }),
    };

    await buildDocumentsCapability(
      config({
        DOCUMENTS_ADAPTER: "ms-graph",
        ...msgGraphEnv,
        MSGRAPH_BASE_URL: "https://graph.microsoft.us/v1.0",
        MSGRAPH_SCOPE: "api://custom/.default",
      }),
      seams,
    );

    expect(tokenConfig?.scope).toBe("api://custom/.default");
  });
});

describe("describeDocumentsAdapter — log hygiene (FR-041/SC-008)", () => {
  it("fs wording", () => {
    const c = config({ DOCUMENTS_ADAPTER: "fs", DOCUMENTS_FS_ROOT: "/data" });
    expect(describeDocumentsAdapter(c)).toBe("@fuguejs/fs rooted at /data");
  });

  it("ms-graph wording carries tenant + base + resolve flag, NEVER the client secret", () => {
    const c = config({
      DOCUMENTS_ADAPTER: "ms-graph",
      ...msgGraphEnv,
      MSGRAPH_BASE_URL: "https://graph.microsoft.us/v1.0",
      MSGRAPH_RESOLVE_PATHS: "true",
    });
    const line = describeDocumentsAdapter(c);
    expect(line).toContain("ms-graph");
    expect(line).toContain("tenant-1");
    expect(line).toContain("https://graph.microsoft.us/v1.0");
    expect(line).toContain("path-resolving");
    expect(line).not.toContain("secret-1");
    expect(line).not.toContain("client-1");
  });

  it("global-cloud ms-graph wording (no base override)", () => {
    const c = config({ DOCUMENTS_ADAPTER: "ms-graph", ...msgGraphEnv });
    expect(describeDocumentsAdapter(c)).toBe("@fuguejs/ms-graph app-only (tenant tenant-1)");
  });
});
