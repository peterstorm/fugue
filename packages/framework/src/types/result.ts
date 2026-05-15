// Hand-rolled Result type — no external dependencies

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export const andThen = <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> => (r.ok ? fn(r.value) : r);

export const map = <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> => (r.ok ? ok(fn(r.value)) : r);

export const mapErr = <T, E, F>(
  r: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> => (r.ok ? r : err(fn(r.error)));

/**
 * Extract the Ok value or throw. Not exported from the public barrel —
 * prefer `unwrapOr`, `fold`, or explicit `isOk`/`isErr` checks.
 * Available via direct path import for tests.
 */
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`Called unwrap on Err: ${String(r.error)}`);
};

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T =>
  r.ok ? r.value : fallback;

/** Exhaustive fold — forces handling both Ok and Err paths. */
export const fold = <T, E, R>(
  r: Result<T, E>,
  onOk: (value: T) => R,
  onErr: (error: E) => R,
): R => (r.ok ? onOk(r.value) : onErr(r.error));
