# @fuguejs/xlsx

Streaming workbook parsing for Fugue DAGs. `parseWorkbook` turns `.xlsx` bytes
into Zod-validated typed rows; `openWorkbook` + `foldRows` stream a sheet row by
row without ever holding it in memory. Parsing does no I/O and is deterministic
within a process — fetching the bytes is a [`documents`](../document-source)
capability concern ([`@fuguejs/fs`](../adapter-fs),
[`@fuguejs/ms-graph`](../adapter-ms-graph)); parsing stays here so it is
fixture-testable and provider-agnostic (ADR-0052).

- **AI/usage guide:** [`../document-source/docs/llm-document-source.md`](../document-source/docs/llm-document-source.md)

## Usage

```ts
import { z } from "zod";
import { openWorkbook, foldRows, parseWorkbook } from "@fuguejs/xlsx";

const RowSchema = z.object({ customerId: z.string(), revenue: z.coerce.number() });

// inside a createFetchNode `fetch`, after ctx.documents.getContent(ref):
const parsed = await parseWorkbook(bytes, RowSchema);
//    Promise<Result<{ rows: readonly { customerId: string; revenue: number }[] }, FrameworkError>>

// Large sheets: fold the rows into what you need instead of collecting them.
const wb = openWorkbook(bytes);
if (wb.ok) {
  const total = await foldRows(wb.value, RowSchema, { sheet: "Data" }, 0, (sum, row) => sum + row.revenue);
  //    Promise<Result<number, FrameworkError>>
}
```

## API

```ts
parseWorkbook<T>(
  bytes: Uint8Array,
  rowSchema: z.ZodType<T>,
  opts?: { sheet?: string | number; headerRow?: number },  // default: first sheet, header row 1
): Promise<Result<{ rows: readonly T[] }, FrameworkError>>

openWorkbook(bytes: Uint8Array): Result<WorkbookHandle, FrameworkError>
// WorkbookHandle: opaque, immutable; `sheetNames: readonly string[]` in workbook order

foldRows<T, A>(
  workbook: WorkbookHandle,
  rowSchema: z.ZodType<T>,
  opts: { sheet?: string | number; headerRow?: number; yieldEveryBytes?: number },
  init: A,
  step: (acc: A, row: T, rowNumber: number) => A,          // rowNumber: 1-based worksheet row
): Promise<Result<A, FrameworkError>>

xlsxErrorRow(error: FrameworkError): number | null         // the row a `validation` error names
normalizeCell(value: unknown): string | number | boolean | Date | null  // exported for testing
```

- `parseWorkbook` is `openWorkbook` followed by a collecting `foldRows`.
- `openWorkbook` reads the ZIP directory and the workbook-level parts (workbook,
  rels, styles, shared strings) once. Every `foldRows` over the handle, on any
  sheet, reuses them.
- `foldRows` hands rows to `step` one at a time, in strictly ascending worksheet
  order, and stops at the first failing row. The accumulator belongs to that one
  call, so `step` may push into it instead of copying it.
- `foldRows` yields to the event loop after every `yieldEveryBytes` (default
  16 KiB) of compressed sheet input, so a long fold does not stall other work.
- Rows are objects keyed by the header-row cells. Blank header columns are
  skipped. Fully-blank rows, including rows of only error cells, are skipped.

## Streaming, with SheetJS semantics

The reader never materialises a sheet. The bytes are already in memory, so the
ZIP central directory gives random access: the workbook-level parts are inflated
first, then the selected sheet is inflated in 16 KiB compressed slices and fed
through a SAX parser into a row assembler. Each completed row is projected
through the header map, validated, and handed to the fold step. Peak memory is
the shared-strings table plus one row, not a cell map of the whole sheet.

Cell semantics are those of SheetJS 0.18.5
(`XLSX.read(buf, { type: "buffer", cellDates: true })`), the previous
implementation, and a differential test suite holds the reader to them:

- **Formulas** → their cached result; formulas are never evaluated.
- **Strings**: shared, inline and formula strings; rich-text runs concatenated,
  phonetic runs dropped, `_xHHHH_` escapes decoded. Hyperlink cells → their text.
- **Dates** are detected by number format (built-in ids and custom format codes,
  as SheetJS does) and become `Date`. Like SheetJS, the conversion uses the
  process's local time zone and honours `date1904`, so the same bytes read
  under a different `TZ` give `Date`s at different instants.
- **Booleans** → `boolean`; **error cells** (`#N/A`, `#REF!`, …) → `null`.
- **Row range** follows the sheet's `<dimension>` merged with the observed
  cells; rows and cells without an `r` attribute advance implicitly.

Use `z.coerce.*` for numeric or date columns stored as text.

SheetJS is only a development dependency, used as the oracle; it is never
imported at runtime.

## Errors

| Situation | `FrameworkError` |
|---|---|
| Bytes are not a readable workbook (not a ZIP, corrupt archive, missing or malformed parts, `.xlsb`) | non-retriable `node-crash` |
| A part would inflate past 512 MiB (zip-bomb guard) | non-retriable `node-crash` |
| Requested worksheet absent (by name or 1-based index) | non-retriable `node-crash` |
| Malformed or truncated sheet XML, rows out of order, unknown shared-string index, duplicate header | non-retriable `node-crash` |
| `foldRows` given a handle not from `openWorkbook`, or a non-positive `yieldEveryBytes` | non-retriable `node-crash` |
| A row violates `rowSchema` | `validation`, message `row <n>: …` (recover `n` with `xlsxErrorRow`) |

## Memory budget

Streaming a 25.6k-row master list (the shape of the direct-sales `Brancheliste.xlsx`)
must peak at or below **100 MB** of RSS for the parse. The previous SheetJS
full load peaked at about 570 MB on the same workbook.

`bench/parse-memory.ts` measures it. Each workbook is parsed in a fresh child
process that streams it with a counting fold (no row is retained). The budgeted
value is the peak RSS during the parse minus the process's RSS just before it,
with modules loaded and garbage collected. That baseline is reported but not
budgeted: it is mostly the `@fuguejs/framework` module graph (about 70 MB),
which a host has loaded long before any parse.

```bash
bun run bench:memory                     # synthetic Brancheliste (deterministic, 25.6k rows)
bun run bench:memory -- --json           # machine-readable report
FUGUE_REAL_DATA_DIR=/path/to/fugue-dags/data bun run bench:memory   # also the real Brancheliste.xlsx
```

It prints `brancheliste-parse (<workbook>): <n> MB / 100 MB OK` per workbook and
exits 1 on a breach (2 on bad arguments, a missing real workbook or a failed
parse). CI runs it on the synthetic workbook through
`src/__tests__/memory-budget.test.ts`; the real-data run is local only, because
the workbook is business data.

## Tests

Unit tests build `.xlsx` fixtures in memory (no committed binaries):

- Contract tests for `parseWorkbook`, `openWorkbook` and `foldRows`, plus
  property tests for the cell-value semantics and the ZIP reader.
- `parity.test.ts`: a differential against SheetJS on deterministic synthetic
  workbooks (the Brancheliste shape, nine other source shapes and an edge-case
  cell matrix), with `TZ` pinned.
- `real-data.local.test.ts`: the same differential on the real source workbooks.
  It runs only when `FUGUE_REAL_DATA_DIR` is set and is skipped in CI.
- `memory-budget.test.ts`: the 100 MB parse budget on the synthetic workbook.
- An end-to-end test reads a real file from disk through `@fuguejs/fs` and
  parses it, proving the `getContent → parseWorkbook` path.
