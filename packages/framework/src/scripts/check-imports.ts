/**
 * Source-boundary checker
 *
 * Enforces (one bullet per rule — the paired SC-006 gate test in
 * `__tests__/boundary-imports.test.ts` pins the complete set, so this list
 * and the RULES array cannot drift apart silently):
 *   - state-machine/** MUST NOT import bullmq, ioredis, or queue-bullmq/**
 *     (the kernel; transport adapters belong outside it)
 *   - dag-runtime/**   MUST NOT import bullmq, ioredis, or queue-bullmq/**
 *     (transport-agnostic; durable backends are wired by the shell)
 *   - scheduler/**     MUST NOT import bullmq, ioredis, or queue-bullmq/**
 *     (transport-agnostic; durable backends are wired by callers)
 *   - state-machine/** and dag-runtime/** pure-core modules MUST NOT import
 *     @opentelemetry/ (the named dag-runtime shell files are the exemption)
 *   - file/** and src/file.ts (and __tests__/file-*.test.ts) MUST NOT import
 *     bullmq, ioredis, or queue-bullmq — bare or relative at any depth
 *   - file/** and src/file.ts (the @fuguejs/framework/file backend) may import only
 *     canonical node:fs, node:crypto, and node:path among Node built-ins; bare
 *     and subpath spellings are rejected
 *   - ioredis anti-leak: index.ts, advanced.ts, testing.ts, and the
 *     intermediate cache/** and checkpoint/** barrels MUST NOT import ioredis —
 *     EXCEPT the three Redis adapter files themselves (cache/redis-cache.ts,
 *     checkpoint/redis-checkpointer.ts, checkpoint/redis-freshness-index.ts),
 *     which import it directly; queue-bullmq/** is the only other importer.
 *     ioredis has NO repo-wide ban and no "queue-bullmq only" rule — only the
 *     /redis and /bullmq subpath barrels are the permitted consumer entry
 *     points, and the main barrel stays Redis-free so default-bundle consumers
 *     do not pay for it
 *   - bullmq is imported only by queue-bullmq/** (no repo-wide ban exists for
 *     it beyond the state-machine/dag-runtime/scheduler/file rules above)
 *   - dag-runtime/** MUST NOT import ../executor (executor wraps dag-runtime,
 *     not the other way)
 *   - types/** MUST NOT import runtime or utility modules (../dag-runtime,
 *     ../shared, ../executor; the types/index.ts barrel keeps its own
 *     narrower rule)
 *   - shared/** MUST NOT import @opentelemetry/, ../observer, or ../tracing
 *   - file/** implementation modules MUST NOT call the public string-typed
 *     frameworkError.cacheError factory directly; boundary-error.ts is the
 *     sole bridge into the backend-local FileOperation vocabulary
 *
 * Scans all .ts files (excluding .d.ts) under packages/framework/src/.
 * Import restrictions recognize static ESM/CommonJS forms. The file-error
 * vocabulary audit uses the TypeScript AST and imported bindings, so comments,
 * strings, unrelated objects, and renamed imports cannot create a false pass
 * or a blanket-substring false positive.
 *
 * Exposed as a library; the boundary check runs in `__tests__/boundary-imports.test.ts`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Violation {
  readonly file: string;
  readonly line: number;
  /** Imported module or source expression that crossed the boundary. */
  readonly importSpecifier: string;
  /** Human-readable boundary rationale and remediation guidance. */
  readonly reason: string;
}

export interface CheckResult {
  violations: Violation[];
}

// ---------------------------------------------------------------------------
// Rules — for each restricted directory, list the forbidden import patterns
// ---------------------------------------------------------------------------

interface BoundaryRule {
  /**
   * Files that the rule applies to. Each entry is a directory prefix, an exact
   * relative `.ts` path, or a single-`*` prefix/suffix pattern. Patterns keep
   * growing file families gated without stale per-file enumeration.
   */
  scope: string[];
  /**
   * Optional exact-path exclusions from `scope`. Use for files inside the
   * scoped directory that legitimately need the otherwise-forbidden imports
   * (e.g. `shared/defaults.ts` constructs the default observer/tracer
   * stubs — pulling in their concrete types is necessary, not a smell).
   */
  scopeExcludes?: string[];
  /** Module specifiers that are forbidden. Partial prefix match is used. */
  forbiddenModules: string[];
  /** Human-readable reason — surfaced in violation messages and lint output. */
  reason?: string;
}

