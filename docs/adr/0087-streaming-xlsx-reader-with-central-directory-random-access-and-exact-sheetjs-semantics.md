# ADR-0087: Streaming xlsx reader with central-directory random access and exact SheetJS semantics

## Status
Accepted

## Context

`@fuguejs/xlsx` (ADR-0052) turns `.xlsx` bytes, fetched through the `documents`
capability, into Zod-validated rows. Until now it called SheetJS 0.18.5
(`XLSX.read(buf, { type: "buffer", cellDates: true })`), which loads the whole
workbook into a full cell map before a single row is projected. On the
direct-sales Brancheliste export (25k rows, about 2.1 MB compressed) that full
load peaked at about 570 MB. fugue-host is a shared, multi-tenant process. Each
time the lead-scoring or lead-opener DAG re-read its ten workbooks, the host's
memory spiked, putting other tenants at risk. The spec sets a parse budget of
at most 100 MB for Brancheliste.

Several forces constrain the fix:

- **Bytes are already resident.** `getContent` returns the whole workbook as a
  `Uint8Array`. The problem is the decompressed, materialised sheet, not the
  input.
- **Part order inside the archive is not fixed.** A sheet's cells reference
  `sharedStrings.xml` and `styles.xml`, which are needed to decode them. Writers
  may place those parts after the sheet in the archive.
- **Behaviour must not change.** Existing callers depend on SheetJS cell
  semantics, including its quirks: dates detected by number format, `Date`s
  built in the local time zone, the 1900 leap-year bug, `date1904`, rich text,
  `_xHHHH_` escapes, error cells and the dimension-merged row range. The
  `parseWorkbook` signature, `Result` shape, error kinds, retriability and
  messages are a published contract (FR-030 to FR-037). Spec AS-009 requires
  exact parity with SheetJS on every fixture.
- **Recomputes run beside live traffic.** The new lead snapshot (AD-1) rebuilds
  in the background while requests are still served from the old one. A long
  synchronous parse would stall the event loop for those requests.
- **Several sheets, one file.** Scoringsmodel reads a weights sheet and a
  scaling sheet from one download (FR-022, AS-016). That should not mean paying
  for the workbook-level parts twice.
- **Runtime health.** ExcelJS has shared global state and breaks
  non-deterministically under Bun. SheetJS, ExcelJS and JSZip are heavy runtime
  dependencies of every DAG image that installs `@fuguejs/xlsx`.

## Options Considered

1. **Streaming reader with ZIP central-directory random access (chosen)**
   - Pros: Peak memory is bounded to the shared-strings table plus one row, not
     the whole sheet. Random access through the central directory is free
     because the bytes are already in memory. It removes the part-ordering
     problem: workbook, rels, styles and shared strings are inflated first,
     whatever their archive position. Only the decompressed sheet XML is
     streamed. It has small, dependency-free building blocks (fflate, saxes).
     Inflating in slices gives natural points to yield to the event loop.
   - Cons: Re-implements SheetJS cell semantics (`numdate`, `SSF.is_date`,
     `parse_ws_xml` range logic, `_xHHHH_` decoding). That is real code to own
     and keep correct, and it needs a differential test against SheetJS. The
     2.1 MB compressed input stays resident for the whole fold.

2. **Forward-only streaming unzip (fflate `Unzip`) feeding a SAX parser**
   - Pros: Never needs the whole archive. It is the textbook streaming design.
   - Cons: The input is already fully in memory, so it saves nothing on that
     side. When `sharedStrings.xml` or `styles.xml` follows the sheet in the
     archive, the sheet XML must be buffered until they arrive, which defeats
     the purpose. The worst case is the same as today.

3. **ExcelJS streaming reader**
   - Pros: A ready-made streaming API, so less code to own.
   - Cons: It is non-deterministically broken under Bun because of shared
     global state (documented in the old `packages/xlsx/src/index.ts` header).
     It is heavy. Its cell semantics differ from SheetJS, so parity (AS-009)
     would need adapting either way.

4. **SheetJS with lean options (`dense`, no `cellNF` or `cellText`)**
   - Pros: Smallest change. Parity holds by construction.
   - Cons: It still materialises the whole sheet and misses the 100 MB parse
     budget. It keeps SheetJS as a runtime dependency.

