# Document-Source Capability Reference (LLM-Optimized)

Minimal, copy-paste-ready reference for reading files (Excel, CSV, anything)
inside a Fugue DAG via the generic `documents` capability.

For the design rationale see `docs/adr/0052-document-source-capability.md`.
For DAG structure see `docs/llm-dag-authoring.md`.

---

## TL;DR decision

- **The file location is fixed/known to the DAG** (config or derived from input)
  → use the **`documents` capability** in a `createFetchNode`. No LLM tool.
- **The model must decide *which* file at runtime** (browse/search) → that is the
  only case for an LLM tool (`createLlmWithToolsNode`). Rare. Not covered here.

The capability is exactly two operations:

```ts
interface DocumentSource {
  getContent(ref: FileRef, opts?: { signal?: AbortSignal }): Promise<Result<Uint8Array, FrameworkError>>;
  getMetadata(ref: FileRef, opts?: { signal?: AbortSignal }): Promise<Result<FileMeta, FrameworkError>>;
}
```

Parsing bytes → rows is a **separate pure step**, not part of the capability.

---

## Pick an adapter

All adapters implement the same `DocumentSource` port and register under the
`documents` key. The DAG node never names the provider — it is a wiring choice.

| Adapter | Package | Backend | Auth | Use when |
|---|---|---|---|---|
| Filesystem | `@fugue/fs` | local/mounted disk | none | dev/test, RWX volume, initContainer-staged file |
| Microsoft Graph | `@fugue/ms-graph` | SharePoint / OneDrive | injected bearer token (MSAL) | the file lives in the Microsoft stack |
| *(future)* S3/Blob | `@fugue/s3` | object storage | — | cloud-native object storage |
| *(future)* Google Drive | `@fugue/google-drive` | Google Drive | — | the file lives in Google Drive |

**Start with `@fugue/fs`** — it has no external unknowns, so you can wire a DAG
end-to-end immediately, then swap in `@fugue/ms-graph` by config with no node
changes.

---

## `FileRef` — how you name the file

A discriminated union. Use the smart constructor for the variant you need.
Import from `@fugue/document-source` (or from whichever adapter — each re-exports
these).

```ts
import {
  localPathRef,        // filesystem (path relative to the adapter's rootDir)
  sharePointPathRef,   // SharePoint by site + path
  driveItemRef,        // MS Graph drive item, by stable ids
  shareUrlRef,         // any OneDrive/SharePoint sharing link
} from "@fugue/document-source";

localPathRef("reports/2026-Q2.xlsx");

sharePointPathRef({
  siteHostname: "contoso.sharepoint.com",
  sitePath: "/sites/Finance",
  filePath: "/Reports/2026-Q2.xlsx",
});

driveItemRef("b!drive-id", "01ITEMID");

shareUrlRef("https://contoso.sharepoint.com/:x:/s/Finance/Eabc...");
```

Each adapter handles only the variants it understands; handing it a foreign
variant returns a non-retriable `node-crash` error (it never throws).

---

## Read a file in a node

The file is known to the DAG, so this is a `createFetchNode` with
`requires: ["documents"] as const`. `ctx.documents` is typed and non-null.

```ts
import { z } from "zod";
import { createFetchNode } from "@fugue/framework";
import type { Result, FrameworkError } from "@fugue/framework";
import { localPathRef } from "@fugue/document-source";
import { parseWorkbook } from "@fugue/xlsx";

const InputSchema = z.object({ period: z.string() });           // e.g. "2026-Q2"
const RowSchema = z.object({ customerId: z.string(), revenue: z.coerce.number() });
const OutputSchema = z.object({ rows: z.array(RowSchema) });

export const fetchReport = createFetchNode({
  id: "fetch-report",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  requires: ["documents"] as const,
  fetch: async (input, ctx): Promise<Result<z.infer<typeof OutputSchema>, FrameworkError>> => {
    const ref = localPathRef(`${input.period}.xlsx`);          // swap for sharePointPathRef in prod
    const bytes = await ctx.documents.getContent(ref);          // I/O
    if (!bytes.ok) return bytes;                                // propagate FrameworkError
    return parseWorkbook(bytes.value, RowSchema);               // pure: bytes → Result<{ rows }>
  },
});
```

`getContent` does the I/O; `parseWorkbook` is a pure function so it stays
fixture-testable. (You may also split parsing into a separate
`createTransformNode` if you prefer the fetch node to return raw bytes —
`outputSchema: z.object({ bytes: z.instanceof(Uint8Array) })`.)

### Freshness / skip-work with metadata

```ts
const meta = await ctx.documents.getMetadata(ref);
if (meta.ok && meta.value.eTag === input.knownETag) return ok(cachedResult);
```

`FileMeta = { id, name, sizeBytes, lastModified /* ISO 8601 */, eTag?, mimeType? }`.

---

## Wire an adapter into the host

Adapters produce a `CapabilityHandle`; add it to the host's `capabilities`
array. Pick the adapter by environment — the DAG is unchanged.

```ts
import { createFsAdapter } from "@fugue/fs";
import { createMsGraphAdapter } from "@fugue/ms-graph";

const documents =
  process.env.NODE_ENV === "production"
    ? createMsGraphAdapter({
        // caller's MSAL / @azure/identity wiring (app-only client credentials)
        getAccessToken: () =>
          credential.getToken("https://graph.microsoft.com/.default").then((t) => t.token),
      })
    : createFsAdapter({ rootDir: process.env.REPORTS_DIR ?? "./fixtures/reports" });

const sharedInfra = { /* ...llm, cache, prompts... */, capabilities: [documents] };
```

