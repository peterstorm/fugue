/**
 * Normalise a cell value to a primitive (or `null`): primitives and `Date` pass
 * through, and ExcelJS-shaped objects (formula `{ formula, result }`, rich text
 * `{ richText }`, hyperlink `{ text, hyperlink }`, error `{ error }`) are
 * flattened. Error cells and unknown objects → `null`.
 *
 * A standalone, independently tested public helper. The streaming reader does
 * NOT use it (cells are decoded in `cell-value.ts`), so changing it never
 * changes what `parseWorkbook` or `foldRows` return. The SheetJS differential
 * oracle (`__tests__/support/sheetjs-oracle.ts`) shares this one definition
 * rather than keeping a second copy.
 */
export const normalizeCell = (value: unknown): string | number | boolean | Date | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((p) => p.text ?? "").join("");
    }
    if (typeof v.text === "string") return v.text; // hyperlink cell
    if ("result" in v) return normalizeCell(v.result); // formula → its computed result
    if ("error" in v) return null; // error cell (#REF!, #DIV/0!, …)
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
};
