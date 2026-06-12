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

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const packagesRoot = resolve(repoRoot, "packages");

// The shipped doc surface: every package `docs/` dir, plus each package README
// (READMEs are published by default and link into the docs).
const shippedDocRoots = [
  "framework/docs",
  "host/docs",
  "document-source/docs",
].map((p) => resolve(packagesRoot, p));

const shippedReadmes = readdirSync(packagesRoot)
  .map((pkg) => resolve(packagesRoot, pkg, "README.md"))
  .filter((p) => existsSync(p));

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

const docFiles = [...shippedDocRoots.flatMap(walkMarkdown), ...shippedReadmes];

// [text](target) — capture the target. Ignore images? Treat them the same.
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

const isExternal = (target: string): boolean =>
  /^(https?:|mailto:|#|<|\$\{)/.test(target);

type Problem = { file: string; target: string; reason: string };
const problems: Problem[] = [];

// Strip fenced and inline code so regexes/tokens like `foo](bar)` inside code
// spans aren't mistaken for markdown links.
const stripCode = (md: string): string =>
  md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

for (const file of docFiles) {
  const text = stripCode(readFileSync(file, "utf8"));
  const fileDir = dirname(file);
  for (const match of text.matchAll(LINK_RE)) {
    const raw = match[1]!.trim();
    if (isExternal(raw)) continue;
    // Strip a trailing #anchor (we only validate the file/dir target).
    const targetPath = raw.split("#")[0]!;
    if (targetPath === "") continue; // pure anchor
    const resolved = resolve(fileDir, targetPath);

    if (!existsSync(resolved)) {
      problems.push({ file, target: raw, reason: "dangling — target does not exist" });
      continue;
    }
    // A shipped doc must not link outside the packages/ tree, or it 404s once
    // installed. (READMEs may link into the monorepo `docs/adr/` etc.; only the
    // package `docs/` dirs carry the strict "shipped → shipped" rule.)
    const underShippedDocsDir = shippedDocRoots.some((root) => file.startsWith(root + "/") || file === root);
    if (underShippedDocsDir) {
      const rel = relative(packagesRoot, resolved);
      if (rel.startsWith("..")) {
        problems.push({
          file,
          target: raw,
          reason: "escapes packages/ — not shipped; would 404 from node_modules",
        });
      }
    }
    // Directory link targets are fine (e.g. ./examples/).
    void statSync(resolved);
  }
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} broken shipped-doc link(s):\n`);
  for (const p of problems) {
    console.error(`  ${relative(repoRoot, p.file)}`);
    console.error(`    → ${p.target}  (${p.reason})\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `✓ checked ${docFiles.length} shipped doc file(s); all relative links resolve and stay shipped.\n`,
);
