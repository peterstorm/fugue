/**
 * Thin saxes wrappers. saxes is a strict, well-formed XML SAX parser that does
 * no entity expansion beyond the five predefined entities and character
 * references, which makes it safe on hostile workbook parts.
 *
 * Element names are reported as LOCAL names (the `x:` prefix some producers use
 * is stripped, as SheetJS's `(?:\w+:)?` patterns do). Attributes keep their raw
 * qualified names; `attrLocal` looks one up by local name.
 *
 * A self-closing element is reported as `open(…, selfClosing = true)` followed
 * by `close`, so handlers can track depth uniformly.
 */

import { SaxesParser } from "saxes";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";

export type XmlAttrs = Readonly<Record<string, string>>;

export interface XmlHandler {
  readonly open: (name: string, attrs: XmlAttrs, selfClosing: boolean) => void;
  readonly close: (name: string) => void;
  readonly text: (text: string) => void;
}

/** An incremental XML parse: feed text chunks, then close. */
export interface XmlFeed {
  readonly write: (chunk: string) => Result<void, string>;
  readonly close: () => Result<void, string>;
}

const localName = (qname: string): string => {
  const colon = qname.indexOf(":");
  return colon < 0 ? qname : qname.slice(colon + 1);
};

/** Attribute by local name (`r:id` answers `"id"`); the last match wins, as in SheetJS `parsexmltag`. */
export const attrLocal = (attrs: XmlAttrs, name: string): string | undefined => {
  let found: string | undefined;
  for (const key of Object.keys(attrs)) if (localName(key) === name) found = attrs[key];
  return found;
};

/** Marks an exception raised by a handler (caller code), so it is rethrown rather than reported as bad XML. */
class HandlerFailure {
  constructor(readonly cause: unknown) {}
}

const guarded =
  <A extends unknown[]>(f: (...args: A) => void) =>
  (...args: A): void => {
    try {
      f(...args);
    } catch (e) {
      throw new HandlerFailure(e);
    }
  };

export const createXmlFeed = (handler: XmlHandler): XmlFeed => {
  const parser = new SaxesParser({ xmlns: false, position: false });
  const open = guarded(handler.open);
  const close = guarded(handler.close);
  const text = guarded(handler.text);
  parser.on("opentag", (tag) => open(localName(tag.name), tag.attributes, tag.isSelfClosing));
  parser.on("closetag", (tag) => close(localName(tag.name)));
  parser.on("text", text);
  parser.on("cdata", text);

  let failure: string | null = null;
  const run = (action: () => void): Result<void, string> => {
    if (failure !== null) return err(failure);
    try {
      action();
      return ok(undefined);
    } catch (e) {
      if (e instanceof HandlerFailure) throw e.cause;
      failure = e instanceof Error ? e.message : String(e);
      return err(failure);
    }
  };
  return {
    write: (chunk) => run(() => parser.write(chunk)),
    close: () => run(() => parser.close()),
  };
};

/** Parse a complete (small) XML part. */
export const parseXml = (xml: string, handler: XmlHandler): Result<void, string> => {
  const feed = createXmlFeed(handler);
  const written = feed.write(xml);
  return written.ok ? feed.close() : written;
};

/** Decode a whole part's bytes as UTF-8 (BOM stripped, invalid bytes replaced — as Node's `Buffer#toString`). */
export const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
