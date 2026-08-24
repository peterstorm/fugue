# ADR-0052: Document-Source Capability (generic file reads, MS Graph adapter)

## Status

Accepted

## Date

2026-06-03

## Context

Workflows need to read documents — specifically Excel/CSV files — that live in
external cloud storage. The first concrete need is a file that is **known to the
DAG** (its location is configuration, not a runtime decision), stored in the
**Microsoft stack** (SharePoint or OneDrive — the exact one is not yet settled).
A later need to read the same kind of file from **Google Drive** is anticipated
but not scheduled.

Two design questions had to be answered before writing code:

1. **Is reading a file a _capability_ (an injected dependency a node uses) or a
   _tool_ (an action the LLM can invoke)?** The framework already distinguishes
   the two (ADR-0051 capabilities; ADR-0012 tool surface): a tool is justified
   only when the model must decide _at runtime_ which action to take. Here the
   file is fixed by the DAG, so the model has no decision to make. A tool would
   add a tool-use round-trip and model latitude for zero benefit, and would
   forfeit determinism and tracing. **→ This is a capability, not a tool.**

2. **One provider-neutral capability, or one capability per vendor?** The
   stated want is to "make it generic so Google Drive can be added later." That
   splits into two goals:
   - _Add a provider later without a rewrite_ — already free via the registry +
     module-augmentation seam (ADR-0051): a new provider is an additive peer
     adapter, and the bytes→rows parsing is provider-agnostic and reused.
   - _One DAG node that reads from Microsoft **or** Google by configuration,
     without the node knowing which_ — this needs a single capability interface
     with swappable adapters behind it.

   The second goal is the one being chosen here, and it is **not** the
   premature-abstraction trap, because the common denominator is irreducibly
   small: "give me the bytes of a file by reference" plus "give me its
   metadata." That is the irreducible core every provider shares, not a guess
   at a rich interface.

A third concern is parsing: turning `.xlsx` bytes into typed rows is a **pure
transformation** — no I/O, no lifecycle. It belongs in a transform node in the
functional core, not in the capability and not in a tool.

## Decision

Introduce a generic **`DocumentSource`** capability registered under the
registry key **`documents`**, with **Microsoft Graph** as its first adapter
package (`@fuguejs/ms-graph`). The pipeline for a DAG-known Excel file is:

```
createFetchNode({ requires: ["documents"] })   // ref is config/input, fixed
   → ctx.documents.getContent(ref)              // Uint8Array bytes
   → createTransformNode(parseWorkbook)         // pure: bytes → Zod-validated rows
```

> The parse step is shown as a dedicated transform node for clarity, but
> `parseWorkbook` is a pure function and may equally be called *inline* inside
> the fetch node (`bytes → parseWorkbook` in one node) — the runnable examples
> in the guides and adapter READMEs favour the inline form. Both are valid; the
> split is a structuring choice, not a requirement.

### The capability surface is exactly two operations

```ts
export interface DocumentSource {
  getContent(ref: FileRef, opts?: ReadOpts): Promise<Result<Uint8Array, FrameworkError>>;
  getMetadata(ref: FileRef, opts?: ReadOpts): Promise<Result<FileMeta, FrameworkError>>;
}
```

**Guardrail (the load-bearing decision):** the shared interface holds *only*
`getContent` + `getMetadata`. The moment a need arises for provider-specific
behaviour (SharePoint folder listing, Google revision history, uploads,
search), it goes on a provider-specific capability or a narrowed sub-interface —
**never** on the shared port. Keep the common interface at the irreducible core
and it stays honest; let it grow toward "everything every provider can do" and
it rots into a lowest-common-denominator lie.

### Provider differences live in two places built to absorb them

1. **Addressing → the `FileRef` ADT.** A discriminated union, open to new
   variants. Each variant is independently valid; illegal states (a drive id
   without an item id, mixed addressing modes) are unrepresentable.

   ```ts
   export type FileRef =
     | { kind: "sharePointPath"; siteHostname: string; sitePath: string; filePath: string }
     | { kind: "driveItem"; driveId: string; itemId: string }   // either backend, IDs known
     | { kind: "shareUrl"; url: string }                         // any OneDrive/SharePoint share link
     | { kind: "localPath"; path: string };                      // local filesystem, relative to the adapter root
     // future, additive: | { kind: "googleDriveFile"; fileId: string }
   ```

   The SharePoint-vs-OneDrive question does **not** fork the design: through
   Graph both are the same primitive (a *drive* containing *driveItems*), read
   identically via `/drives/{id}/items/{id}/content`. The `shareUrl` variant
   resolves either backend from a sharing link via Graph's `/shares` endpoint.

