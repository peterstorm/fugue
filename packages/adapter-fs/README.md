# @fuguejs/fs

Local-filesystem adapter for the generic [`DocumentSource`](../document-source)
capability. Reads files from a mounted directory for nodes that declare
`requires: ["documents"]` and use `ctx.documents`.

This is the adapter with **no external unknowns** (no auth, no network): wire a
DAG end-to-end against a local `.xlsx` for dev/test, then swap in
[`@fuguejs/ms-graph`](../adapter-ms-graph) by configuration with no node changes.

- **AI/usage guide:** [`docs/llm-document-source.md`](../document-source/docs/llm-document-source.md)
- **Design:** [`docs/adr/0052-document-source-capability.md`](../../docs/adr/0052-document-source-capability.md)

## Usage

```ts
import { createFsAdapter } from "@fuguejs/fs";
import { localPathRef } from "@fuguejs/document-source"; // also re-exported from @fuguejs/fs

const docs = createFsAdapter({ rootDir: "/data/reports" }); // e.g. a PVC mount

// Register with the host:
const sharedInfra = { ...infra, capabilities: [docs] };

// In a node — path is relative to rootDir:
createFetchNode({
  id: "fetch-sheet",
  requires: ["documents"] as const,
  fetch: (input, ctx) => ctx.documents.getContent(localPathRef(`${input.period}.xlsx`)),
});
```

## Security — confined to `rootDir`

Every `localPath` resolves *relative to* `rootDir` and is rejected
(non-retriable) if it escapes (`../` traversal, absolute paths) — the local
equivalent of SharePoint's `Sites.Selected`. Confinement is **lexical**; for
untrusted input over symlinked roots, mount the volume read-only and/or disallow
symlink-following at the mount.

## Config

```ts
createFsAdapter({
  rootDir: string,    // reads confined here; also stat'd at connect() to verify the mount
  fsImpl?: FsLike,    // inject node:fs/promises slice for tests
});
```

## Error mapping

| fs code | `FrameworkError` |
|---|---|
| `ENOENT` (missing), `EACCES`/`EPERM` (denied), `EISDIR` | non-retriable `node-crash` |
| traversal / foreign `FileRef` variant | non-retriable `node-crash` |
| `EIO`/`EBUSY`/other | `transient` |

## Deployment (OpenShift)

The pod filesystem is ephemeral — get the file there via an RWX
PersistentVolume, an initContainer staging into an `emptyDir`, or (small static
files) a ConfigMap/Secret volume. If the file lives in SharePoint, prefer
`@fuguejs/ms-graph` and skip disk entirely. See ADR-0052 for the ranked options.

## Exports

`createFsAdapter`, `FsAdapterConfig`, `FsLike`, `mapFsError`,
`resolveWithinRoot` (pure helpers exported for testing), plus the re-exported
port surface (`localPathRef`, `fileRefKey`, `createFakeDocumentSource`, types).
