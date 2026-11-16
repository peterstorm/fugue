/**
 * A one-shot ownership cell for a resource the process lifecycle must release.
 *
 * Teardown reaches the resource only through `take`, which hands the value out
 * and empties the cell in one step. Whoever takes it owns the release; a second
 * teardown finds the cell empty, so "clear before stop" holds by construction
 * even when the release itself throws. `peek` is for live reads (diagnostics,
 * the running host's surface) and never releases.
 *
 * `T extends object` keeps `undefined` free to mean "empty".
 */
export interface Owned<T extends object> {
  /**
   * Record the acquired resource. Refuses (throws) while the cell still holds
   * one: the held resource would become unreachable by `take`, so teardown
   * could never release it. Each cell is acquired once per lifecycle, so a
   * second `set` is a wiring bug, not a runtime condition.
   */
  readonly set: (value: T) => void;
  /** Hand out the held resource once and empty the cell. */
  readonly take: () => T | undefined;
  /** Read the held resource without taking ownership of it. */
  readonly peek: () => T | undefined;
}

export const owned = <T extends object>(): Owned<T> => {
  let held: T | undefined;
  return {
    set: (value) => {
      // Internal invariant guard (architecture.md: invariants may throw).
      if (held !== undefined) throw new Error("owned: set on a cell that still holds an unreleased resource");
      held = value;
    },
    take: () => {
      const value = held;
      held = undefined;
      return value;
    },
    peek: () => held,
  };
};