The host calls `connect()` at boot (validates auth / mount), `close()` at
shutdown, and can `healthCheck()` for degraded-state detection.

### Adapter config quick reference

```ts
createFsAdapter({
  rootDir: string,            // reads confined to this tree; "../" + absolute escapes rejected
  fsImpl?: FsLike,            // inject for tests
});

createMsGraphAdapter({
  getAccessToken: () => Promise<string>,   // required; your token provider (MSAL)
  requestTimeoutMs?: number,               // default 30000
  graphBaseUrl?: string,                   // default global cloud; override for sovereign clouds / tests
  fetchImpl?: FetchLike,                   // inject for tests
});
```

---

## Errors

Both methods return `Result<_, FrameworkError>` — nothing throws. Branch on
`error.kind`:

| Situation | `kind` | Retriable? |
|---|---|---|
| File missing (fs ENOENT, Graph 404) | `node-crash` | no (`retriability: "non-retriable"`) |
| Permission denied (fs EACCES, Graph 403) | `node-crash` | no |
| Path escapes `rootDir` / unsupported `FileRef` variant | `node-crash` | no |
| Token acquisition failed / empty token | `transient` | yes |
| Throttling / 5xx / timeout / network / transient I/O | `transient` | yes (`httpStatus?` set for HTTP) |
| Workbook/driveItem JSON shape unexpected | `node-crash` | no |

```ts
const r = await ctx.documents.getContent(ref);
if (!r.ok) {
  if (r.error.kind === "node-crash") {
    // deterministic failure (missing, forbidden, bad ref) — do not retry
  }
  return r; // let the DAG runtime apply retry policy to transient errors
}
```

---

## Testing nodes (no network, no disk)

Use the backend-agnostic fake. Route by `fileRefKey(ref)`.

```ts
import { createFakeDocumentSource, fileRefKey, localPathRef } from "@fugue/document-source";

const documents = createFakeDocumentSource({
  [fileRefKey(localPathRef("2026-Q2.xlsx"))]: {
    content: new Uint8Array([/* xlsx bytes, or a fixture */]),
    metadata: { id: "2026-Q2.xlsx", name: "2026-Q2.xlsx", sizeBytes: 1024, lastModified: "2026-05-30T12:00:00Z" },
  },
});

// build a NodeContext with `documents.client`, run the node, assert on the Result.
```

A route can also force an error: `{ error: { kind: "transient", nodeId, message } }`.
An unrouted ref returns a non-retriable error (never silent empty bytes).

---

## Parsing the workbook — `@fugue/xlsx`

Parsing is deliberately **not** in the capability — it is a pure function so it
stays fixture-testable and provider-agnostic. `@fugue/xlsx` provides it:

```ts
import { z } from "zod";
import { parseWorkbook } from "@fugue/xlsx";

const RowSchema = z.object({ customerId: z.string(), revenue: z.coerce.number() });

const parsed = await parseWorkbook(bytes, RowSchema);  // Promise<Result<{ rows }, FrameworkError>>
// opts: { sheet?: string | number, headerRow?: number }  (default: first sheet, header row 1)
```

- Rows are objects keyed by the header-row cells; cells are normalised to
  primitives (formula → result, rich text / hyperlink → text, dates kept as
  `Date`). Pair numeric/date columns with `z.coerce.*` if the source stores them
  as text. Fully-blank rows are skipped.
- Errors: `node-crash` (non-retriable) for non-workbook bytes or a missing
  worksheet; `validation` (naming the row) when a row violates `rowSchema`.

The same parser works regardless of which adapter delivered the bytes — verified
end-to-end (`@fugue/fs` read from disk → `parseWorkbook`) in
`packages/xlsx/src/__tests__/end-to-end.test.ts`.

---

## Deployment: getting the file onto disk (OpenShift)

If you use `@fugue/fs` in a container, the file must reach the pod. Ranked
(see ADR-0052 for detail):

1. **Don't — read remotely** with `@fugue/ms-graph` (SharePoint over network).
2. **RWX PersistentVolume** populated by another job; `rootDir` = mount path.
3. **initContainer** fetches into a shared `emptyDir`; app reads via `@fugue/fs`.
4. **ConfigMap/Secret volume** — only for small (<~1 MiB) / sensitive static files.
5. **Baked into the image** (`COPY`) — only for static build-time data.

---

## Adding a new adapter (recipe)

To support a new backend (e.g. S3), add a peer adapter — do **not** touch nodes
or the port's two methods. See `docs/adapter-authoring.md` for the full template.

1. Add a `FileRef` variant in `@fugue/document-source` (e.g. `{ kind: "s3Object"; bucket; key }`) + a smart constructor + a `fileRefKey` case.
2. New package `@fugue/<backend>` depending on `@fugue/document-source`; implement `DocumentSource`, handling your variant and returning `unsupportedRefError("<backend>", ref)` for others.
3. Map backend errors to `FrameworkError` (transient vs non-retriable `node-crash`).
4. Provide `connect`/`close`/`healthCheck` on the `CapabilityHandle`.
5. Re-export the port surface; add unit tests with an injected client (no network).

---

## Checklist

- [ ] File location is fixed by the DAG → capability (not a tool).
- [ ] Node declares `requires: ["documents"] as const`.
- [ ] `FileRef` built with a smart constructor for the right variant.
- [ ] `getContent` result is checked (`if (!r.ok) return r`) before use.
- [ ] Parsing is a pure function, not inline I/O.
- [ ] An adapter is wired into the host `capabilities` array.
- [ ] `@fugue/fs` paths are relative to `rootDir` (no `../`, no absolute).
- [ ] Tests use `createFakeDocumentSource`, not a real backend.
