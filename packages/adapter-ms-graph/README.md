# @fugue/ms-graph

Microsoft Graph adapter for the generic **`DocumentSource`** capability. Reads
files (Excel, CSV, anything) from **SharePoint** and **OneDrive** for nodes that
declare `requires: ["documents"]` and use `ctx.documents`.

See [ADR-0052](../../docs/adr/0052-document-source-capability.md) for the design
rationale (why a fixed-location file read is a capability and not an LLM tool,
why one generic interface with swappable adapters, and the guardrail keeping
that interface honest).

## The capability is two operations

```ts
interface DocumentSource {
  getContent(ref: FileRef, opts?): Promise<Result<Uint8Array, FrameworkError>>;
  getMetadata(ref: FileRef, opts?): Promise<Result<FileMeta, FrameworkError>>;
}
```

Parsing `.xlsx` bytes into typed rows is a **separate pure transform** in the
functional core — not part of this capability.

## Addressing — `FileRef`

A discriminated union; illegal/half-specified references are unrepresentable.
The SharePoint-vs-OneDrive distinction does not change the surface (both are
Graph drives + driveItems).

```ts
sharePointPathRef({ siteHostname: "contoso.sharepoint.com", sitePath: "/sites/Finance", filePath: "/Reports/2026-Q2.xlsx" })
driveItemRef(driveId, itemId)   // when the stable ids are already held
shareUrlRef("https://contoso.sharepoint.com/:x:/s/Finance/...")  // any share link
```

## Auth is injected — this package ships no auth SDK

You provide `getAccessToken`; wire it to MSAL / `@azure/identity` (app-only
client credentials). The token cache/refresh policy stays yours.

```ts
import { createMsGraphAdapter } from "@fugue/ms-graph";
import { ClientSecretCredential } from "@azure/identity";

const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

const docs = createMsGraphAdapter({
  getAccessToken: () =>
    credential.getToken("https://graph.microsoft.com/.default").then((t) => t.token),
});

// Register with the host:
const sharedInfra = { ...infra, capabilities: [docs] };
```

**Least privilege:** for SharePoint, grant the Entra app `Sites.Selected`
(scoped to the specific site) rather than tenant-wide `Sites.Read.All`.

## Using it in a node

The file location is known to the DAG, so there is no LLM tool involved:

```ts
createFetchNode({
  id: "fetch-sheet",
  requires: ["documents"] as const,
  fetch: async (input, ctx) => {
    const ref = sharePointPathRef({
      siteHostname: "contoso.sharepoint.com",
      sitePath: "/sites/Finance",
      filePath: `/Reports/${input.period}.xlsx`,
    });
    return ctx.documents.getContent(ref);   // → bytes, then parse in a transform node
  },
});
```

## Testing nodes

Use the in-memory fake — no network, no Azure:

```ts
import { createFakeDocumentSource, driveItemRef, fileRefKey } from "@fugue/ms-graph";

const fakeDocs = createFakeDocumentSource({
  [fileRefKey(driveItemRef("d1", "i1"))]: { content: new Uint8Array([1, 2, 3]) },
});
```

## Scope

Implemented: content + metadata reads for the three `FileRef` variants, Graph
status → `FrameworkError` mapping, capability lifecycle, and the test fake.

Out of scope (by design): the `parseWorkbook` transform lives in `@fugue/xlsx`
(functional core, provider-agnostic), not this adapter; and any
provider-specific operations such as folder listing or upload belong on a
separate capability, never on the shared `DocumentSource` port.

Pending (caller's responsibility): MSAL / `@azure/identity` token-provider
wiring — the adapter takes an injected token provider.
