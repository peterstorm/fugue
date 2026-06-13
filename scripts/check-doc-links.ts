#!/usr/bin/env bun
// Doc-link checker for the *shipped* docs.
//
// Docs now ride along inside the published packages (see the docs-shipping plan:
// `@fuguejs/framework/docs`, `@fuguejs/host/docs`, `@fuguejs/document-source/docs`).
// A shipped doc that links to a path which won't exist in a consumer's
// `node_modules` is a broken promise — this script fails the build on two
// classes of error:
//
//   1. Dangling link — a relative `[text](path)` whose target doesn't exist.
//   2. Unshipped target — a link from a shipped doc that escapes the
//      `packages/` tree (e.g. into the monorepo-only `docs/` root). Those
//      resolve in the monorepo but 404 from an installed package.
//
// Relative paths resolve identically in the monorepo (`packages/<pkg>/docs/…`)
// and under `node_modules/@fuguejs/<pkg>/docs/…` because packages are siblings
// in both layouts — so a check that passes here passes for consumers too.
//
// Scope: only the shipped surface. Monorepo-internal docs (`docs/*.md`, plans,
// ADRs) are intentionally not checked — they may link wherever they like.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";

export type Problem = { file: string; target: string; reason: string };

/** Environment the pure checker needs — the `exists` predicate is the I/O seam. */
export interface DocLinkEnv {
  readonly packagesRoot: string;
  readonly shippedDocRoots: readonly string[];
  readonly exists: (absPath: string) => boolean;
}

// [text](target) — capture the target. Images are treated the same.
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

const isExternal = (target: string): boolean =>
  /^(https?:|mailto:|#|<|\$\{)/.test(target);

// Strip fenced and inline code so regexes/tokens like `foo](bar)` inside code
// spans aren't mistaken for markdown links.
const stripCode = (md: string): string =>
  md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

/**
 * Pure: find broken shipped-doc links in one already-read markdown file. Two
 * classes: a dangling relative target, and (for files under a shipped `docs/`
 * dir) a target that escapes the `packages/` tree and so would 404 from an
 * installed package. The `env.exists` seam keeps this testable without disk.
 */
export const findDocLinkProblems = (file: string, rawText: string, env: DocLinkEnv): Problem[] => {
  const text = stripCode(rawText);
  const fileDir = dirname(file);
  const problems: Problem[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    const raw = match[1]!.trim();
    if (isExternal(raw)) continue;
    // Strip a trailing #anchor (we only validate the file/dir target).
    const targetPath = raw.split("#")[0]!;
    if (targetPath === "") continue; // pure anchor
    const resolved = resolve(fileDir, targetPath);

    if (!env.exists(resolved)) {
      problems.push({ file, target: raw, reason: "dangling — target does not exist" });
      continue;
    }
    // A shipped doc must not link outside the packages/ tree, or it 404s once
    // installed. (READMEs may link into the monorepo `docs/adr/` etc.; only the
    // package `docs/` dirs carry the strict "shipped → shipped" rule.)
    const underShippedDocsDir = env.shippedDocRoots.some(
      (root) => file.startsWith(root + "/") || file === root,
    );
    if (underShippedDocsDir) {
      const rel = relative(env.packagesRoot, resolved);
      if (rel.startsWith("..")) {
        problems.push({
          file,
          target: raw,
          reason: "escapes packages/ — not shipped; would 404 from node_modules",
        });
      }
    }
    // Directory link targets are fine (e.g. ./examples/) — existence was
    // already verified above, so nothing more to check here.
  }
  return problems;
};

const repoRoot = resolve(import.meta.dir, "..");
const packagesRoot = resolve(repoRoot, "packages");

// The shipped doc surface: every package `docs/` dir, plus each package README
// (READMEs are published by default and link into the docs).
const shippedDocRoots = [
  "framework/docs",
  "host/docs",
  "document-source/docs",
].map((p) => resolve(packagesRoot, p));

const walkMarkdown = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
};

// `import.meta.main` is false when this module is imported by a test — only the
// real CLI run (bun scripts/check-doc-links.ts) executes the I/O shell below.
const runCli = (): void => {
  const shippedReadmes = readdirSync(packagesRoot)
    .map((pkg) => resolve(packagesRoot, pkg, "README.md"))
    .filter((p) => existsSync(p));
  const docFiles = [...shippedDocRoots.flatMap(walkMarkdown), ...shippedReadmes];
  const env: DocLinkEnv = { packagesRoot, shippedDocRoots, exists: existsSync };
  const problems: Problem[] = docFiles.flatMap((file) =>
    findDocLinkProblems(file, readFileSync(file, "utf8"), env),
  );
  report(problems, docFiles.length);
};

const report = (problems: readonly Problem[], checkedCount: number): void => {
  if (problems.length > 0) {
    console.error(`✗ ${problems.length} broken shipped-doc link(s):\n`);
    for (const p of problems) {
      console.error(`  ${relative(repoRoot, p.file)}`);
      console.error(`    → ${p.target}  (${p.reason})\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `✓ checked ${checkedCount} shipped doc file(s); all relative links resolve and stay shipped.\n`,
  );
};

if (import.meta.main) runCli();
