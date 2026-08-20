// Shared pure primitives for the framework CLI argument parsers.

export type FlagValueParse =
  | { readonly ok: true; readonly value: string; readonly nextIndex: number }
  | { readonly ok: false; readonly problem: string; readonly nextIndex: number };

/**
 * Parse the value immediately following a flag.
 *
 * A following flag is not consumed as a value. `nextIndex` is the caller's
 * next loop position: unchanged on failure, advanced to the consumed value on
 * success. Keeping index movement in this result makes every CLI parser share
 * the same missing-value and consumption invariant.
 */
export const parseFlagValue = (
  args: readonly string[],
  flagIndex: number,
  flag: string,
): FlagValueParse => {
  const value = args[flagIndex + 1];
  return value === undefined || value.startsWith("--")
    ? { ok: false, problem: `${flag} requires a value`, nextIndex: flagIndex }
    : { ok: true, value, nextIndex: flagIndex + 1 };
};
