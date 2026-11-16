// The shared CLI parsing primitives behind `fugue new` and `fugue compose`:
// the accumulating `Checked` result and the lenient flag scanner.

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import {
  accept,
  all,
  andThenChecked,
  mapChecked,
  noProblems,
  refuse,
  reject,
  scanArgs,
  type Checked,
} from "../../cli/arg-parsing.js";

const problem = fc.string({ minLength: 1 }).filter((s) => !s.startsWith("--"));
const checkedNumber: fc.Arbitrary<Checked<number>> = fc.oneof(
  fc.integer().map((n) => accept(n)),
  fc.array(problem, { minLength: 1, maxLength: 3 }).map(([first, ...rest]) => reject(first!, ...rest)),
);
const problemsOf = (c: Checked<unknown>): readonly string[] => (c.ok ? [] : c.problems);

describe("Checked combinators", () => {
  it("all: passes with every value in order exactly when every check passes", () => {
    fc.assert(
      fc.property(fc.array(checkedNumber, { maxLength: 6 }), (checks) => {
        const combined = all(...checks);
        if (checks.every((c) => c.ok)) {
          expect(combined).toEqual(accept(checks.map((c) => (c.ok ? c.value : NaN))));
        } else {
          expect(combined.ok).toBe(false);
        }
      }),
    );
  });

  it("all: a failure carries every failed check's problems, in argument order, and is never empty", () => {
    fc.assert(
      fc.property(fc.array(checkedNumber, { maxLength: 6 }), (checks) => {
        const combined = all(...checks);
        if (!combined.ok) {
          expect(problemsOf(combined)).toEqual(checks.flatMap(problemsOf));
          expect(combined.problems.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("all: concatenation is associative — grouping checks never changes the problems", () => {
    fc.assert(
      fc.property(checkedNumber, checkedNumber, checkedNumber, (a, b, c) => {
        expect(problemsOf(all(all(a, b), c))).toEqual(problemsOf(all(a, all(b, c))));
      }),
    );
  });

  it("noProblems / refuse fail exactly when there is something to report", () => {
    expect(noProblems([])).toEqual(accept(undefined));
    expect(noProblems(["a", "b"])).toEqual({ ok: false, problems: ["a", "b"] });
    expect(refuse(false, "x")).toEqual(accept(undefined));
    expect(refuse(true, "x")).toEqual({ ok: false, problems: ["x"] });
  });

  it("mapChecked / andThenChecked only run on a passed check", () => {
    expect(mapChecked(accept(2), (n) => n * 3)).toEqual(accept(6));
    expect(mapChecked(reject("no"), () => 1)).toEqual(reject("no"));
    expect(andThenChecked(accept(2), () => reject("later"))).toEqual(reject("later"));
    expect(andThenChecked(reject("first"), () => accept(1))).toEqual(reject("first"));
  });
});

describe("scanArgs", () => {
  const SPEC = { valueFlags: ["--team", "--dir"], switches: ["--force"] } as const;

  it("collects the positional, values and switches regardless of order", () => {
    const scanned = scanArgs(["--force", "--team", "a", "intent", "--dir", "d"], SPEC);
    expect(scanned.positional).toBe("intent");
    expect(scanned.value("--team")).toBe("a");
    expect(scanned.value("--dir")).toBe("d");
    expect(scanned.isSet("--force")).toBe(true);
    expect(scanned.problems).toEqual([]);
  });

  it("reports unknown flags, a missing value and extra positionals in argument order", () => {
    const scanned = scanArgs(["one", "--turbo", "two", "--team", "--force"], SPEC);
    expect(scanned.problems).toEqual(["unknown flag: --turbo", "unexpected argument: two", "--team requires a value"]);
    // A following flag is never consumed as the value: --force still counts.
    expect(scanned.isSet("--force")).toBe(true);
    expect(scanned.value("--team")).toBeUndefined();
  });

  it("the last occurrence of a value flag wins, and a later missing value resets it", () => {
    expect(scanArgs(["--team", "a", "--team", "b"], SPEC).value("--team")).toBe("b");
    expect(scanArgs(["--team", "a", "--team"], SPEC).value("--team")).toBeUndefined();
  });

  it("any argument list without flags yields its first element as the positional and one problem per extra", () => {
    fc.assert(
      fc.property(fc.array(problem, { maxLength: 6 }), (args) => {
        const scanned = scanArgs(args, SPEC);
        expect(scanned.positional).toBe(args[0]);
        expect(scanned.problems).toEqual(args.slice(1).map((a) => `unexpected argument: ${a}`));
      }),
    );
  });
});
