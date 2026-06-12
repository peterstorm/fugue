# @fuguejs/document-source

The provider-neutral **document-source capability port**. Defines the
`DocumentSource` capability (registry key `documents`), the `FileRef` addressing
ADT, `FileMeta`, the test fake, and the shared `unsupportedRefError`. Backend
adapters depend on this package and implement `DocumentSource` for one store.

- **AI/usage guide:** [`docs/llm-document-source.md`](./docs/llm-document-source.md)
- **Design:** [`docs/adr/0052-document-source-capability.md`](../../docs/adr/0052-document-source-capability.md)
- **Adapters:** [`@fuguejs/fs`](../adapter-fs) (local disk), [`@fuguejs/ms-graph`](../adapter-ms-graph) (SharePoint/OneDrive)

## The port

```ts
interface DocumentSource {
  getContent(ref: FileRef, opts?: { signal?: AbortSignal }): Promise<Result<Uint8Array, FrameworkError>>;
  getMetadata(ref: FileRef, opts?: { signal?: AbortSignal }): Promise<Result<FileMeta, FrameworkError>>;
}
```

Holds **only** content + metadata reads, by design. Provider-specific
operations (listing, revisions, upload, search) belong on a separate capability,
never on this port (see ADR-0052).

## `FileRef`

Discriminated union; illegal/half-specified refs are unrepresentable. New
backends add a variant additively.

```ts
type FileRef =
  | { kind: "sharePointPath"; siteHostname; sitePath; filePath }
  | { kind: "driveItem"; driveId; itemId }
  | { kind: "shareUrl"; url }
  | { kind: "localPath"; path };
```

Constructors: `sharePointPathRef`, `driveItemRef`, `shareUrlRef`, `localPathRef`.
Key helper: `fileRefKey(ref)`.

## Exports

| Symbol | Purpose |
|---|---|
| `DocumentSource`, `FileRef`, `FileMeta`, `ReadOpts` | port types |
| `sharePointPathRef` / `driveItemRef` / `shareUrlRef` / `localPathRef` | ref constructors |
| `fileRefKey` | stable string key for a ref |
| `unsupportedRefError(adapter, ref)` | fail-closed error adapters return for foreign variants |
| `createFakeDocumentSource(routes)`, `FakeDocRoute` | in-memory fake for node tests |

Importing this package (directly or via an adapter) augments
`CapabilityRegistry` so `requires: ["documents"]` is valid and `ctx.documents`
is typed.

## Why a separate package

Extracted from `@fuguejs/ms-graph` when the second adapter (`@fuguejs/fs`) arrived,
so both share one `FileRef` type and one registry augmentation — per
"extract on second implementation" (ADR-0052). The runtime ref↔adapter guard
(each adapter fails closed on variants it doesn't implement) is load-bearing now
that two adapters share the union.
