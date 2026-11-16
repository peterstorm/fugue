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
  /** Record the acquired resource, replacing any value still held. */
  readonly set: (value: T) => void;
  /** Hand out the held resource once and empty the cell. */
  readonly take: () => T | undefined;
  /** Read the held resource without taking ownership of it. */
  readonly peek: () => T | undefined;
}

export const owned = <T extends object>(): Owned<T> => {
  let held: T | undefined;
  return {
    set: (value) => { held = value; },
    take: () => {
      const value = held;
      held = undefined;
      return value;
    },
    peek: () => held,
  };
};
