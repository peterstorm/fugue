/**
 * Architecture boundary enforcement (SC-002 / NFR-011 + functional-core purity).
 *
 * The repo has no eslint/dependency-cruiser toolchain, so the load-bearing import
 * boundaries are guarded HERE — by a test that walks the WHOLE source tree, not a
 * hand-maintained file list. This closes the gap in
 * `isolation-supervisor-secrets.test.ts`, whose structural check enumerates only
 * five named supervisor files: a NEW supervisor module that imported a concrete
 * `SecretsSource` would slip past that list but is caught here.
 *
 * Four boundaries, all security/architecture load-bearing:
 *
 *   A. SUPERVISOR ZERO-SECRETS (SC-002, NFR-011, FR-005): NO module under
 *      `src/supervisor/**` — nor the supervisor binary `main-supervisor.ts` — may
 *      import a concrete `SecretsSource` (the env-file adapter, or any future
 *      `*-secrets-source`). The dereference authority is a WORKER concern
 *      (`worker-main.ts` is the sole legitimate importer). The adapter file itself
 *      and its own test are the only allowed mentions.
 *
 *   B. FUNCTIONAL-CORE PURITY: NO module under `src/domain/**` (the functional
 *      core) may VALUE-import anything outside `domain/`. The core's RUNTIME graph
 *      stays a pure island so it is 100% unit-testable without I/O. A *type-only*
 *      `import type` of a shell port contract (e.g. `LoadResult` from the type-only
 *      aggregator `ports.ts`) is erased at compile time and creates no runtime
 *      edge, so it is allowed — but a VALUE import that escapes `domain/` is a real
 *      dependency on the shell and is forbidden. (This is stricter and less brittle
 *      than a hand-listed set of forbidden prefixes: ANY escape is caught.)
 *
 *   C. ROOT AGGREGATOR STAYS TYPE-ONLY: `ports.ts` exports NO runtime value. This
 *      is what makes boundary B's type-only escape hatch safe by CONSTRUCTION
 *      rather than incidentally — a future `export const`/value re-export in
 *      `ports.ts` could turn `domain`'s `import type` into a runtime edge, so we
 *      forbid runtime exports there outright.
 *
 *   D. REDIS ACL CREDENTIAL CHANNEL INTEGRITY (ADR-0067 / AD-6): the per-tenant
 *      ACL credential env-var NAMES (`FUGUE_REDIS_ACL_USERNAME/PASSWORD`) that the
 *      supervisor injects and the worker reads MUST agree byte-for-byte. ONLY
 *      `redis-acl.ts` may name them as string literals (it owns the shared
 *      constants); every other module reaches them through the exported
 *      `WORKER_REDIS_ACL_*_ENV` constants. A drifting literal could connect a
 *      worker UNSCOPED (fail-open on the isolation boundary), so the contract is
 *      CI-enforced here, not left to convention.
 *
 *   E. CONTROL-PLANE NAMESPACES ARE RESERVED TENANT IDS (ADR-0067 / FR-040): a
 *      per-tenant ACL grants `~fugue:<tenant>:*`. Every NON-tenant-scoped key the
 *      supervisor owns (`fugue:tenants:*`, `fugue:supervisor:*`) has a fixed
 *      segment after `fugue:`; if a tenant id equalled that segment, its ACL
 *      pattern would OVERLAP the control plane (a cross-tenant read/tamper break).
 *      `tenantId()` rejects `RESERVED_TENANT_IDS`; this boundary pins that the
 *      reserved set actually COVERS every control-plane key prefix the adapters
 *      define — so adding a new `fugue:<seg>:` control-plane key without reserving
 *      `<seg>` fails CI.
 *
 * All are enforced by reading every `.ts` source (tests excluded) and inspecting
 * its import specifiers / text — so adding a file that violates any boundary fails CI.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RESERVED_TENANT_IDS } from "../../domain/tenant.js";
import { TENANT_KEY_PREFIX, TENANT_EVENTS_CHANNEL } from "../../supervisor/registry/redis-registry-adapter.js";
import { WORKER_KEY_PREFIX } from "../../supervisor/lifecycle/worker-registry-redis.js";
import { AUDIT_STREAM_KEY } from "../../supervisor/audit/audit-sink-log-redis.js";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Recursively collect every `.ts` file under `dir`, EXCLUDING test trees. */
const collectSources = (dir: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test trees — boundaries constrain PRODUCTION code only.
      if (entry.name === "__tests__") continue;
      out.push(...collectSources(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
};

/** An imported module specifier, with whether the import is type-only (erased). */
type ImportRef = { readonly spec: string; readonly typeOnly: boolean };

/**
 * Extract the module specifiers this source imports (static `import ... from "x"`,
 * side-effect `import "x"`, and dynamic `import("x")` / `await import("x")`), each
 * tagged with whether it is a whole-clause `import type` (compile-time-erased, so
 * it creates NO runtime dependency). A dynamic `import()` is always a runtime edge.
 * A mixed inline `import { type X, Y }` is conservatively treated as a value import
 * (Y is a value). Good enough to police path-prefix boundaries between layers.
 */
const importSpecifiers = (text: string): readonly ImportRef[] => {
  const refs: ImportRef[] = [];
  // static + side-effect, capturing an optional leading `type` keyword.
  const staticRe = /import\s+(type\s+)?(?:[^"';]+?\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(text)) !== null) {
    refs.push({ spec: m[2]!, typeOnly: m[1] !== undefined });
  }
  // dynamic import() — always a runtime dependency.
  const dynRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynRe.exec(text)) !== null) {
    refs.push({ spec: m[1]!, typeOnly: false });
  }
  return refs;
};

describe("A. Supervisor zero-secrets boundary (SC-002 / NFR-011)", () => {
  it("NO supervisor module imports a concrete SecretsSource — whole-tree scan, not a hand-list", () => {
    const supervisorTree = collectSources(join(SRC_ROOT, "supervisor"));
    // The supervisor binary is the composition root — equally forbidden.
    const sources = [...supervisorTree, join(SRC_ROOT, "main-supervisor.ts")];

    // A CONCRETE adapter's own definition file (`*-secrets-source.ts`) legitimately
    // names its constructor — it DEFINES the source, it does not consume one. Skip
    // those from the constructor-name check (the spec check below never flags them:
    // they import the abstract PORT `secrets-source`, not a `-secrets-source`).
    const isConcreteAdapterDef = (file: string): boolean => /-secrets-source\.ts$/.test(file);

    const offenders: string[] = [];
    for (const file of sources) {
      // The secrets-source PORT type module is the abstract interface (no
      // dereference authority); the violation is importing a CONCRETE source.
      // We forbid the concrete adapter (`env-file-secrets-source`) AND any future
      // `*-secrets-source` CONCRETE module by matching the `-secrets-source` infix
      // — which the port path `secrets/secrets-source` (preceded by `/`, not `-`)
      // deliberately does NOT match, so referencing the TYPE stays allowed.
      const text = readFileSync(file, "utf8");
      for (const { spec } of importSpecifiers(text)) {
        if (/-secrets-source/.test(spec)) {
          offenders.push(`${relative(SRC_ROOT, file)} → ${spec}`);
        }
      }
      // Defense-in-depth: catch a re-export/alias that names ANY concrete-source
      // constructor (`createEnvFileSecretsSource`, a future `createVaultSecretsSource`,
      // …) even without importing the module path. Skip the adapter definitions.
      if (!isConcreteAdapterDef(file) && /\bcreate[A-Za-z0-9]*SecretsSource\b/.test(text)) {
        offenders.push(`${relative(SRC_ROOT, file)} names a concrete SecretsSource constructor`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the env-file SecretsSource is imported ONLY by the worker binary (its sole legitimate consumer)", () => {
    const all = collectSources(SRC_ROOT);
    const importers = all.filter((file) => {
      const text = readFileSync(file, "utf8");
      // Any CONCRETE `*-secrets-source` adapter (env-file today, vault/etc. later),
      // never the abstract port `secrets-source` (preceded by `/`, not `-`).
      return importSpecifiers(text).some(({ spec }) => /-secrets-source/.test(spec));
    });
    const importerNames = importers.map((f) => relative(SRC_ROOT, f)).sort();
    // ONLY worker-main.ts may construct the dereferencer. (The adapter module
    // itself does not import its own path, so it never appears here.)
    expect(importerNames).toEqual(["worker-main.ts"]);
  });
});

describe("B. Functional-core purity boundary (domain/ runtime graph stays within domain/)", () => {
  const DOMAIN_ROOT = join(SRC_ROOT, "domain");

  it("NO domain/ module VALUE-imports outside domain/ (type-only port contracts allowed)", () => {
    const domainSources = collectSources(DOMAIN_ROOT);
    const offenders: string[] = [];
    for (const file of domainSources) {
      const text = readFileSync(file, "utf8");
      for (const { spec, typeOnly } of importSpecifiers(text)) {
        // Only police relative imports; third-party packages (e.g.
        // "@fuguejs/framework", "zod") are fine for the core at runtime.
        // ASSUMPTION: domain/ reaches sibling modules via RELATIVE specifiers only
        // (verified true today — domain/ uses no tsconfig path aliases / package-style
        // absolute specs). If a path alias for in-repo modules is ever introduced, a
        // `domain → shell` value import via that alias would NOT start with "." and
        // would silently evade this boundary; extend the resolver here when that lands.
        if (!spec.startsWith(".")) continue;
        const resolved = join(dirname(file), spec);
        const escapesDomain = resolved !== DOMAIN_ROOT && !resolved.startsWith(DOMAIN_ROOT + sep);
        // A type-only import is erased at compile time → no runtime edge into the
        // shell, so the core stays a pure island. A VALUE import that escapes
        // domain/ is a real runtime dependency on the shell — forbidden.
        if (escapesDomain && !typeOnly) {
          offenders.push(`${relative(SRC_ROOT, file)} → ${spec} (value import escapes domain/)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("C. Root port aggregator stays type-only (keeps boundary B's escape hatch safe)", () => {
  it("ports.ts exports NO runtime value — a type-only domain import cannot become a runtime edge", () => {
    const text = readFileSync(join(SRC_ROOT, "ports.ts"), "utf8");
    // A runtime declaration export (`export const/function/class/let/var/default/
    // async function`) would give `domain`'s `import type { … } from "../ports.js"`
    // something to silently bind to as a VALUE on a future refactor.
    const runtimeDeclExport = /^export\s+(?:default\s+)?(?:async\s+)?(?:const|function|class|let|var)\b/m;
    // A value re-export (`export { Foo } from …`) would forward a runtime value;
    // a type-only re-export (`export type { Foo } from …`) is fine.
    const valueReExport = /^export\s+\{(?![^}]*\btype\b)[^}]*\}\s+from/m;
    expect(runtimeDeclExport.test(text)).toBe(false);
    expect(valueReExport.test(text)).toBe(false);
  });
});

describe("D. Redis ACL credential channel integrity (env-var names via the shared constant only)", () => {
  it("ONLY redis-acl.ts names the FUGUE_REDIS_ACL_* env vars as string literals", () => {
    const all = collectSources(SRC_ROOT);
    // The shared source of truth for the supervisor↔worker handoff contract.
    const owner = /supervisor[/\\]secrets[/\\]redis-acl\.ts$/;
    const literal = /["']FUGUE_REDIS_ACL_(?:USERNAME|PASSWORD)["']/;
    const offenders = all
      .filter((file) => !owner.test(file))
      .filter((file) => literal.test(readFileSync(file, "utf8")))
      .map((f) => relative(SRC_ROOT, f))
      .sort();
    // Every other module must reach the names via WORKER_REDIS_ACL_*_ENV, never a
    // drifting literal that could silently break the byte-for-byte contract.
    expect(offenders).toEqual([]);
  });
});

describe("E. Control-plane namespaces are reserved tenant ids (no ACL overlap)", () => {
  it("every fugue:<segment>: control-plane key prefix has its segment in RESERVED_TENANT_IDS", () => {
    // The canonical list of NON-tenant-scoped keys the supervisor adapters own.
    // Each is `fugue:<segment>:…` with a FIXED segment; that segment must be a
    // reserved tenant id so no tenant's `~fugue:<id>:*` ACL can ever overlap it.
    const controlPlaneKeys: readonly string[] = [
      TENANT_KEY_PREFIX, // fugue:tenants:
      TENANT_EVENTS_CHANNEL, // fugue:tenants:events
      WORKER_KEY_PREFIX, // fugue:supervisor:workers:
      AUDIT_STREAM_KEY, // fugue:supervisor:audit
    ];
    const offenders: string[] = [];
    for (const key of controlPlaneKeys) {
      const m = /^fugue:([A-Za-z0-9_-]+):?/.exec(key);
      if (m === null) {
        offenders.push(`${key} (not a fugue:<segment>: key)`);
        continue;
      }
      const segment = m[1]!;
      if (!RESERVED_TENANT_IDS.has(segment.toLowerCase())) {
        offenders.push(`${key} — segment "${segment}" is NOT in RESERVED_TENANT_IDS (a tenant could claim it and overlap this keyspace)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
