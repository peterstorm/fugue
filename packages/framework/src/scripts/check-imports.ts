/**
 * Boundary-import checker (FR-082)
 *
 * Enforces:
 *   - state-machine/** MUST NOT import bullmq, ioredis, or queue-bullmq/**
 *   - dag-runtime/**   MUST NOT import bullmq, ioredis, or queue-bullmq/**
 *   - Only queue-bullmq/** may import bullmq and ioredis
 *
 * Scans all .ts files (excluding .d.ts) under packages/framework/src/.
 * Detects `import`, `import type`, and dynamic `import(...)` forms.
 *
 * Exposed as a library; the boundary check runs in `__tests__/boundary-imports.test.ts`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  line: number;
  importSpecifier: string;
}

export interface CheckResult {
  violations: Violation[];
}

// ---------------------------------------------------------------------------
// Rules — for each restricted directory, list the forbidden import patterns
// ---------------------------------------------------------------------------

interface BoundaryRule {
  /**
   * Files that the rule applies to. Each entry is either a directory prefix
   * (interpreted as `${entry}/`) or a specific relative file path under `src/`.
   */
  scope: string[];
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
      "dag-runtime/transition.ts",
      "dag-runtime/transition-helpers.ts",
      "dag-runtime/machine.ts",
    ],
    forbiddenModules: ["@opentelemetry/"],
    reason: "Pure-core modules must not depend on OTel; tracing belongs to the imperative shell.",
  },
  {
    scope: ["scheduler"],
    forbiddenModules: ["bullmq", "ioredis", "queue-bullmq"],
    reason:
      "scheduler/** must remain transport-agnostic — durable backends are wired by callers.",
  },
];

/** True when `relPath` matches a `scope` entry (either dir prefix or exact file). */
function inScope(relPath: string, scope: readonly string[]): boolean {
  return scope.some((entry) => {
    if (entry.endsWith(".ts")) return relPath === entry;
    return relPath.startsWith(entry + "/");
  });
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
  collectMatches(EXPORT_FROM_RE);
  collectMatches(REQUIRE_RE);

  return results;
}

// ---------------------------------------------------------------------------
// Core check function
// ---------------------------------------------------------------------------

export function checkImports(srcDir: string): CheckResult {
  const allFiles = walkTs(srcDir);
  const violations: Violation[] = [];

  for (const file of allFiles) {
    const relPath = relative(srcDir, file);

    // Determine which rules apply to this file
    const applicableRules = RULES.filter((rule) => inScope(relPath, rule.scope));

    if (applicableRules.length === 0) continue;

    const source = readFileSync(file, "utf-8");
    const imports = extractImports(source);

    for (const { specifier, line } of imports) {
      for (const rule of applicableRules) {
        const isForbidden = rule.forbiddenModules.some(
          (mod) =>
            // Trailing-slash entries are interpreted as namespace prefixes
            // (e.g., `@opentelemetry/`); bare entries match exact + child.
            mod.endsWith("/")
              ? specifier === mod.slice(0, -1) || specifier.startsWith(mod)
              : specifier === mod || specifier.startsWith(mod + "/"),
        );
        if (isForbidden) {
          violations.push({ file: relPath, line, importSpecifier: specifier });
        }
      }
    }
  }

  return { violations };
}

