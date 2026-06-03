# Writing a Capability Adapter

How to add a new out-of-tree capability (or a new backend for an existing port)
to Fugue. Adapters are how nodes reach the outside world with framework-managed
lifecycle, typing, and `Result`-based errors. See ADR-0051 (extensible
capability registry) and ADR-0052 (the document-source port, used as the running
example).

The recipe is < 50 LOC of boilerplate. Mirror an existing adapter:
`packages/adapter-pg` (database), `packages/adapter-fs` (filesystem),
`packages/adapter-ms-graph` (HTTP/auth).

---

## 1. Two kinds of adapter

| You are… | Do this |
|---|---|
| Adding a **brand-new capability** (e.g. a vector store) | Define the capability interface + augment `CapabilityRegistry` in your package. |
| Adding a **new backend** for an existing capability (e.g. S3 for `documents`) | Depend on the port package (`@fugue/document-source`), implement its interface, add a `FileRef`/ref variant there. Do **not** redefine the interface. |

A capability becomes a *port with multiple adapters* only once a second backend
appears — extract the shared interface then, not before (ADR-0052). Until then,
keep the interface in the single adapter package.

---

## 2. Package skeleton

```
packages/adapter-<name>/
├── package.json        # name "@fugue/<name>", deps on @fugue/framework (+ port pkg)
├── tsconfig.json       # extends ../../tsconfig.base.json; references ../framework (+ port)
├── README.md
└── src/
    ├── index.ts
    └── __tests__/<name>.test.ts
```

`package.json` (mirror `adapter-pg`): `"type": "module"`, `main`/`types` →
`dist/`, `scripts: { build: "tsc", test: "bun test" }`,
`dependencies: { "@fugue/framework": "workspace:*" }`. Put heavy backend SDKs in
`peerDependencies` (or inject them — see §5).

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["@types/bun"] },
  "include": ["src"],
  "references": [{ "path": "../framework" }]
}
```

> **Cross-package imports need the dependency built.** Bun resolves a workspace
> package via its `main` (`dist/index.js`). After adding a new package, run
> `bunx tsc --build packages/adapter-<name>/tsconfig.json` so `dist/` exists,
> then `bun install`. Otherwise importers fail with "Cannot find module".

---

## 3. Define (or import) the capability interface

New capability — define it and augment the registry **once**:

```ts
import type { Result, FrameworkError } from "@fugue/framework";

export interface VectorStore {
  search(query: string, k: number): Promise<Result<Match[], FrameworkError>>;
}

declare module "@fugue/framework" {
  interface CapabilityRegistry {
    /** Access via `ctx.vectors` in nodes. */
    vectors: VectorStore;
  }
}
```

New backend for an existing port — import it, don't redefine:

```ts
import type { DocumentSource, FileRef, FileMeta } from "@fugue/document-source";
import { unsupportedRefError } from "@fugue/document-source";
```

After augmentation (or importing a package that augments), `requires: ["vectors"]`
is valid and `ctx.vectors` is typed and non-null.

---

## 4. Build the `CapabilityHandle` from config

The factory takes config and returns a handle the host lifecycle-manages.

```ts
import { ok, err, nodeId } from "@fugue/framework";
import type { CapabilityHandle } from "@fugue/framework";

const NODE = nodeId("vectors-capability"); // sentinel for errors from this adapter

export const createVectorAdapter = (config: VectorConfig): CapabilityHandle<"vectors"> => {
  const client: VectorStore = {
    search: async (query, k) => {
      try {
        const matches = await callBackend(query, k);   // your I/O
        return ok(matches);
      } catch (e) {
        return err(mapError(e));                        // never throw
      }
    },
  };

  return {
    name: "vectors",
    client,
    connect: async () => { /* validate connectivity; throw to abort boot */ },
    close: async () => { /* drain pools / sockets */ },
    healthCheck: async () => ok(undefined),             // or err(reason)
    // dependsOn: ["db"],   // optional: connect ordering (topologically sorted)
  };
};
```

Lifecycle contract (`CapabilityHandle`):
- `connect()` once at boot — throwing aborts startup.
- `close()` at shutdown — awaited before exit.
- `healthCheck()` returns `Err(reason)` when degraded.
- `dependsOn` lists other **handle-backed** capabilities to connect first.

---

## 5. Errors: map to `FrameworkError`, never throw

Classify backend failures so the DAG's retry policy behaves:

- **Transient** (retriable): network, timeout, throttling/429, 5xx, auth-token
  hiccup. `{ kind: "transient", nodeId, message, httpStatus? }`.
- **Non-retriable**: not-found, permission denied, bad input, schema mismatch,
  unsupported ref. `{ kind: "node-crash", nodeId, message, retriability: "non-retriable" }`.

Validate any structured response with Zod before returning it (parse-don't-validate).

---

## 6. Make it testable without the backend

Inject the client/transport so unit tests need no real backend (mirror
`adapter-pg`'s injected pool, `adapter-fs`'s `fsImpl`, `adapter-ms-graph`'s
`fetchImpl`):

```ts
export interface BackendConfig {
  /* ... */
  clientImpl?: BackendClient;   // defaults to the real client; tests pass a fake
}
```

Export pure helpers (error mapping, URL/path building, confinement checks) so
they can be unit-tested directly. Provide a `createFake<Capability>` for
*consumers* testing nodes that use your capability.

Tests use `bun:test`, live in `src/__tests__/`, and assert on `Result` via
`isOk`/`isErr` from `@fugue/framework`.

---

## 7. Checklist

- [ ] `name` matches the `CapabilityRegistry` key exactly.
- [ ] No exceptions escape `client` methods — everything is `Result`.
- [ ] Errors classified transient vs non-retriable correctly.
- [ ] `connect`/`close` manage all external resources; boot fails loudly.
- [ ] Backend transport is injectable; unit tests need no network/disk.
- [ ] A `createFake…` is exported for downstream node tests.
- [ ] `dist/` builds (`tsc --build`) and `bun test` is green.
- [ ] README shows wiring into the host `capabilities` array.