const RULES: BoundaryRule[] = [
  {
    scope: ["state-machine"],
    forbiddenModules: ["bullmq", "ioredis", "queue-bullmq"],
    reason: "state-machine/ is the kernel; transport adapters belong outside it.",
  },
  {
    scope: ["dag-runtime"],
    forbiddenModules: ["bullmq", "ioredis", "queue-bullmq"],
    reason: "dag-runtime/ is transport-agnostic; durable backends are wired by the shell.",
  },
  {
    scope: [
      "state-machine",
      "dag-runtime",
    ],
    scopeExcludes: [
      // These are the imperative shell — they legitimately use OTel:
      "dag-runtime/executor.ts",
      "dag-runtime/run-dag-stateful.ts",
      "dag-runtime/run-telemetry.ts",
      "dag-runtime/node-span.ts",
      "dag-runtime/eval-judges.ts",
      "dag-runtime/freshness-emission.ts",
      "dag-runtime/human-emission.ts",
      "dag-runtime/route-emission.ts",
    ],
    forbiddenModules: ["@opentelemetry/"],
    reason: "Pure-core modules must not depend on OTel; tracing belongs to the imperative shell. Add new shell files to scopeExcludes.",
  },
  {
    scope: ["scheduler"],
    forbiddenModules: ["bullmq", "ioredis", "queue-bullmq"],
    reason:
      "scheduler/** must remain transport-agnostic — durable backends are wired by callers.",
  },
  // The file backend (`src/file/` + the `src/file.ts` subpath barrel) is a
  // zero-dependency durable-runtime port (FR-041/FR-042): it must never drag
  // broker/queue modules into its import graph (FR-043/SC-006). Relative
  // specifiers are matched by RESOLVING them against the importing file's
  // directory and testing the resolved path's segments (see
  // `isForbiddenSpecifier`) — `../queue-bullmq/...` from `file/` and
  // `./queue-bullmq/...` from the `file.ts` barrel resolve to a path whose
  // segments contain `queue-bullmq`, and the resolution covers ANY number of
  // `../` hops, so depth-N relative imports cannot bypass the bare-name ban.
  // Hard-fail gate via `__tests__/boundary-imports.test.ts`; a stray broker
  // import blocks immediately. The single-wildcard test pattern covers every
  // current and future `file-*.test.ts`, avoiding an enumeration that silently
  // falls behind as backend surfaces grow.
  {
    scope: [
      "file",
      "file.ts",
      "__tests__/file-*.test.ts",
    ],
    forbiddenModules: [
      "bullmq",
      "ioredis",
      "queue-bullmq",
    ],
    reason:
      "file/ and src/file.ts are the zero-dependency filesystem backend — broker imports are forbidden (FR-041/FR-043), bare or relative at any depth.",
  },
  // The executor/ ↔ dag-runtime/ cycle is broken: shared utilities live in
  // shared/; executor/ wraps dag-runtime/ as the public API layer. The reverse
  // direction (dag-runtime → executor) would re-introduce the cycle and is
  // forbidden.
  {
    scope: ["dag-runtime"],
    forbiddenModules: ["../executor"],
    reason:
      "dag-runtime/** must not import from executor/** — executor wraps dag-runtime, not the other way. Use shared/ for pure utilities consumed by both.",
  },
  // `types/` is the pure domain-type layer. It must not reach into runtime
  // modules (dag-runtime, shared, executor) — only other types/ files.
  {
    scope: ["types"],
    scopeExcludes: [
      // The barrel re-exports `computeJsonPatch` from shared/ as part of the
      // public API surface. The function is pure (no side effects) and lives
      // in shared/ for historical reasons.
      "types/index.ts",
    ],
    forbiddenModules: ["../dag-runtime", "../shared", "../executor"],
    reason:
      "types/** is the pure type layer — must not import runtime or utility modules. Move logic to dag-runtime/ or shared/ instead.",
  },
  // `shared/` must stay free of telemetry concerns: the modules that used to
  // mint spans (`shared/run-node.ts`, `shared/node-span.ts`) moved into
  // `dag-runtime/` during pass 3. Anything in `shared/` is consumed by both
  // the executor and the dag-runtime — pulling OTel or observer/tracing
  // plumbing in here would re-introduce the cycle the move was meant to break.
  // (2026-08: `shared/make-node-context.ts` once needed an exclusion for its
  // `./defaults.js` wiring; it now imports `../types/` only and triggers no
  // rule, so no scopeExcludes entry is required.)
  {
    scope: ["shared"],
    forbiddenModules: [
      "@opentelemetry/",
      "../observer",
      "../tracing",
    ],
    reason:
      "shared/** must not import OTel, observer/**, or tracing/**. Telemetry-aware helpers belong in dag-runtime/ (the only consumer). NoopObserver now lives in types/observer.ts so shared/ no longer needs the exemption.",
  },
  // `types/index.ts` alone: the barrel re-exports `computeJsonPatch` from
  // shared/ as part of the public API surface, so it keeps its own narrower
  // rule (may import `../shared`; must not `../dag-runtime`/`../executor`).
  // Every OTHER types/ file is governed by the full rule above — one rule per
  // file, so a violation is reported exactly once.
  {
    scope: ["types/index.ts"],
    forbiddenModules: ["../dag-runtime", "../executor"],
    reason:
      "types/index.ts is a lower layer; it must not import from dag-runtime/ or executor/. Pure utilities belong in shared/.",
  },
  // Anti-leak: the public main-barrel files and intermediate barrels in
  // cache/ and checkpoint/ must not pull `ioredis` into their import graph.
  // The Redis adapter files themselves are exempt; only the `/redis` and
  // `/bullmq` subpath barrels are permitted entry points.
  {
    scope: ["index.ts", "advanced.ts", "testing.ts", "cache", "checkpoint"],
    scopeExcludes: [
      "cache/redis-cache.ts",
      "checkpoint/redis-checkpointer.ts",
      "checkpoint/redis-freshness-index.ts",
    ],
    forbiddenModules: ["ioredis"],
    reason:
      "ioredis is reachable only from the `/redis` and `/bullmq` subpath barrels. The main barrel and intermediate cache/, checkpoint/ barrels must stay Redis-free so default-bundle consumers do not pay for it.",
  },
];

