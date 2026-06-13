# @fuguejs/xlsx

Pure workbook parsing for Fugue DAGs. `parseWorkbook` turns `.xlsx` bytes into
Zod-validated typed rows. It is a pure function (deterministic, no I/O) — fetching
the bytes is a [`documents`](../document-source) capability concern
([`@fuguejs/fs`](../adapter-fs), [`@fuguejs/ms-graph`](../adapter-ms-graph)); parsing
stays here so it is fixture-testable and provider-agnostic (ADR-0052).

- **AI/usage guide:** [`../document-source/docs/llm-document-source.md`](../document-source/docs/llm-document-source.md)

## Usage

```ts
import { z } from "zod";
import { parseWorkbook } from "@fuguejs/xlsx";

const RowSchema = z.object({ customerId: z.string(), revenue: z.coerce.number() });

// inside a createFetchNode `fetch`, after ctx.documents.getContent(ref):
const parsed = await parseWorkbook(bytes, RowSchema);
//    Promise<Result<{ rows: readonly { customerId: string; revenue: number }[] }, FrameworkError>>
```

## API

```ts
parseWorkbook<T>(
  bytes: Uint8Array,
  rowSchema: z.ZodType<T>,
  opts?: { sheet?: string | number; headerRow?: number },  // default: first sheet, header row 1
): Promise<Result<{ rows: readonly T[] }, FrameworkError>>

normalizeCell(value: unknown): string | number | boolean | Date | null  // exported for testing
```

- Rows are objects keyed by the header-row cells.
- Cells are normalised to primitives: formula → its result, rich text /
  hyperlink → text, error cells → `null`, dates kept as `Date`. Use
  `z.coerce.*` for columns stored as text. Fully-blank rows are skipped.

## Errors

| Situation | `FrameworkError` |
|---|---|
| Bytes are not a readable workbook | non-retriable `node-crash` |
| Requested worksheet absent | non-retriable `node-crash` |
| A row violates `rowSchema` | `validation` (message names the row) |

## Tests

Unit tests build `.xlsx` fixtures in memory (no committed binaries). An
end-to-end test reads a real file from disk through `@fuguejs/fs` and parses it,
proving the `getContent → parseWorkbook` path.
