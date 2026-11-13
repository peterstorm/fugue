/**
 * Date detection from `xl/styles.xml`, exactly as SheetJS 0.18.5 decides it
 * under `cellDates: true`: a numeric cell is a date when its style's number
 * format string passes `SSF.is_date`.
 *
 * The format string for a `numFmtId` is the workbook's custom `<numFmt>` for
 * that id (ids > 0), else SheetJS's built-in table (`SSF_init_table`), else its
 * implicit table (`SSFImplicit`), else `General`. Date detection only happens
 * when the styles part has a `<cellXfs>` list at all.
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import { decodeXmlEscapes } from "./cell-value.js";
import { attrLocal, parseXml, type XmlHandler } from "./xml.js";

/** SheetJS `SSF_init_table`. */
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
  12: "# ?/?", 13: "# ??/??", 14: "m/d/yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
  18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
  56: '"上午/下午 "hh"時"mm"分"ss"秒 "',
};

/** SheetJS `SSFImplicit`: what an id missing from the built-in table falls back to. */
const IMPLICIT_FORMATS: Readonly<Record<number, string>> = {
  5: '"$"#,##0_);\\("$"#,##0\\)', 6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)', 8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  23: "General", 24: "General", 25: "General", 26: "General",
  27: "m/d/yy", 28: "m/d/yy", 29: "m/d/yy", 30: "m/d/yy", 31: "m/d/yy",
  32: "h:mm:ss", 33: "h:mm:ss", 34: "h:mm:ss", 35: "h:mm:ss", 36: "m/d/yy",
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  50: "m/d/yy", 51: "m/d/yy", 52: "m/d/yy", 53: "m/d/yy", 54: "m/d/yy",
  55: "m/d/yy", 56: "m/d/yy", 57: "m/d/yy", 58: "m/d/yy",
  59: "0", 60: "0.00", 61: "#,##0", 62: "#,##0.00",
  63: '"$"#,##0_);\\("$"#,##0\\)', 64: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  65: '"$"#,##0.00_);\\("$"#,##0.00\\)', 66: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  67: "0%", 68: "0.00%", 69: "# ?/?", 70: "# ??/??", 71: "m/d/yy", 72: "m/d/yy", 73: "d-mmm-yy",
  74: "d-mmm", 75: "mmm-yy", 76: "h:mm", 77: "h:mm:ss", 78: "m/d/yy h:mm", 79: "mm:ss", 80: "[h]:mm:ss",
  81: "mmss.0",
};

/** The format string SheetJS resolves for a built-in `numFmtId` (no custom formats). */
export const builtinNumberFormat = (id: number): string => BUILTIN_FORMATS[id] ?? IMPLICIT_FORMATS[id] ?? "General";

// ── SSF.is_date port ─────────────────────────────────────────────────────────

const ABSOLUTE_TIME = /\[[HhMmSsชนท]*\]/;

/** SheetJS `SSF_isgeneral`: "General" (any case) at `i`. */
const isGeneralAt = (s: string, i: number): boolean => s.slice(i, i + 7).toLowerCase() === "general";

const DATE_TOKEN_CHARS = new Set("MDYHSEmdyhseg");
const DIGITS_1_9 = new Set("123456789");

/** Index just past the `"…"` literal that opens at `start` (an unterminated one runs to the end). */
const skipQuoted = (fmt: string, start: number): number => {
  let i = start;
  for (; fmt.charCodeAt(++i) !== 34 && i < fmt.length; ) {
    /* skip the quoted literal */
  }
  return i + 1;
};

/** The `[…]` bracket that opens at `start`, and the index scanning resumes at. */
const scanBracket = (fmt: string, start: number): { readonly text: string; readonly next: number } => {
  let i = start;
  let text = fmt.charAt(i);
  while (fmt.charAt(i++) !== "]" && i < fmt.length) text += fmt.charAt(i);
  return { text, next: i };
};

/** Whether the character at `i` continues a `0`/`#`/`.` number token. */
const continuesNumberToken = (fmt: string, i: number): boolean => {
  const d = fmt.charAt(i);
  return (
    "0#?.,E+-%".indexOf(d) > -1 ||
    (d === "\\" && fmt.charAt(i + 1) === "-" && "0#".indexOf(fmt.charAt(i + 2)) > -1)
  );
};

/** Index past the number token (`0`, `#`, `.` and what follows) that starts at `start`. */
const skipNumberToken = (fmt: string, start: number): number => {
  let i = start;
  while (i < fmt.length && continuesNumberToken(fmt, ++i)) {
    /* skip the number token */
  }
  return i;
};

/** Index past the run of `c` that starts at `start`. */
const skipRun = (fmt: string, start: number, c: string): number => {
  let i = start;
  while (fmt.charAt(++i) === c) {
    /* skip the run */
  }
  return i;
};

/** Index past a `*` fill marker and the single fill character after it. */
const skipFill = (fmt: string, start: number): number => {
  const i = start + 1;
  return fmt.charAt(i) === " " || fmt.charAt(i) === "*" ? i + 1 : i;
};