/** Production file-backend scope governed by FR-041's exact Node built-in allow-list. */
const FILE_BACKEND_SCOPE = ["file", "file.ts"] as const;
const FILE_IMPLEMENTATION_SCOPE = ["file"] as const;
const FILE_CACHE_ERROR_BRIDGE = "file/boundary-error.ts";
const FILE_BACKEND_NODE_BUILTINS = ["node:fs", "node:crypto", "node:path"] as const;
const NODE_SCHEME = "node:";

/**
 * Node exposes the authoritative built-in inventory through `node:module`.
 * Normalize that inventory to scheme-free names so canonical (`node:fs`) and
 * legacy bare (`fs`) spellings, including real subpaths such as
 * `fs/promises`, are classified as the same capability before policy is
 * applied. A `node:` spelling is still treated as a built-in namespace even
 * when the running Node/Bun version does not yet list that particular module,
 * so a newly added built-in cannot bypass the deny-by-default rule.
 */
const NODE_BUILTIN_NAMES = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith(NODE_SCHEME) ? specifier.slice(NODE_SCHEME.length) : specifier
  ),
);

interface NormalizedNodeBuiltin {
  readonly canonical: string;
  readonly usesCanonicalSpelling: boolean;
}

const normalizeNodeBuiltin = (specifier: string): NormalizedNodeBuiltin | null => {
  const usesCanonicalSpelling = specifier.startsWith(NODE_SCHEME);
  const bareName = usesCanonicalSpelling
    ? specifier.slice(NODE_SCHEME.length)
    : specifier;
  if (!usesCanonicalSpelling && !NODE_BUILTIN_NAMES.has(bareName)) return null;
  return { canonical: `${NODE_SCHEME}${bareName}`, usesCanonicalSpelling };
};

/**
 * FR-041 policy decision: allowed built-ins MUST use canonical `node:`
 * spelling. Bare `fs`/`crypto`/`path` are rejected with a direct replacement;
 * all other built-ins and every built-in subpath are rejected in either
 * spelling. This avoids environment-dependent package-vs-core resolution and
 * makes the source-level allow-list exact and auditable.
 */
