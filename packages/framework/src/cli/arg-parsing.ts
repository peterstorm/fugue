// Shared pure primitives for the framework CLI argument parsers (`fugue new`,
// `fugue compose`): one flag scanner and one accumulating parse result.
//
// Every parser reports ALL of its problems at once (an LLM author sees every
// fix in one round), so a failure carries a non-empty problem list instead of
// the first error. Checks are independent values that the caller combines with
// `all`, which concatenates their problems in argument order — no helper ever
// pushes into a shared accumulator, and a failed check without a problem is
// unrepresentable (`Problems` is a non-empty tuple).

/** Every problem a parse found. Never empty: a failure always says why. */
export type Problems = readonly [string, ...string[]];

/** A failed parse: every problem it found. */
export interface Rejected {
  readonly ok: false;
  readonly problems: Problems;
}

/** An accumulating parse result: the parsed value, or every problem found. */
export type Checked<T> = { readonly ok: true; readonly value: T } | Rejected;

export const accept = <T>(value: T): Checked<T> => ({ ok: true, value });

export const reject = (problem: string, ...more: readonly string[]): Rejected => ({
  ok: false,
  problems: [problem, ...more],
});

/** `problems` as `Problems`, or `null` when there are none. */
const nonEmpty = (problems: readonly string[]): Problems | null => {
  const [first, ...rest] = problems;
  return first === undefined ? null : [first, ...rest];
};

/** A check that passes when `problems` is empty and otherwise fails with them. */
export const noProblems = (problems: readonly string[]): Checked<void> => {
  const found = nonEmpty(problems);
  return found === null ? accept(undefined) : { ok: false, problems: found };
};

/** A check that fails with `problem` exactly when `violated` holds. */
export const refuse = (violated: boolean, problem: string): Checked<void> =>
  violated ? reject(problem) : accept(undefined);

export const mapChecked = <T, U>(checked: Checked<T>, f: (value: T) => U): Checked<U> =>
  checked.ok ? accept(f(checked.value)) : checked;

/** Chain a check that needs the parsed value (it only runs when `checked` passed). */
export const andThenChecked = <T, U>(checked: Checked<T>, f: (value: T) => Checked<U>): Checked<U> =>
  checked.ok ? f(checked.value) : checked;

type CheckedValues<T extends readonly Checked<unknown>[]> = {
  readonly [K in keyof T]: T[K] extends Checked<infer U> ? U : never;
};

/**
 * Combine independent checks: every value when all pass, otherwise every
 * problem of every failed check, in argument order.
 */
export const all = <const T extends readonly Checked<unknown>[]>(...checks: T): Checked<CheckedValues<T>> => {
  const found = nonEmpty(checks.flatMap((c) => (c.ok ? [] : c.problems)));
  if (found !== null) return { ok: false, problems: found };
  // Every check passed (no problems), so each element is its `ok` arm and the
  // mapped tuple is exactly `CheckedValues<T>`; `map` cannot carry the tuple
  // type through, hence the one assertion here.
  return accept(checks.map((c) => (c.ok ? c.value : undefined)) as unknown as CheckedValues<T>);
};

// ---------------------------------------------------------------------------
// Flag scanning
// ---------------------------------------------------------------------------

type FlagValueParse =
  | { readonly ok: true; readonly value: string; readonly nextIndex: number }
  | { readonly ok: false; readonly problem: string; readonly nextIndex: number };

/**
 * Parse the value immediately following a flag.
 *
 * A following flag is not consumed as a value. `nextIndex` is the caller's
 * next loop position: unchanged on failure, advanced to the consumed value on
 * success.
 */
const parseFlagValue = (
  args: readonly string[],
  flagIndex: number,
  flag: string,
): FlagValueParse => {
  const value = args[flagIndex + 1];
  return value === undefined || value.startsWith("--")
    ? { ok: false, problem: `${flag} requires a value`, nextIndex: flagIndex }
    : { ok: true, value, nextIndex: flagIndex + 1 };
};

/** The flags a command accepts: value flags (`--x <v>`) and switches (`--y`). */
export interface FlagSpec<V extends string, S extends string> {
  readonly valueFlags: readonly V[];
  readonly switches: readonly S[];
}

/**
 * A lenient scan of a command's arguments: the raw values plus every scan
 * problem (unknown flag, missing flag value, extra positional). Lenient so a
 * command can still check what WAS given and report those problems too.
 */
export interface ScannedArgs<V extends string, S extends string> {
  /** The first non-flag argument, if any (a second one is a scan problem). */
  readonly positional: string | undefined;
  /** The last occurrence's value; `undefined` if absent or its value was missing. */
  readonly value: (flag: V) => string | undefined;
  readonly isSet: (flag: S) => boolean;
  readonly problems: readonly string[];
}

const isOneOf = <F extends string>(flags: readonly F[], arg: string): arg is F =>
  (flags as readonly string[]).includes(arg);

/** Scan `args` against `spec`, collecting every scan problem in argument order. */
export const scanArgs = <V extends string, S extends string>(
  args: readonly string[],
  spec: FlagSpec<V, S>,
): ScannedArgs<V, S> => {
  const problems: string[] = [];
  // A value flag whose value is missing resets to `undefined` (last occurrence wins).
  const values = new Map<V, string | undefined>();
  const switches = new Set<S>();
  let positional: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (isOneOf(spec.valueFlags, arg)) {
      const parsed = parseFlagValue(args, i, arg);
      i = parsed.nextIndex;
      if (!parsed.ok) problems.push(parsed.problem);
      values.set(arg, parsed.ok ? parsed.value : undefined);
    } else if (isOneOf(spec.switches, arg)) {
      switches.add(arg);
    } else if (arg.startsWith("--")) {
      problems.push(`unknown flag: ${arg}`);
    } else if (positional === undefined) {
      positional = arg;
    } else {
      problems.push(`unexpected argument: ${arg}`);
    }
  }
  return {
    positional,
    value: (flag) => values.get(flag),
    isSet: (flag) => switches.has(flag),
    problems,
  };
};