/** Index past the literal-digit run (`1`-`9` first) that starts at `start`. */
const skipLiteralDigits = (fmt: string, start: number): number => {
  let i = start;
  while (i < fmt.length && "0123456789".indexOf(fmt.charAt(++i)) > -1) {
    /* skip the literal digits */
  }
  return i;
};

/** `A/P`, `AM/PM` or the Chinese `上午/下午` meridiem marker begins at `i`. */
const isMeridiemAt = (fmt: string, i: number): boolean =>
  fmt.substr(i, 3).toUpperCase() === "A/P" ||
  fmt.substr(i, 5).toUpperCase() === "AM/PM" ||
  fmt.substr(i, 5).toUpperCase() === "上午/下午";

/**
 * SheetJS 0.18.5 `fmt_is_date` (`SSF.is_date`), ported statement for statement
 * so the differential test can hold it to the original. Quoted literals,
 * escapes, padding and number tokens are skipped; any date/time token
 * (or `B1`/`B2`, `A/P`, `AM/PM`, or an `[h]`-style elapsed bracket) makes it a date.
 */
export const isDateFormat = (fmt: string): boolean => {
  let i = 0;
  while (i < fmt.length) {
    const c = fmt.charAt(i);
    if (c === "G") {
      if (isGeneralAt(fmt, i)) i += 6;
      i++;
    } else if (c === '"') {
      i = skipQuoted(fmt, i);
    } else if (c === "\\" || c === "_") {
      i += 2;
    } else if (c === "@") {
      ++i;
    } else if (c === "B" || c === "b" || DATE_TOKEN_CHARS.has(c)) {
      return true;
    } else if (c === "A" || c === "a" || c === "上") {
      if (isMeridiemAt(fmt, i)) return true;
      ++i;
    } else if (c === "[") {
      const bracket = scanBracket(fmt, i);
      if (ABSOLUTE_TIME.test(bracket.text)) return true;
      i = bracket.next;
    } else if (c === "." || c === "0" || c === "#") {
      i = skipNumberToken(fmt, i);
    } else if (c === "?") {
      i = skipRun(fmt, i, c);
    } else if (c === "*") {
      i = skipFill(fmt, i);
    } else if (DIGITS_1_9.has(c)) {
      i = skipLiteralDigits(fmt, i);
    } else {
      ++i;
    }
  }
  return false;
};

// ── styles.xml ───────────────────────────────────────────────────────────────

/**
 * - `unformatted`: no styles part, or no `<cellXfs>` — SheetJS then never
 *   formats, so no number is ever a date.
 * - `formatted`: `dateXfs[i]` says whether cell style `i` is a date format.
 */
export type DateStyles =
  | { readonly kind: "unformatted" }
  | { readonly kind: "formatted"; readonly dateXfs: readonly boolean[] };

export const UNFORMATTED: DateStyles = Object.freeze({ kind: "unformatted" });

/** A canonical array index, as JS array lookup by string key (`CellXf[tag.s]`) requires. */
const CANONICAL_INDEX = /^(0|[1-9]\d*)$/;

/** Whether a cell's raw `s` attribute names a date-formatted style. */
export const isDateStyle = (styles: DateStyles, s: string | undefined): boolean =>
  styles.kind === "formatted" && s !== undefined && CANONICAL_INDEX.test(s) && styles.dateXfs[Number(s)] === true;

/** SheetJS sets numeric xf attributes with `parseInt` only when the attribute is non-empty. */
const parseNumFmtId = (raw: string | undefined): number | undefined =>
  raw === undefined || raw === "" ? undefined : parseInt(raw, 10);

const formatFor = (customs: ReadonlyMap<number, string>, id: number | undefined): string =>
  id === undefined ? "General" : (customs.get(id) ?? builtinNumberFormat(id));

/** `xl/styles.xml` → which cell styles are dates. */
export const parseStyles = (xml: string): Result<DateStyles, string> => {
  const customs = new Map<number, string>();
  const xfFormatIds: Array<number | undefined> = [];
  const open: string[] = [];
  let sawCellXfs = false;

  const handler: XmlHandler = {
    open: (name, attrs, selfClosing) => {
      const parent = open[open.length - 1];
      if (name === "numFmt" && parent === "numFmts") {
        const id = parseInt(attrLocal(attrs, "numFmtId") ?? "", 10);
        const code = attrLocal(attrs, "formatCode");
        if (id > 0 && code !== undefined) customs.set(id, decodeXmlEscapes(code));
      } else if (name === "cellXfs" && !selfClosing) {
        sawCellXfs = true;
      } else if (name === "xf" && parent === "cellXfs") {
        xfFormatIds.push(parseNumFmtId(attrLocal(attrs, "numFmtId")));
      }
      open.push(name);
    },
    close: () => {
      open.pop();
    },
    text: () => undefined,
  };

  const parsed = parseXml(xml, handler);
  if (!parsed.ok) return err(parsed.error);
  if (!sawCellXfs) return ok(UNFORMATTED);
  return ok(
    Object.freeze({
      kind: "formatted",
      dateXfs: Object.freeze(xfFormatIds.map((id) => isDateFormat(formatFor(customs, id)))),
    }),
  );
};