const fileNodeBuiltinReason = (
  specifier: string,
  builtin: NormalizedNodeBuiltin,
): string => {
  const allowList = FILE_BACKEND_NODE_BUILTINS.join(", ");
  const canonicalIsAllowed = FILE_BACKEND_NODE_BUILTINS.includes(
    builtin.canonical as (typeof FILE_BACKEND_NODE_BUILTINS)[number],
  );

  if (!builtin.usesCanonicalSpelling && canonicalIsAllowed) {
    return `FR-041 requires canonical Node built-in spelling in file/ and src/file.ts; replace "${specifier}" with "${builtin.canonical}". Only the exact canonical specifiers ${allowList} are allowed.`;
  }

  const normalized = builtin.canonical === specifier
    ? ""
    : ` (normalized as "${builtin.canonical}")`;
  return `FR-041 forbids Node built-in "${specifier}"${normalized} in file/ and src/file.ts; only the exact canonical specifiers ${allowList} are allowed (built-in subpaths are not approved). Move that capability outside the dependency-free file backend or use an existing framework-relative port.`;
};

/** True when `relPath` matches a directory, exact file, or one-star pattern. */
function inScope(relPath: string, scope: readonly string[]): boolean {
  return scope.some((entry) => {
    const wildcard = entry.indexOf("*");
    if (wildcard !== -1) {
      // RULES are source constants. Fail closed for malformed multi-star
      // entries rather than granting a broader-than-reviewed match.
      if (entry.indexOf("*", wildcard + 1) !== -1) return false;
      return relPath.startsWith(entry.slice(0, wildcard)) &&
        relPath.endsWith(entry.slice(wildcard + 1));
    }
    if (entry.endsWith(".ts")) return relPath === entry;
    return relPath.startsWith(entry + "/");
  });
}

/** True when `relPath` is excluded from the rule via `scopeExcludes` (exact path). */
function isExcluded(relPath: string, excludes: readonly string[] | undefined): boolean {
  if (!excludes) return false;
  return excludes.some((entry) => relPath === entry);
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function walkTs(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...walkTs(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      result.push(full);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Import extraction — regex-based
// ---------------------------------------------------------------------------

// Matches:
//   import ... from "specifier"
//   import type ... from "specifier"
//   import("specifier")
//   import('specifier')
const IMPORT_RE =
  /(?:import\s+(?:type\s+)?[^'"]*from\s+|import\s*\()['"]([^'"]+)['"]/g;

// Matches the side-effect import form:
//   import "specifier"
//   import 'specifier'
// (no `from` clause — IMPORT_RE requires one, so `import "bullmq";` was
// silently invisible to the checker; a side-effect import still drags the
// module into the import graph, so it must be flagged like any other form.)
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;

// Matches:
//   export { Foo } from "specifier"
//   export type { Foo } from "specifier"
//   export * from "specifier"
//   export * as ns from "specifier"
const EXPORT_FROM_RE =
  /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

// Matches:
//   require("specifier")
//   require('specifier')
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImports(source: string): Array<{ specifier: string; line: number }> {
  const results: Array<{ specifier: string; line: number }> = [];

  function collectMatches(re: RegExp): void {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const specifier = match[1];
      const before = source.slice(0, match.index);
      const line = before.split("\n").length;
      results.push({ specifier, line });
    }
  }

  collectMatches(IMPORT_RE);
  collectMatches(SIDE_EFFECT_IMPORT_RE);
  collectMatches(EXPORT_FROM_RE);
  collectMatches(REQUIRE_RE);

  return results;
}

// ---------------------------------------------------------------------------
// File cache-error vocabulary audit — AST + imported-binding aware
// ---------------------------------------------------------------------------

interface FrameworkErrorImports {
  readonly namedBindings: ReadonlySet<string>;
  readonly namespaceBindings: ReadonlySet<string>;
}

/**
 * Record local names that can denote the public `frameworkError` value.
 * Named imports are followed through aliases; namespace imports are retained
 * so `errors.frameworkError.cacheError(...)` is covered too. The call audit
 * deliberately starts from imports rather than text, avoiding false positives
 * for comments, string literals, and unrelated local objects.
 */
const frameworkErrorImports = (sourceFile: ts.SourceFile): FrameworkErrorImports => {
  const namedBindings = new Set<string>();
  const namespaceBindings = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;

    if (ts.isNamespaceImport(bindings)) {
      namespaceBindings.add(bindings.name.text);
      continue;
    }

    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === "frameworkError") namedBindings.add(element.name.text);
    }
  }

  return { namedBindings, namespaceBindings };
};