2. **Auth + I/O → the adapter behind the `CapabilityHandle`.** The MS Graph
   adapter takes an **injected token provider** (`getAccessToken`) rather than
   bundling an auth SDK. The caller wires MSAL / `@azure/identity`
   (client-credentials, app-only) — that is the part that depends on the tenant
   and Entra app registration (reused from the Foundry work). The adapter ships
   with **zero heavy dependencies** as a result.

### Consequence of going generic: ref↔adapter pairing is a runtime contract

Because a node requires `["documents"]` without naming a provider, the type
system cannot guarantee that the `FileRef` variant handed in is one this
adapter understands. The MS Graph adapter handles the `msGraph`-style variants;
a future foreign variant (`googleDriveFile`) handed to it returns a
**fail-closed `FrameworkError`**, not a crash. This is the deliberate price of
"the node doesn't know the provider." (Before the second adapter, with a single
adapter over a closed union, this was a compile-time guarantee; now that
`FileRef` is shared across `@fuguejs/ms-graph` and `@fuguejs/fs`, the runtime guard
below is load-bearing rather than theoretical — see below.)

### Where the port type lives

The port (`DocumentSource`, `FileRef`, `FileMeta`, `ReadOpts`, the smart
constructors, `fileRefKey`, the test fake, and `unsupportedRefError`) lives in a
dedicated **`@fuguejs/document-source`** package, which augments
`CapabilityRegistry` with `documents: DocumentSource` exactly once. Adapter
packages (`@fuguejs/ms-graph`, `@fuguejs/fs`, and any future
`@fuguejs/google-drive`) depend on it, import the port, and implement
`DocumentSource` for one backend; each re-exports the port surface so it stays a
one-stop import.

This extraction was triggered by the **second adapter** (`@fuguejs/fs`), exactly
per "do not pre-abstract; extract when the second implementation is real" — the
port was factored against two concrete adapters, not guessed. With two adapters
now sharing `FileRef`, the runtime ref-guard below is load-bearing rather than
theoretical.

### Local files in a container (OpenShift)

The `@fuguejs/fs` adapter reads from a `rootDir` on the pod filesystem, confined to
that tree (the local equivalent of `Sites.Selected` — `../` traversal and
absolute escapes are rejected non-retriably). Because a pod's filesystem is
ephemeral and per-replica, "get the file onto disk" in OpenShift is a *delivery*
question separate from the read, and ranks roughly:

1. **Don't — read it remotely.** If the file lives in SharePoint, use
   `@fuguejs/ms-graph` and fetch at runtime over the network; nothing is placed on
   disk. This is the expected production path for the SharePoint source.
2. **PersistentVolume (RWX), populated by another process.** A ReadWriteMany
   volume (NFS / CephFS / Azure Files) mounted into the pod; a separate job,
   uploader, or external system writes the file and the DAG reads it via
   `@fuguejs/fs` with `rootDir` = the mount path. The realistic "file on a shared
   disk" production case.
3. **initContainer fetch → `emptyDir`.** An init container pulls the file (from
   object storage, an API, or git) into an `emptyDir` shared with the app
   container, which then reads it via `@fuguejs/fs`. Bridges a remote source to a
   local read without a persistent volume.
4. **ConfigMap / Secret volume.** Only for small (<~1 MiB), static files; use a
   Secret (binary via `binaryData`) for sensitive content. Most spreadsheets are
   too large.
5. **Baked into the image** (`COPY`). Only for truly static, non-sensitive,
   build-time data; immutable and versioned with the image.

Object storage (S3 / Azure Blob) is the cloud-native answer to "a file in the
cloud" and would be a *separate* adapter (`@fuguejs/s3`) implementing the same
`DocumentSource` port — not the `localPath` variant. The generic port means any
of these is a wiring choice, not a node change.

### Parsing stays a pure transform

`xlsx`/`csv` bytes → typed rows is a `createTransformNode` in the functional
core, provider-agnostic and fixture-testable, returning a `Result`. It is **not**
part of this capability. (The byte-download approach is chosen over Graph's
server-side Excel workbook API so parsing stays in the testable functional core
and the capability stays a dumb "give me bytes"; revisit only if files grow
large enough that in-memory download hurts, or live ranges are needed.)

