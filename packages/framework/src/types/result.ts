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
  throw new Error(
    `Called unwrap on Err: ${typeof r.error === "object" && r.error !== null ? JSON.stringify(r.error) : String(r.error)}`,
  );
};

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T =>
  r.ok ? r.value : fallback;

/** Exhaustive fold — forces handling both Ok and Err paths. */
export const fold = <T, E, R>(
  r: Result<T, E>,
  onOk: (value: T) => R,
  onErr: (error: E) => R,
): R => (r.ok ? onOk(r.value) : onErr(r.error));

/** Wrap a throwing function in a Result. Catches synchronous exceptions. */
export function tryCatch<T>(fn: () => T): Result<T, Error>;
export function tryCatch<T, E>(fn: () => T, mapError: (e: unknown) => E): Result<T, E>;
export function tryCatch<T, E = Error>(fn: () => T, mapError?: (e: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (e) {
    if (mapError) return err(mapError(e));
    return err((e instanceof Error ? e : new Error(String(e))) as E);
  }
}

/** Wrap an async throwing function in a Result. */
export function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>>;
export function tryCatchAsync<T, E>(fn: () => Promise<T>, mapError: (e: unknown) => E): Promise<Result<T, E>>;
export async function tryCatchAsync<T, E = Error>(fn: () => Promise<T>, mapError?: (e: unknown) => E): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (mapError) return err(mapError(e));
    return err((e instanceof Error ? e : new Error(String(e))) as E);
  }
}

/** Collect a list of Results into a Result of list. Short-circuits on first Err. */
export const sequenceFirst = <T, E>(results: readonly Result<T, E>[]): Result<T[], E> => {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
};

/** Collect all Results — returns all values if all ok, all errors if any failed. */
export const sequenceAll = <T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> => {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return errors.length === 0 ? ok(values) : err(errors);
};

/** Execute a side effect on Ok values without breaking the pipeline. */
export const tap = <T, E>(r: Result<T, E>, fn: (value: T) => void): Result<T, E> => {
  if (r.ok) fn(r.value);
  return r;
};

/** Execute a side effect on Err values without breaking the pipeline. */
export const tapErr = <T, E>(r: Result<T, E>, fn: (error: E) => void): Result<T, E> => {
  if (!r.ok) fn(r.error);
  return r;
};

/** Error recovery: on Err, try an alternative computation. */
export const orElse = <T, E, F>(
  r: Result<T, E>,
  fn: (error: E) => Result<T, F>,
): Result<T, F> => (r.ok ? r : fn(r.error));

/** Async andThen — for chaining async Result-producing functions. */
export const andThenAsync = async <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> => (r.ok ? fn(r.value) : r);

/** Async map — for chaining async transformations on Ok values. */
export const mapAsync = async <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Promise<U>,
): Promise<Result<U, E>> => (r.ok ? ok(await fn(r.value)) : r);