/** Strip syntax-only wrappers without changing the expression being audited. */
const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

interface StaticMember {
  readonly owner: ts.Expression;
  readonly name: string;
}

/** Read dot or literal-bracket access (`x.y` / `x["y"]`) uniformly. */
const staticMember = (expression: ts.Expression): StaticMember | null => {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return { owner: unwrapExpression(unwrapped.expression), name: unwrapped.name.text };
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const argument = unwrapped.argumentExpression;
    if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return { owner: unwrapExpression(unwrapped.expression), name: argument.text };
    }
  }
  return null;
};

const isImportedFrameworkError = (
  expression: ts.Expression,
  imports: FrameworkErrorImports,
): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return imports.namedBindings.has(unwrapped.text);

  const member = staticMember(unwrapped);
  return member !== null &&
    member.name === "frameworkError" &&
    ts.isIdentifier(member.owner) &&
    imports.namespaceBindings.has(member.owner.text);
};

/**
 * Find direct calls to the public, string-typed cache-error constructor in a
 * file-backend implementation. `file/boundary-error.ts` is intentionally the
 * only excluded production definition: tests live outside file/** and remain
 * free to prove the public factory's compatibility contract.
 *
 * Coverage is import-derived, not textual: it catches the member call
 * (`frameworkError.cacheError(…)` / `ns.frameworkError.cacheError(…)`) and
 * the DESTRUCTURED local bindings that alias the same factory —
 * `const { cacheError } = frameworkError; cacheError(…)` and
 * `const cacheError = frameworkError.cacheError;` — which would otherwise be
 * bare-identifier calls the member audit cannot attribute.
 */
