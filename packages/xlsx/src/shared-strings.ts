/**
 * Shared strings (`xl/sharedStrings.xml`) and the rich-text reader shared with
 * inline strings (`<is>`), both following SheetJS 0.18.5 `parse_si`:
 *
 * - When the first child is `<t>`, the value is that element's text.
 * - Otherwise, when there are `<r>` runs, the value is every `<t>` text joined,
 *   excluding phonetic `<rPh>` runs.
 * - `_xHHHH_` escapes are decoded in the result.
 * - Anything else is `null` (SheetJS yields `undefined` there), except empty
 *   content, which is `""`.
 *
 * Parsing runs once per workbook load; the table is the reader's only
 * workbook-sized allocation.
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import { decodeXmlEscapes } from "./cell-value.js";
import { parseXml, type XmlAttrs, type XmlHandler } from "./xml.js";

/** A decoded rich-text value; `null` where SheetJS has no text. */
export type SharedString = string | null;
export type SharedStrings = readonly SharedString[];

/**
 * How empty content is judged: the shared-string table trims each item before
 * reading it, inline strings do not (so `<is> </is>` has no text, but
 * `<si> </si>` is `""`).
 */
export type RichTextMode = "shared" | "inline";

/**
 * Receives the events INSIDE one `<si>` / `<is>` element and yields its value;
 * `reset` readies it for the next element, so one reader serves a whole table.
 */
export interface RichTextReader extends XmlHandler {
  readonly result: () => SharedString;
  readonly reset: () => void;
}

const isWhitespace = (s: string): boolean => /^\s*$/.test(s);

/**
 * A SAX-event accumulator for one rich-text element. It mutates local state as
 * events arrive (it is a parser, and allocating per event would cost the hot
 * path); the state never escapes and `result` is a pure read of it.
 */
export const createRichTextReader = (mode: RichTextMode): RichTextReader => {
  let depth = 0;
  let firstChild: "none" | "t" | "other" = "none";
  let leadingText: "none" | "whitespace" | "text" = "none";
  let firstText = "";
  let inFirstT = false;
  let hasRun = false;
  let phoneticDepth = 0;
  let runTDepth = 0;
  let runText = "";

  return {
    reset: () => {
      depth = 0;
      firstChild = "none";
      leadingText = "none";
      firstText = "";
      inFirstT = false;
      hasRun = false;
      phoneticDepth = 0;
      runTDepth = 0;
      runText = "";
    },
    open: (name: string, attrs: XmlAttrs, selfClosing: boolean) => {
      if (depth === 0 && firstChild === "none") {
        firstChild = name === "t" ? "t" : "other";
        inFirstT = firstChild === "t" && !selfClosing;
      }
      if (name === "r" && !selfClosing && Object.keys(attrs).length === 0) hasRun = true;
      if (name === "rPh") phoneticDepth++;
      if (name === "t" && phoneticDepth === 0) runTDepth++;
      depth++;
    },
    close: (name: string) => {
      depth--;
      if (name === "t" && phoneticDepth === 0 && runTDepth > 0) runTDepth--;
      if (name === "rPh" && phoneticDepth > 0) phoneticDepth--;
      if (depth === 0 && inFirstT) inFirstT = false;
    },
    text: (text: string) => {
      if (depth === 0 && firstChild === "none" && text.length > 0) {
        leadingText = leadingText === "text" || !isWhitespace(text) ? "text" : "whitespace";
      }
      if (inFirstT) firstText += text;
      if (runTDepth > 0 && phoneticDepth === 0) runText += text;
    },
    result: () => {
      if (firstChild === "t" && leadingText !== "text") return decodeXmlEscapes(firstText);
      if (hasRun) return decodeXmlEscapes(runText);
      const empty = firstChild === "none" && (mode === "shared" ? leadingText !== "text" : leadingText === "none");
      return empty ? "" : null;
    },
  };
};

/**
 * `xl/sharedStrings.xml` → the table, indexed by `<c t="s">` values.
 *
 * Like SheetJS (which splits the table on `</si>`), the table carries one extra
 * trailing entry for whatever follows the last `<si>`: `""` when that is empty,
 * `null` otherwise. A document whose root is not `<sst>` yields an empty table.
 */
export const parseSharedStrings = (xml: string): Result<SharedStrings, string> => {
  const table: SharedString[] = [];
  let depth = 0;
  let isSst = false;
  const reader = createRichTextReader("shared");
  let inItem = false;
  // Asserted (not annotated) so control-flow analysis does not pin it to "none":
  // it is only ever reassigned inside the handler callbacks.
  let trailingContent = "none" as "none" | "whitespace" | "content";

  const handler: XmlHandler = {
    open: (name, attrs, selfClosing) => {
      if (inItem) reader.open(name, attrs, selfClosing);
      else if (depth === 0) isSst = name === "sst" && !selfClosing;
      else if (depth === 1 && isSst && name === "si" && !selfClosing) {
        reader.reset();
        inItem = true;
      } else if (isSst) trailingContent = "content";
      depth++;
    },
    close: (name) => {
      depth--;
      if (!inItem) return;
      if (depth === 1 && name === "si") {
        table.push(reader.result());
        inItem = false;
        trailingContent = "none";
      } else reader.close(name);
    },
    text: (text) => {
      if (inItem) reader.text(text);
      else if (depth >= 1 && isSst && trailingContent !== "content") {
        trailingContent = isWhitespace(text) ? "whitespace" : "content";
      }
    },
  };

  const parsed = parseXml(xml, handler);
  if (!parsed.ok) return err(parsed.error);
  if (!isSst) return ok(Object.freeze([]));
  table.push(trailingContent === "content" ? null : "");
  return ok(Object.freeze(table));
};
