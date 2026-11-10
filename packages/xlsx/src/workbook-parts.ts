/**
 * The workbook's part graph: `[Content_Types].xml` locates the workbook,
 * shared strings and styles; `workbook.xml` lists the sheets in order; the
 * workbook rels map each sheet's `r:id` to its part path.
 *
 * Pure: XML strings in, values out. Path resolution follows SheetJS 0.18.5
 * `parse_zip` exactly, including its fallbacks, so the same sheet part is read.
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import { decodeXmlEscapes } from "./cell-value.js";
import { attrLocal, parseXml, type XmlHandler } from "./xml.js";

// ── [Content_Types].xml ──────────────────────────────────────────────────────

const WORKBOOK_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.main",
  "application/vnd.ms-excel.addin.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
]);
const SHARED_STRINGS_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
  "application/vnd.ms-excel.sharedStrings",
]);
const STYLES_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
  "application/vnd.ms-excel.styles",
]);

/** Part paths without a leading slash; `null` when the content types name none. */
export interface PartLocations {
  readonly workbook: string | null;
  readonly sharedStrings: string | null;
  readonly styles: string | null;
}

const stripFrontSlash = (p: string): string => (p.charAt(0) === "/" ? p.slice(1) : p);

/** `[Content_Types].xml` → the first override of each part kind. */
export const parseContentTypes = (xml: string): Result<PartLocations, string> => {
  let workbook: string | null = null;
  let sharedStrings: string | null = null;
  let styles: string | null = null;
  const handler: XmlHandler = {
    open: (name, attrs) => {
      if (name !== "Override") return;
      const part = attrLocal(attrs, "PartName");
      const type = attrLocal(attrs, "ContentType") ?? "";
      if (part === undefined) return;
      if (workbook === null && WORKBOOK_TYPES.has(type)) workbook = stripFrontSlash(part);
      else if (sharedStrings === null && SHARED_STRINGS_TYPES.has(type)) sharedStrings = stripFrontSlash(part);
      else if (styles === null && STYLES_TYPES.has(type)) styles = stripFrontSlash(part);
    },
    close: () => undefined,
    text: () => undefined,
  };
  const parsed = parseXml(xml, handler);
  return parsed.ok ? ok(Object.freeze({ workbook, sharedStrings, styles })) : err(parsed.error);
};

// ── workbook.xml ─────────────────────────────────────────────────────────────

export interface SheetEntry {
  readonly name: string;
  /** The `r:id` relationship id (or `strRelID`), when present. */
  readonly relId: string | undefined;
}

/** `xl/workbook.xml` → the sheets, in workbook order. */
export const parseWorkbookXml = (xml: string): Result<readonly SheetEntry[], string> => {
  const sheets: SheetEntry[] = [];
  const handler: XmlHandler = {
    open: (name, attrs) => {
      if (name !== "sheet") return;
      sheets.push(
        Object.freeze({
          name: decodeXmlEscapes(attrLocal(attrs, "name") ?? ""),
          relId: attrLocal(attrs, "id") || attrLocal(attrs, "strRelID"),
        }),
      );
    },
    close: () => undefined,
    text: () => undefined,
  };
  const parsed = parseXml(xml, handler);
  return parsed.ok ? ok(Object.freeze(sheets)) : err(parsed.error);
};

// ── relationships ────────────────────────────────────────────────────────────

export interface Relationship {
  readonly target: string;
  readonly type: string;
}

/** A `.rels` part → relationship id → target and type (a later duplicate id wins). */
export const parseRelationships = (xml: string): Result<ReadonlyMap<string, Relationship>, string> => {
  const rels = new Map<string, Relationship>();
  const handler: XmlHandler = {
    open: (name, attrs) => {
      if (name !== "Relationship") return;
      const id = attrLocal(attrs, "Id");
      if (id === undefined) return;
      rels.set(id, Object.freeze({ target: attrLocal(attrs, "Target") ?? "", type: attrLocal(attrs, "Type") ?? "" }));
    },
    close: () => undefined,
    text: () => undefined,
  };
  const parsed = parseXml(xml, handler);
  return parsed.ok ? ok(rels) : err(parsed.error);
};