5. **Expose rows as an `AsyncIterable` instead of a fold**
   - Pros: A familiar consumer shape that composes with `for await`.
   - Cons: Consumer abandonment (`break`, a thrown error) needs a cleanup path
     through `return()`. Backpressure and accumulation are split across the
     producer and the consumer. A fold keeps both inside one call, has no
     abandonment path, and takes pure step functions directly.

## Decision

**`@fuguejs/xlsx` reads the in-memory workbook through the ZIP central
directory, inflates the workbook-level parts eagerly, streams only the selected
sheet's XML through a SAX row assembler into a fold, and reproduces SheetJS
0.18.5 cell semantics exactly, with a differential test against SheetJS.**

### Load sequence

1. `readZip` (`packages/xlsx/src/zip.ts`) parses the central directory of the
   resident `Uint8Array`. It never forward-scans the archive.
2. `openWorkbook` (`packages/xlsx/src/index.ts`) inflates, in any archive order,
   these parts: `[Content_Types].xml`, `workbook.xml`, `workbook.xml.rels`,
   `styles.xml` and `sharedStrings.xml`. It parses them with
   `workbook-parts.ts`, `styles.ts` and `shared-strings.ts`. Sheets resolve
   through the rels in `<sheets>` order.
3. `foldRows` streams the selected sheet. `inflateSlices` passes compressed
   slices to fflate `Inflate`, then to `TextDecoder` (stream mode), then to
   saxes (`xml.ts`), then to the row assembler (`sheet-stream.ts`). Each
   completed row is projected through the header map, validated with Zod and
   handed to the fold step (`rows.ts`).
4. Each inflated entry is capped at 512 MiB (`DEFAULT_MAX_ENTRY_BYTES`) as a
   zip-bomb guard.

### Public surface (`packages/xlsx/src/index.ts`)

- `openWorkbook(bytes): Result<WorkbookHandle, FrameworkError>` does the
  one-time load. `WorkbookHandle` is branded, frozen and opaque. It exposes only
  `sheetNames`, and its loaded parts live in a module-private `WeakMap` that is
  written once per handle. Shared strings and styles are loaded once per handle,
  so several sheets cost one load (FR-022, FR-040, AS-016).
- `foldRows(handle, schema, opts, init, step): Promise<Result<A, FrameworkError>>`
  is the row-streaming form (FR-039). It is async and cooperative: it yields to
  the event loop with `await new Promise(r => setImmediate(r))` (a macrotask,
  not a timer) after every `yieldEveryBytes` of compressed input. The fold stops
  at the first failing row. The accumulator belongs to the call, so `step` may
  push into it.
- `parseWorkbook(bytes, schema, opts)` is `openWorkbook` followed by a
  collecting `foldRows`. Its signature, `Result` shape, error kinds,
  retriability and messages are unchanged (FR-030 to FR-037).
- `xlsxErrorRow(e)` recovers `<n>` from a `row <n>: <zod message>` validation
  error minted by this module.

### Frozen SheetJS 0.18.5 semantics (`cell-value.ts`, `styles.ts`, `sheet-stream.ts`, `rows.ts`)

- **Dates.** A cell is a date when its number format is one of the built-in ids
  14–22, 27–36, 45–47 or 50–58, or a custom format string that passes a port of
  `SSF.is_date`. Serial-to-`Date` conversion ports `numdate`. It uses the local
  time zone, keeps the 1900 leap-year bug for serials ≤ 60, and honours
  `workbookPr date1904`.
- **Strings.** Shared strings, inline strings (`t="inlineStr"`) and formula
  strings (`t="str"`) are supported. Rich-text runs are concatenated, phonetic
  `rPh` runs are excluded, and `_xHHHH_` escapes are decoded.
- **Other cell types.** Booleans (`t="b"`) are supported. Error cells (`t="e"`)
  become `null`. Formula cells use their cached `<v>` and are never evaluated.
- **Row range.** `<dimension ref>` is merged with the observed cells as
  `parse_ws_xml` does. Rows and cells with no `r` attribute advance implicitly.
- **Sheet selection.** By exact name, or by 1-based index in `workbook.xml`
  `<sheets>` order, resolved through the rels.
- **Rows.** Row objects are prototype-free. Blank header columns are skipped. A
  duplicate non-blank header is a `node-crash`. All-empty and all-error rows are
  skipped.

### Errors