### Least privilege

When the backend is SharePoint, provision the Entra app with **`Sites.Selected`**
(admin grants access to only the specific site(s) holding the file) rather than
tenant-wide `Sites.Read.All` / `Files.Read.All`. This matches the team-isolation
posture enforced elsewhere.

## Consequences

### Positive

- A DAG-known file is read with full determinism and capability tracing
  (Phase-4 OTel spans), no model latitude, no tool-use round-trip.
- Adding Google Drive later is additive: a new adapter + one `FileRef` variant.
  Nodes and the parsing transform never change.
- The MS Graph adapter has zero heavy dependencies; auth is the caller's wiring.
- Excel parsing is a pure, fixture-testable transform — no Microsoft round-trip
  to mock in unit tests.
- The "give me bytes / give me metadata" surface is small enough to be honest
  across every provider.

### Negative

- Ref↔adapter compatibility is a runtime-checked contract once the port type is
  shared, not a compile-time one. Mitigated: fail-closed `FrameworkError` on an
  unsupported ref, never a crash.
- Adapters must depend on `@fuguejs/document-source` and the port owns the single
  registry augmentation; importing an adapter transitively loads it.
- The shared port deliberately cannot express provider-specific operations;
  those require a separate capability. This is the guardrail working as intended,
  but it means richer per-provider features are out of band by design.

### Delivered vs. remaining

Delivered on this branch (compiling, unit-tested, no network):

- `@fuguejs/document-source` port package: `DocumentSource` interface, `FileRef`
  ADT (four variants incl. `localPath`), `FileMeta`, `ReadOpts`, smart
  constructors, `fileRefKey`, `unsupportedRefError`, the registry augmentation,
  and `createFakeDocumentSource`.
- `@fuguejs/ms-graph` adapter: `createMsGraphAdapter` (real Graph URL building for
  the three MS variants, injected token provider, HTTP-status → `FrameworkError`
  mapping, fail-closed on foreign variants).
- `@fuguejs/fs` adapter: `createFsAdapter` (root-confined local reads, fs-error
  classification, fail-closed on traversal and foreign variants) — the
  zero-unknowns adapter for wiring a DAG end-to-end today.
- `@fuguejs/xlsx`: the pure `parseWorkbook` transform (bytes → Zod-validated typed
  rows) on `exceljs`, with fixture and end-to-end tests. Lives in the functional
  core, separate from this capability, so it is provider-agnostic.

Remaining (gated on decisions not yet available):

- (delivered) Token-provider wiring in the host config: app-only client
  credentials (no auth SDK — the provider is pure, `adapters/ms-graph-token.ts`:
  single-flight, cached with a 60 s refresh lead, secrets never logged), wired
  from `MSGRAPH_TENANT_ID` / `MSGRAPH_CLIENT_ID` / `MSGRAPH_CLIENT_SECRET` with
  sovereign-cloud overrides (`MSGRAPH_BASE_URL` / `MSGRAPH_TOKEN_URL` /
  `MSGRAPH_SCOPE` / `MSGRAPH_REQUEST_TIMEOUT_MS`). `DOCUMENTS_ADAPTER=ms-graph`
  is now a first-class host config value in BOTH entries (single-tenant
  `main.ts` and multi-tenant `worker-main.ts`) via the shared
  `adapters/documents-capability.ts` builder.
- (delivered) The concrete variant in production is SharePoint
  `sharePointPathRef`. Tenants whose Graph backend rejects the documented
  item-path URL forms tenant-wide (probed live — peterstorm/fugue#36) use the
  opt-in `MSGRAPH_RESOLVE_PATHS=true`, which selects
  `createPathResolvingMsGraphAdapter` (`path-resolving.ts`): it resolves a
  sharePointPath ref to a driveItem id by id-based folder-walk, self-heals
  delete-and-reupload refreshes (bounded one re-walk on a 404), and delegates
  byte I/O to the stock adapter. Standard tenants keep the stock URL shape.
- (delivered, related) `zodToJsonSchema` now renders unrepresentable types
  (`z.date()`, `z.void()`, …) as open schemas instead of throwing
  (`unrepresentable: "any"`, peterstorm/fugue#36 related item), so object
  schemas with date columns are introspectable by the fan-in lint and the LLM
  structured-output path.

## Related

- ADR-0051 — Extensible capability registry (the augmentation seam this builds on)
- ADR-0012 — Tool-call surface (why a fixed-file read is a capability, not a tool)
