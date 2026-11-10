# ADR-0088: Runtime dependencies fflate and saxes; SheetJS, ExcelJS and JSZip become dev-only

## Status
Accepted

## Date
2026-11-10

## Context

`@fuguejs/xlsx` turns in-memory `.xlsx` bytes (from `documents.getContent`) into
Zod-validated rows. Until 0.6.0 it delegated the whole job to SheetJS (`xlsx`
0.18.5), which loads the entire workbook, every sheet and every cell object
before handing back a single row. On the direct-sales Brancheliste workbook that
full load peaks at about 570 MB inside the shared, multi-tenant fugue-host. The
same feature (spec `2026-11-09-host-memory-spikes`) replaces it with a streaming
reader: read the ZIP central directory, inflate the selected worksheet in
compressed slices, SAX-parse the XML, and fold rows one at a time. That design
needs two capabilities the package did not have as runtime dependencies: a
chunked DEFLATE inflater and an incremental XML parser.

The forces on that choice:

- **Determinism.** The row fold must behave the same on every run and runtime.
  The reader must be able to push a compressed slice and get inflated bytes back
  synchronously, so the fold stays a plain loop with explicit, cooperative yield
  points rather than an interleaving of async callbacks.
- **Runtime portability.** fugue runs on Bun. Native bindings and Node built-ins
  whose streaming semantics differ between Node and Bun are a liability.
- **Hostile input.** Workbooks can come from user uploads. The XML parser sits
  on an untrusted boundary: it must reject malformed XML and must not expand
  custom entities (billion-laughs). The inflater must let us enforce a per-entry
  size cap (zip-bomb guard).
- **Install footprint.** `exceljs` and `jszip` were listed under `dependencies`
  even though production code never needed them. They existed only to build test
  fixtures, yet every DAG image that installed `@fuguejs/xlsx` carried them and
  their transitive trees.
- **Keeping SheetJS as a reference.** The streaming reader must reproduce SheetJS
  cell semantics exactly (FR-030..FR-040). SheetJS is still the best oracle for
  that, but it must not leak back into the production path (FR-042).

## Options Considered

1. **fflate for inflate + saxes for XML (chosen)**
   - Pros: both are small, have zero dependencies and ship ESM with bundled
     types. fflate's `Inflate` is a synchronous push-based chunked inflater in
     pure JavaScript, with no native code, and it behaves the same on Bun and
     Node. saxes is a strict, well-formedness-checking SAX parser that is actively
     maintained. It expands only the five predefined entities and character
     references, so it is safe on hostile input. fflate also provides `zipSync`/`strToU8`
     for building small test archives.
   - Cons: two new third-party runtime dependencies to track for security
     advisories and upgrades. saxes reports qualified names, so the wrapper has
     to strip namespace prefixes (`x:`) to match SheetJS's `(?:\w+:)?` patterns.

2. **`node:zlib` streaming inflate**
   - Pros: no third-party dependency. Native speed.
   - Cons: Bun's compatibility layer for `node:zlib` streams is a moving target.
     The streaming API is asynchronous per chunk, which turns the deterministic
     fold into event-driven code and makes back-pressure and the size cap harder
     to reason about. `inflateRawSync` per slice does not keep inflater state
     across slices.

3. **`sax` (the original sax-js package)**
   - Pros: widely used and familiar. A similar SAX event model.
   - Cons: less strict than saxes (non-strict mode tolerates malformed input by
     default) and less actively maintained. saxes is its maintained, stricter
     successor, with types included.

4. **Hand-written XML tokenizer**
   - Pros: no dependency. Could be tuned exactly to the SpreadsheetML subset.
   - Cons: new, untested parsing code on a hostile-input boundary. Entity
     handling, CDATA, attribute quoting and encoding edge cases would all have to
     be re-derived and hardened. That is far more risk than one small dependency.

5. **Keep SheetJS (or the ExcelJS streaming reader) at runtime**
   - Pros: no new code path.
   - Cons: SheetJS full-load is the memory problem this feature exists to remove.
     The ExcelJS streaming reader is non-deterministically broken under Bun
     (shared global state, documented in the old `packages/xlsx/src/index.ts`
     header) and is heavy. Neither meets the budget.

## Decision

**`@fuguejs/xlsx` runtime `dependencies` are exactly `@fuguejs/framework`,
`fflate` (^0.8.2) and `saxes` (^6.0.0). `xlsx` (SheetJS 0.18.5), `exceljs` and
`jszip` are `devDependencies` only.**

Concretely (`packages/xlsx/package.json`, released as 0.6.0):

- `dependencies`: `@fuguejs/framework` (`workspace:*`), `fflate` `^0.8.2`,
  `saxes` `^6.0.0`. `zod` remains a peer dependency.
