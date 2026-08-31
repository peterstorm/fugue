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
| Adding a **new backend** for an existing capability (e.g. S3 for `documents`) | Depend on the port package (`@fuguejs/document-source`), implement its interface, add a `FileRef`/ref variant there. Do **not** redefine the interface. |

A capability becomes a *port with multiple adapters* only once a second backend
appears — extract the shared interface then, not before (ADR-0052). Until then,
keep the interface in the single adapter package.

---

## 2. Package skeleton

```
packages/adapter-<name>/
├── package.json        # name "@fuguejs/<name>", deps on @fuguejs/framework (+ port pkg)
├── tsconfig.json       # extends ../../tsconfig.base.json
├── README.md
└── src/
    ├── index.ts
    └── __tests__/<name>.test.ts
```

`package.json` (mirror `adapter-pg`): `"type": "module"`, `main` →
`src/index.ts` and `exports: { ".": "./src/index.ts" }` (this is a **source-first**
monorepo — workspace packages publish their TypeScript entry directly, no build
step), `scripts: { build: "tsc", typecheck: "tsc --noEmit", test: "bun test" }`,
`dependencies: { "@fuguejs/framework": "workspace:*" }`. Put heavy backend SDKs in
`peerDependencies` (or inject them — see §5).

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["@types/bun"] },
  "include": ["src"]
}
```

> **No build step for cross-package imports.** Because every workspace package
> points `main`/`exports` at `./src/index.ts`, Bun resolves importers straight to
> source — `bun install` after adding the package is enough. Do **not** add a TS
> project-`references` block: this monorepo deliberately omits them (Bun runs the
> TypeScript directly; references would only help an emit-to-`dist/` build the
> runtime never uses). The `build`/`typecheck` scripts run `tsc` for type
> verification, not for resolution.

---

## 3. Define (or import) the capability interface

New capability — define it and augment the registry **once**:

```ts
import type { Result, FrameworkError } from "@fuguejs/framework";

export interface VectorStore {
  search(query: string, k: number): Promise<Result<Match[], FrameworkError>>;
}

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    /** Access via `ctx.vectors` in nodes. */
    vectors: VectorStore;
  }
}
```

New backend for an existing port — import it, don't redefine:

```ts
import type { DocumentSource, FileRef, FileMeta } from "@fuguejs/document-source";
import { unsupportedRefError } from "@fuguejs/document-source";
```

After augmentation (or importing a package that augments), `requires: ["vectors"]`
is valid and `ctx.vectors` is typed and non-null.

---

## 4. Build the `CapabilityHandle` from config

The factory takes config and returns a handle the host lifecycle-manages.

```ts
import { ok, err, nodeId } from "@fuguejs/framework";
import type { CapabilityHandle } from "@fuguejs/framework";

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

### LLM clients must opt into shared metering

If the registry client extends `LlmClient`, the conditional handle type requires
`clientKind: "llm"`:

```ts
export const createCriticAdapter = (client: LlmClient): CapabilityHandle<"criticLlm"> => ({
  name: "criticLlm",
  client,
  clientKind: "llm",
});
```

The host uses this explicit metadata to route the main client, `judgeLlm`, and
custom boot-scoped LLM clients through one Run Spend Authority. It never duck
types method names. Omitting the marker is a compile error; adding it to a
non-LLM handle is also a compile error. Existing non-LLM adapters do not change.

An augmented registry client (a strict subtype with provider-specific aliases)
also requires `runScopedOperations`. This is declarative data mapping each alias
to one standard LLM operation. The host interprets it into the run-scoped facade;
adapter code cannot ignore the metered client or close over the boot client:

```ts
interface AugmentedCritic extends LlmClient {
  critique(req: LlmRequest<Critique>): Promise<Result<LlmResponse<Critique>, FrameworkError>>;
}

export const createAugmentedCriticAdapter = (
  provider: AugmentedCritic,
): CapabilityHandle<"augmentedCritic"> => ({
  name: "augmentedCritic",
  client: provider,
  clientKind: "llm",
  runScopedOperations: {
    critique: "sendStructured",
  },
});
```

The host-owned facade keeps boot-scoped provider resources reusable while making
every exposed provider operation authority-bearing by construction. Additional
fields on an augmented subtype must be operation-compatible aliases; arbitrary
adapter-authored facade functions are intentionally unsupported.

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
`isOk`/`isErr` from `@fuguejs/framework`.

---

## 7. Checklist

- [ ] `name` matches the `CapabilityRegistry` key exactly.
- [ ] A client extending `LlmClient` declares `clientKind: "llm"`.
- [ ] An augmented LLM subtype declares every provider alias in `runScopedOperations`.
- [ ] No exceptions escape `client` methods — everything is `Result`.
- [ ] Errors classified transient vs non-retriable correctly.
- [ ] `connect`/`close` manage all external resources; boot fails loudly.
- [ ] Backend transport is injectable; unit tests need no network/disk.
- [ ] A `createFake…` is exported for downstream node tests.
- [ ] Types check (`bun run typecheck`) and `bun test` is green.
- [ ] README shows wiring into the host `capabilities` array.
