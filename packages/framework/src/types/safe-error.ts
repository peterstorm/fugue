/**
 * Total diagnostics for values caught at an `unknown` boundary.
 *
 * JavaScript coercion is executable: a Proxy may throw from `get`,
 * `getPrototypeOf`, `ownKeys`, `toString`, or `Symbol.toPrimitive`; an Error
 * may expose a throwing `message` getter; and a revoked Proxy throws from
 * nearly every reflective operation. Diagnostics run while handling an
 * earlier failure, so they must never replace that failure with a second
 * throw. Every potentially user-controlled operation below has its own guard,
 * and each exported function ends in a constant fallback.
 */

export const UNPRINTABLE_VALUE = "<unprintable>";
export const UNPRINTABLE_ERROR = "<unprintable error>";

/**
 * Total result of inspecting an untrusted caught value for a Node-style errno.
 * Inspection failure is data, not an exception or an erased `undefined`.
 */
export type ErrorCodeProbe =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "absent" }
  | { readonly kind: "inspection-failed"; readonly diagnostic: string };

const safelyStringCoerce = (value: unknown): string | null => {
  try {
    return String(value);
  } catch {
    return null;
  }
};

const safelyObjectTag = (value: object): string | null => {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return null;
  }
};

/** Compact, total rendering for diagnostics that include arbitrary values. */
export const safeDiagnosticRender = (value: unknown): string => {
  if (typeof value === "string") {
    const shown = value.length > 60 ? `${value.slice(0, 60)}…(${value.length} chars)` : value;
    try {
      const json = JSON.stringify(shown);
      return typeof json === "string" ? json : UNPRINTABLE_VALUE;
    } catch {
      return UNPRINTABLE_VALUE;
    }
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return safelyStringCoerce(value) ?? UNPRINTABLE_VALUE;
  }
  if (typeof value === "object" || typeof value === "function") {
    return safelyObjectTag(value) ?? safelyStringCoerce(value) ?? UNPRINTABLE_VALUE;
  }
  return UNPRINTABLE_VALUE;
};

/**
 * Total, non-truncated rendering for diagnostics that carry a KNOWN string
 * (a file path, a request id): JSON-escaped, so quotes, backslashes, and
 * control characters cannot break the surrounding message, with NO length
 * cap — `safeDiagnosticRender`'s 60-char cap exists for arbitrary untrusted
 * values and would truncate legal-but-long paths in exactly the rare branch
 * where the full name is the diagnostic. A string is a `JSON.stringify`
 * domain with no `toJSON` hook, so the encode itself cannot throw; the guard
 * keeps this module's total-fallback discipline.
 */
export const safeDiagnosticString = (value: string): string => {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : UNPRINTABLE_VALUE;
  } catch {
    return UNPRINTABLE_VALUE;
  }
};

/**
 * Total human message for an arbitrary caught value. A string-valued
 * `message` is preferred, but reading it is itself guarded. Coercion and
 * object-tag fallbacks are independently guarded before the constant final
 * fallback is returned.
 */
export const safeErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;

  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    try {
      const message = Reflect.get(error, "message");
      if (typeof message === "string") return message;
    } catch {
      // Continue through independently guarded fallbacks.
    }

    const coerced = safelyStringCoerce(error);
    if (coerced !== null) return coerced;

    const tag = safelyObjectTag(error);
    if (tag !== null) return tag;

    return UNPRINTABLE_ERROR;
  }

  return safelyStringCoerce(error) ?? UNPRINTABLE_ERROR;
};

/**
 * Inspect `code` without invoking an `in`/`has` trap and without allowing a
 * getter, Proxy, or revoked Proxy to throw across the diagnostic boundary.
 */
export const probeErrorCode = (error: unknown): ErrorCodeProbe => {
  if (
    !((typeof error === "object" && error !== null) || typeof error === "function")
  ) {
    return { kind: "absent" };
  }

  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string"
      ? { kind: "code", code }
      : { kind: "absent" };
  } catch (inspectionError) {
    return {
      kind: "inspection-failed",
      diagnostic: safeErrorMessage(inspectionError),
    };
  }
};

/**
 * Render a primary failure while preserving a secondary errno-inspection
 * failure as actionable diagnostics. The supplied probe avoids invoking a
 * hostile getter twice.
 */
export const safeErrorMessageWithCodeProbe = (
  error: unknown,
  probe: ErrorCodeProbe,
): string => {
  const primary = safeErrorMessage(error);
  return probe.kind === "inspection-failed"
    ? `${primary} (error code inspection failed: ${probe.diagnostic})`
    : primary;
};