- `devDependencies`: `xlsx` `^0.18.5`, `exceljs` `^4.4.0`, `jszip` `^3.10.1`,
  alongside the existing test tooling.

Where each dependency is used:

- **fflate** is used in production code only in `packages/xlsx/src/zip.ts`. Tests
  (`stream-api.test.ts`, `zip.test.ts`, `cell-value.property.test.ts`) also import
  `strToU8` and `zipSync` from it to build small test archives. `zip.ts` reads the ZIP central
  directory over the in-memory bytes. `inflateSync` handles small parts (workbook,
  rels, styles, shared strings), and `Inflate` streams the selected worksheet in
  compressed slices. Both enforce `DEFAULT_MAX_ENTRY_BYTES` (512 MiB per entry),
  checked against the declared size and the cumulative inflated output. An
  oversized entry is a `ZipError` of kind `too-large`, not an exception.
- **saxes** is used in `packages/xlsx/src/xml.ts` only. Thin wrappers parse a small
  part to a value or provide an incremental `XmlFeed` for the sheet stream.
  Element names are reported as local names, and parse failures are `Result` values.
  `sheet-stream.ts`, `shared-strings.ts`, `styles.ts` and `workbook-parts.ts`
  consume these wrappers and never import saxes directly.
- **SheetJS** is a differential oracle only.
  `packages/xlsx/src/__tests__/support/sheetjs-oracle.ts` is the only non-test
  module that imports `xlsx`. `parity.test.ts` and `real-data.local.test.ts` do
  not import `xlsx`; they reach SheetJS through the oracle. The one test that
  imports `xlsx` directly is `cell-value.property.test.ts`.
- **ExcelJS and JSZip** are used only to build test fixtures:
  `packages/xlsx/src/__tests__/support/fixtures.ts` (both) and several test files
  (`stream-api.test.ts`, `end-to-end.test.ts`, `xlsx.test.ts`,
  `date-group-item.test.ts` and `parity.test.ts`). The memory benchmark
  (`packages/xlsx/bench/parse-memory.ts`) reaches them only through `fixtures.ts`,
  and `bench/` is not in the published `files`.

Enforcement: **INV-1** (`.claude/linter/rules/inv-1-no-sheetjs-runtime-import.json`)
is a checkable lint rule. It runs on every edit and fails closed. It rejects any
static, side-effect, dynamic or `require` import of `xlsx` from a `.ts`, `.tsx`, `.mts`
or `.cts` file, except files ending in `.test.ts` and `sheetjs-oracle.ts`. The
`files` field of the package excludes `src/__tests__`, so the oracle never
ships.

## Consequences

**Positive:**
- The production parse path no longer loads whole workbooks. Its memory is bounded
  by the shared-strings table plus one row. The synthetic Brancheliste parse stays
  within the 100 MB CI budget (`memory-budget.test.ts`), compared with about
  570 MB under SheetJS.
- The install footprint is smaller. Every DAG image that depends on
  `@fuguejs/xlsx` stops pulling in SheetJS, ExcelJS and JSZip and their
  transitive dependencies. The two new packages are zero-dependency.
- No native code and no Bun-sensitive Node built-ins on the parse path. The same
  behaviour runs on Bun and Node.
- Hostile-input posture improves. Strict XML with no custom entity expansion, plus
  a hard per-entry inflate cap, closes the billion-laughs and zip-bomb vectors on
  uploaded workbooks.
- SheetJS stays available as an exact behavioural reference. The parity suite and
  the opt-in real-data differential keep the new reader honest, and INV-1 makes
  a regression to a runtime SheetJS import impossible to land unnoticed.

**Negative:**
- Two third-party runtime dependencies now sit on a security-relevant boundary.
  Their advisories and major-version changes must be tracked. saxes 6.x and
  fflate 0.8.x are pinned by caret range, so a breaking upstream change requires
  a deliberate bump.
- fflate's pure-JS inflate is slower than native zlib. We accept the CPU cost in
  exchange for synchronous, deterministic, portable chunked inflate. Throughput
  was not the binding constraint, memory was.
- fugue now owns the SheetJS-compatibility layer (cell typing, number formats,
  shared strings, implicit addressing) that SheetJS used to provide. Divergence
  from SheetJS behaviour is caught only by what the differential suite and
  fixtures exercise.
- The SheetJS oracle is pinned at 0.18.5, the last npm-published SheetJS version.
  It receives no security fixes on npm. This is acceptable only because it is
  dev-only and confined by INV-1.
- INV-1 is a regex rule. An unusual import spelling it does not match (for
  example, building the specifier string at runtime) would evade it. The
  `package.json` dev-only placement is the second line of defence, because a
  production install would not resolve the module.