/** SheetJS `parse_zip`: `xl/workbook.xml` → `xl/_rels/workbook.xml.rels`. */
export const workbookRelsPath = (workbookPath: string): string => {
  const slash = workbookPath.lastIndexOf("/");
  return stripFrontSlash(`${workbookPath.slice(0, slash + 1)}_rels/${workbookPath.slice(slash + 1)}.rels`);
};

// ── sheet parts ──────────────────────────────────────────────────────────────

const WORKSHEET_RELS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
]);
const CELLLESS_SHEET_RELS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/dialogsheet",
  "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet",
]);

/**
 * Where a sheet's cells come from:
 * - `worksheet`: stream the part at `path`.
 * - `cellless`: a chart, dialog or macro sheet; SheetJS reads no cells from it.
 * - `unreadable`: SheetJS fails on it (an unknown sheet type), so it is absent.
 */
export type SheetPart =
  | { readonly kind: "worksheet"; readonly name: string; readonly path: string }
  | { readonly kind: "cellless"; readonly name: string; readonly path: string }
  | { readonly kind: "unreadable"; readonly name: string };

export interface SheetResolution {
  readonly sheets: readonly SheetEntry[];
  /** `null` when the workbook rels part is missing. */
  readonly rels: ReadonlyMap<string, Relationship> | null;
  readonly relsPath: string;
  /** Whether a part exists in the archive (case-insensitive, as SheetJS looks it up). */
  readonly exists: (path: string) => boolean;
}

const partKind = (type: string): "worksheet" | "cellless" | "unreadable" =>
  type === "" || WORKSHEET_RELS.has(type) ? "worksheet" : CELLLESS_SHEET_RELS.has(type) ? "cellless" : "unreadable";

/**
 * Resolve every sheet to its part, as SheetJS 0.18.5 does: through the rels when
 * EVERY sheet's id resolves, otherwise by the conventional
 * `xl/worksheets/sheet<n>.xml` names for all of them.
 */
export const resolveSheetParts = (r: SheetResolution): readonly SheetPart[] => {
  const rels = r.rels;
  const linked = r.sheets.flatMap((sheet) => {
    const rel = rels === null || sheet.relId === undefined ? undefined : rels.get(sheet.relId);
    return rel === undefined ? [] : [{ sheet, rel }];
  });
  if (linked.length === 0 || linked.length !== r.sheets.length) {
    const numbersMode = r.exists("xl/worksheets/sheet.xml") ? 1 : 0;
    return Object.freeze(
      r.sheets.map((s, i): SheetPart =>
        Object.freeze({
          kind: "worksheet",
          name: s.name,
          path: `xl/worksheets/sheet${i + 1 - numbersMode}.xml`.replace(/sheet0\./, "sheet."),
        }),
      ),
    );
  }
  const relsDir = r.relsPath.replace(/_rels\/.*$/, "");
  return Object.freeze(
    linked.map(({ sheet, rel }): SheetPart => {
      const kind = partKind(rel.type);
      if (kind === "unreadable") return Object.freeze({ kind, name: sheet.name });
      let path = `xl/${rel.target.replace(/[/]?xl\//, "")}`;
      if (!r.exists(path)) path = rel.target;
      if (!r.exists(path)) path = relsDir + rel.target;
      return Object.freeze({ kind, name: sheet.name, path });
    }),
  );
};

/**
 * The sheet a selector names, or `undefined` when there is none: by exact name,
 * or by 1-based index (default 1). When names repeat, SheetJS keeps the last
 * sheet under that name, for both forms of selection.
 */
export const selectSheet = (parts: readonly SheetPart[], selector: string | number | undefined): SheetPart | undefined => {
  const index = selector ?? 1;
  const name = typeof index === "string" ? index : Number.isInteger(index) ? parts[index - 1]?.name : undefined;
  return name === undefined ? undefined : parts.findLast((part) => part.name === name);
};
