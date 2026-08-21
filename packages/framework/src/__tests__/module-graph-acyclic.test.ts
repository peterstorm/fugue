/**
 * The framework's module graph must not grow new import cycles.
 *
 * A cycle means neither module can be read, tested, or reasoned about without
 * the other, so the layering it appears to have is not real. Every cycle found
 * in this package had the same shape: a single TYPE, declared inside one of two
 * modules that both needed it, pointing an edge backwards. The fix each time
 * was to move that type to a leaf — `witness.ts`, `post-wave-context.ts`,
 * `run-summary.ts`.
 *
 * Two cycles are KNOWN and allowed below, because breaking them is a modelling
 * decision rather than a misplacement (see the constant's comment).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// Resolve from this test module: `bun test packages/framework` runs at repo root.
const SRC = join(__dirname, "..");

/**
 * Cycles that are not misplacement and are deliberately not fixed here.
 *
 * `node -> errors`: `errors.ts` needs `Capability`, which is DERIVED from
 * `CapabilityRegistry`, whose own fields are the capability client types
 * (`LlmClient`, …) declared alongside `NodeContext`. Moving the registry to a
 * leaf relocates the cycle rather than removing it, and the registry is the
 * declaration-merging seam five adapter packages augment (ADR-0051), so it is
 * the last thing to move casually.
 *
 * `cli/authored -> cli/vocabulary`: `vocabulary.ts` deliberately applies
 * `satisfies FieldSpec` AT the definition site so a `FieldSpec` change is
 * flagged there rather than at a distant use — its own comment argues for this.
 */
const ALLOWED_CLUSTERS: readonly (readonly string[])[] = [
  // The capability/error cluster. `errors.ts` needs `Capability`, DERIVED from
  // `CapabilityRegistry`, whose fields are the capability client types declared
  // beside `NodeContext`. The entanglement runs through observer/events/
  // http-capability too, so this is one mutually-recursive cluster rather than
  // a misplaced type — and the registry is the declaration-merging seam five
  // adapter packages augment (ADR-0051).
  ["types/node.ts", "types/errors.ts", "types/observer.ts", "types/events.ts", "types/http-capability.ts"],
  // `vocabulary.ts` applies `satisfies FieldSpec` AT the definition site on
  // purpose, so a FieldSpec change is flagged there rather than at a distant
  // use. Its own comment argues for this.
  ["cli/authored.ts", "cli/vocabulary.ts"],
];

/** A cycle is known when every module in it belongs to one allowed cluster. */
const isKnown = (cycle: readonly string[]): boolean =>
  ALLOWED_CLUSTERS.some((cluster) => cycle.every((m) => cluster.includes(m)));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : tsFiles(path);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
  });
}

describe("framework module graph", () => {
  it("has no import cycles beyond the two known modelling ones", () => {
    const files = tsFiles(SRC);
    const set = new Set(files);
    const graph = new Map<string, string[]>();
    for (const f of files) {
      // Strip comments: an import specifier quoted inside prose is not an edge.
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const deps: string[] = [];
      for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const base = normalize(join(dirname(f), m[1]!)).replace(/\.js$/, "");
        for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
          if (set.has(cand)) { deps.push(cand); break; }
        }
      }
      graph.set(f, deps);
    }

    const rel = (p: string) => p.slice(SRC.length + 1);
    const found = new Set<string>();
    const state = new Map<string, number>();
    const stack: string[] = [];
    const walk = (n: string): void => {
      state.set(n, 1);
      stack.push(n);
      for (const d of graph.get(n) ?? []) {
        if (state.get(d) === 1) {
          const cycle = stack.slice(stack.indexOf(d)).map(rel);
          if (!isKnown(cycle)) found.add([...cycle, cycle[0]!].join(" -> "));
        } else if (!state.has(d)) walk(d);
      }
      stack.pop();
      state.set(n, 2);
    };
    for (const f of files) if (!state.has(f)) walk(f);

    expect([...found]).toEqual([]);
  });
});