const findFileCacheErrorBypasses = (
  source: string,
  relPath: string,
): readonly Violation[] => {
  if (!inScope(relPath, FILE_IMPLEMENTATION_SCOPE) || relPath === FILE_CACHE_ERROR_BRIDGE) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    relPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = frameworkErrorImports(sourceFile);
  if (imports.namedBindings.size === 0 && imports.namespaceBindings.size === 0) return [];

  // Collect local bindings whose initializer derives from the imported
  // `frameworkError` value (destructured element or direct member ref): a
  // call through one of them is a call through the public factory.
  const localCacheErrorBindings = new Set<string>();
  const collectLocalCacheErrorBindings = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      const member = staticMember(unwrapExpression(node.initializer));
      if (
        member !== null &&
        member.name === "cacheError" &&
        isImportedFrameworkError(member.owner, imports)
      ) {
        localCacheErrorBindings.add(node.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const initial = unwrapExpression(node.initializer);
      // A named `frameworkError` import is the factory value itself; a
      // namespace import of the module exposes `cacheError` as a direct
      // member — both are destructurable into the same factory.
      const isFactoryValue =
        ts.isIdentifier(initial) &&
        (imports.namedBindings.has(initial.text) ||
          imports.namespaceBindings.has(initial.text));
      if (isFactoryValue) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name) && element.name.text === "cacheError") {
            localCacheErrorBindings.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collectLocalCacheErrorBindings);
  };
  collectLocalCacheErrorBindings(sourceFile);

  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const called = unwrapExpression(node.expression);
      if (ts.isIdentifier(called) && localCacheErrorBindings.has(called.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          file: relPath,
          line: line + 1,
          importSpecifier: "frameworkError.cacheError (destructured local binding)",
          reason:
            "file/** must construct cache failures through fileCacheError/fileOperationError from ./boundary-error.js so operation names remain inside the closed FileOperation vocabulary; a local binding derived from the imported frameworkError reaches the same public string-typed factory — only file/boundary-error.ts may bridge it.",
        });
      }
      const calledMember = staticMember(node.expression);
      if (
        calledMember !== null &&
        calledMember.name === "cacheError" &&
        isImportedFrameworkError(calledMember.owner, imports)
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          file: relPath,
          line: line + 1,
          importSpecifier: "frameworkError.cacheError",
          reason:
            "file/** must construct cache failures through fileCacheError/fileOperationError from ./boundary-error.js so operation names remain inside the closed FileOperation vocabulary; only file/boundary-error.ts may bridge to the public string-typed frameworkError.cacheError factory.",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

// ---------------------------------------------------------------------------
// Forbidden-specifier matching
// ---------------------------------------------------------------------------

/**
 * True when `specifier` (as written in `relPath`, relative to `srcDir`) is
 * forbidden by the rule's `forbiddenModules`:
 *
 * - Bare/absolute specifiers keep the legacy match: trailing-slash entries
 *   are namespace prefixes (`@opentelemetry/`), bare entries match exact +
 *   child (`bullmq`, `bullmq/whatever`).
 * - RELATIVE specifiers (`./…`, `../…`) are RESOLVED against the importing
 *   file's directory, and the RESOLVED path's segments are tested for a
 *   forbidden module segment. Enumerating one-level prefixes (`"../bullmq"`)
 *   was a bypass: `file/sub/x.ts` importing `../../queue-bullmq/adapter.js`
 *   matched no literal prefix and slipped through with 0 violations. Resolution
 *   is depth-independent — any number of `../` hops collapses into the real
 *   target path, so a forbidden module can never be reached by adding hops.
 *   The resolved path escapes `srcDir` only via leading `..` segments, which
 *   normalize above `srcDir` and are still checked segment-by-segment (a src
 *   file reaching UP into a sibling package's directory is exactly the broker
 *   import this gate exists for).
 */
function isForbiddenSpecifier(
  specifier: string,
  relPath: string,
  forbiddenModules: readonly string[],
): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = normalize(join(dirname(relPath), specifier)).replaceAll("\\", "/");
    return forbiddenModules.some((mod) => {
      // The module's segment name: strip leading `../`/`./` hops and a
      // trailing namespace slash, so `"../queue-bullmq"` and `"queue-bullmq"`
      // both name the segment `queue-bullmq` to look for in the resolved path.
      const segment = mod.replace(/^(?:\.\.?\/)+/, "").replace(/\/$/, "");
      return resolved.split("/").includes(segment);
    });
  }
  return forbiddenModules.some(
    (mod) =>
      mod.endsWith("/")
        ? specifier === mod.slice(0, -1) || specifier.startsWith(mod)
        : specifier === mod || specifier.startsWith(mod + "/"),
  );
}

// ---------------------------------------------------------------------------
// Core check function
// ---------------------------------------------------------------------------

export function checkImports(srcDir: string): CheckResult {
  const allFiles = walkTs(srcDir);
  const violations: Violation[] = [];

  for (const file of allFiles) {
    const relPath = relative(srcDir, file);

    // Determine which rules apply to this file (in-scope and not explicitly excluded)
    const applicableRules = RULES.filter(
      (rule) => inScope(relPath, rule.scope) && !isExcluded(relPath, rule.scopeExcludes),
    );

    if (applicableRules.length === 0) continue;

    const source = readFileSync(file, "utf-8");
    const imports = extractImports(source);
    const isFileBackendSource = inScope(relPath, FILE_BACKEND_SCOPE);

    violations.push(...findFileCacheErrorBypasses(source, relPath));

    for (const { specifier, line } of imports) {
      const nodeBuiltin = isFileBackendSource
        ? normalizeNodeBuiltin(specifier)
        : null;
      if (
        nodeBuiltin !== null &&
        (!nodeBuiltin.usesCanonicalSpelling ||
          !FILE_BACKEND_NODE_BUILTINS.includes(
            nodeBuiltin.canonical as (typeof FILE_BACKEND_NODE_BUILTINS)[number],
          ))
      ) {
        violations.push({
          file: relPath,
          line,
          importSpecifier: specifier,
          reason: fileNodeBuiltinReason(specifier, nodeBuiltin),
        });
      }

      for (const rule of applicableRules) {
        if (isForbiddenSpecifier(specifier, relPath, rule.forbiddenModules)) {
          violations.push({
            file: relPath,
            line,
            importSpecifier: specifier,
            reason: rule.reason ?? `Import ${specifier} is forbidden by this module boundary.`,
          });
        }
      }
    }
  }

  return { violations };
}

