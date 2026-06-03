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
package (`@fugue/ms-graph`). The pipeline for a DAG-known Excel file is:

```
createFetchNode({ requires: ["documents"] })   // ref is config/input, fixed
   → ctx.documents.getContent(ref)              // Uint8Array bytes
   → createTransformNode(parseWorkbook)         // pure: bytes → Zod-validated rows
```

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
     | { kind: "shareUrl"; url: string };                        // any OneDrive/SharePoint share link
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
"the node doesn't know the provider." (Today, with one adapter and a closed
union, this is enforced at compile time; the runtime guard becomes load-bearing
once the type is extracted and shared — see below.)

### Where the port type lives (and when to move it)

For now, `DocumentSource` / `FileRef` / `FileMeta` live **in `@fugue/ms-graph`**
(matching the ADR-0051 convention that the capability interface ships with its
adapter), and that package augments `CapabilityRegistry` with
`documents: DocumentSource`. **Extraction trigger:** when a second adapter
(e.g. `@fugue/google-drive`) is added, extract the port (`DocumentSource`,
`FileRef`, `FileMeta`) into a provider-neutral home (framework types or a small
`@fugue/document-source` package) so both adapters import the same type and the
runtime ref-guard becomes meaningful. This honours "do not pre-abstract; extract
when the second implementation is real" — at that point you factor against two
concrete adapters instead of guessing.

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
- Module augmentation of `documents` currently lives in `@fugue/ms-graph`; a
  second adapter forces the documented extraction. Accepted as the correct
  "extract on second implementation" moment, not upfront cost.
- The shared port deliberately cannot express provider-specific operations;
  those require a separate capability. This is the guardrail working as intended,
  but it means richer per-provider features are out of band by design.

### Delivered vs. remaining

Delivered on this branch (compiling, unit-tested, no network):

- `@fugue/ms-graph` adapter: `DocumentSource` interface, `FileRef` ADT,
  `FileMeta`, registry augmentation, `createMsGraphAdapter` factory (real Graph
  URL building for all three ref variants, injected token provider, HTTP-status
  → `FrameworkError` mapping), and `createFakeDocumentSource` for node tests.

Remaining (gated on decisions not yet available):

- MSAL / `@azure/identity` token-provider wiring in the host config (gated on
  the Entra app + cert/secret choice).
- Confirmation of SharePoint vs OneDrive and the concrete `FileRef` variant the
  DAG will author (gated on where the file actually lives).
- `parseWorkbook` transform + fixtures (gated on a sample file and the
  `xlsx`/`exceljs` dependency choice).

## Related

- ADR-0051 — Extensible capability registry (the augmentation seam this builds on)
- ADR-0012 — Tool-call surface (why a fixed-file read is a capability, not a tool)