Every failure is a non-retriable `node-crash`, except a row that fails the
schema, which is a `validation` error. Crash cases include: unreadable bytes,
`.xlsb`, a missing or unreadable sheet, malformed or truncated XML, an entry
over the cap, rows out of ascending order, a shared-string index out of range,
a duplicate header, a foreign handle, and an invalid `yieldEveryBytes`.

### Enforcement

- `packages/xlsx/src/__tests__/parity.test.ts` runs the new reader against the
  SheetJS oracle (`__tests__/support/sheetjs-oracle.ts`) on deterministic
  synthetic fixtures (`__tests__/support/fixtures.ts`). It runs in-process, then
  again in child processes with `TZ` pinned before module load (AS-009, AS-014,
  AS-017). `real-data.local.test.ts` is an opt-in run of the same comparison on
  real workbooks.
- `packages/xlsx/src/__tests__/memory-budget.test.ts` spawns
  `packages/xlsx/bench/parse-memory.ts` on a synthetic Brancheliste. In CI it
  asserts that the parse's peak RSS above the loaded-modules baseline is at
  most 100 MB (AS-015). The baseline is the child process's RSS after module
  load and a full GC, just before the parse. It is reported but not budgeted,
  so the budget is not an absolute process-RSS ceiling. The peak is the
  kernel's lifetime peak when the parse raised it. Otherwise it is the highest
  sample from a worker thread that polls RSS every 1 ms through `openWorkbook`
  and the fold.
- INV-1 is a lint rule. It forbids any runtime import of SheetJS. Only
  `*.test.ts` files and `sheetjs-oracle.ts` may import it. Runtime dependencies
  are `@fuguejs/framework`, `fflate` and `saxes`. `xlsx`, `exceljs` and `jszip`
  are devDependencies (AD-3).

### Recorded deviation from the plan

The plan named a 64 KiB yield cadence. The shipped default
(`DEFAULT_YIELD_EVERY_BYTES`) is 16 KiB, and the inflate slice
(`SLICE_BYTES`) is also 16 KiB. Each yield is also a chance for the garbage
collector to run. On one real 25k-row export, measured once, the 16 KiB
settings peaked about 13 MB lower for the yield and about 20 MB lower for the
slice. The cost was about 100 extra macrotask hops. Callers can override the
cadence with `yieldEveryBytes`.

## Consequences

**Positive:**
- Peak parse memory is bounded to the shared-strings table plus one row,
  instead of a full cell map. This is enforced by a CI budget of 100 MB above
  the loaded-modules baseline. The SheetJS full load peaked at about 570 MB.
- Existing `parseWorkbook` callers see no behaviour change. SheetJS parity is a
  tested property, not a hope.
- One `openWorkbook` serves many sheets. Scoringsmodel downloads and loads once.
- A running recompute yields to the event loop regularly, so requests served
  from the old snapshot are not stalled.
- `foldRows` lets consumers such as the Brancheliste scoring pipeline fold
  straight into their result without collecting an intermediate row array.
- SheetJS, ExcelJS and JSZip leave the runtime dependency graph. DAG images get
  lighter, and the Bun-hostile ExcelJS is gone from production.

**Negative:**
- fugue now owns a port of SheetJS internals: `numdate`, `SSF.is_date`, the
  `parse_ws_xml` range rules and string decoding. Any change risks drift. The
  differential suite is the only safeguard, and it covers only what the
  fixtures exercise.
- Parity is deliberately bug-compatible. Dates depend on the process `TZ`, and
  the 1900 leap-year bug is kept. The same bytes give different instants under
  different time zones. This is safe only because production containers run in
  UTC and the tests pin `TZ`.
- The whole compressed input and the full shared-strings table stay resident
  for the life of a handle. A workbook with a huge shared-strings table can
  still be large. The bound holds per row, not overall.
- Rows must arrive in ascending order. A streaming fold cannot revisit a row it
  has already stepped, so a cell that addresses an already-emitted row is a
  `node-crash`. It is never a silently different result. SheetJS, which
  materialises the sheet, has no such constraint. This edge is accepted because
  real exports write rows in order.
- A fold is less familiar than an async iterator. A fold stops early only past
  the sheet's dimension bound or on the first failure. Consumers have no
  `break`, so a caller that wants less must filter in the step.
- The 16 KiB yield and slice sizes rest on a single measurement. Other
  workbooks may favour different values.
