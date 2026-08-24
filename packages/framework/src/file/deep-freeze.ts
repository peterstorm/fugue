// Shared deep-immutability primitive for the file backend.
//
// Plain objects and arrays are frozen in place. Map, Set, and Date need more:
// Object.freeze does not protect their internal slots, so this transform wraps
// them in read-only proxies that preserve normal reads/iteration/serialization
// while rejecting every mutator. Inputs are fresh detached trees at both call
// sites (job snapshots and decoded event records), so replacing nested values
// with proxies cannot affect caller-owned state.

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type DateMutationMethod = Extract<keyof Date, `set${string}`>;

/** Date view whose mutating `set*` methods are absent, matching the proxy. */
export type ReadonlyDate = Omit<Date, DateMutationMethod>;

/** Recursive static counterpart to this module's runtime freeze/proxy transform. */
export type DeepReadonly<T> =
  T extends Primitive ? T
    : T extends Date ? ReadonlyDate
    : T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends ReadonlySet<infer V> ? ReadonlySet<DeepReadonly<V>>
        : T extends (...args: infer _Args) => infer _Return ? T
          : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
            : T;

const mutationError = (kind: "Map" | "Set" | "Date", operation: PropertyKey): never => {
  throw new TypeError(`${kind}.${String(operation)} is disabled on a deeply immutable snapshot`);
};

/**
 * Build the read-only Proxy shared by `Map` and `Set` snapshots.
 *
 * ONE definition of the container-proxy protocol; `readonlyMap`/`readonlySet`
 * supply only what genuinely differs (which methods mutate, how `forEach`
 * re-dispatches, how entries are copied in). The four steps below are ORDER-
 * SENSITIVE, which is exactly why they should not be maintained twice:
 *
 *   1. Create the proxy and memoize it BEFORE populating, so a container that
 *      contains itself resolves to this proxy instead of recursing forever.
 *   2. Populate the target through `freeze`, so nested values are snapshots too.
 *   3. `Object.freeze` the target — the proxy blocks the mutator METHODS, this
 *      blocks direct property writes on the underlying container.
 *   4. Return the proxy, never the target.
 *
 * `forEach` is special-cased because the native implementation passes the RAW
 * container as the callback's third argument, handing callers an unfrozen
 * reference straight out of a "deeply immutable" snapshot. Every other method is
 * bound to the target so `this` is the real container rather than the proxy.
 */
const readonlyContainer = <C extends Map<unknown, unknown> | Set<unknown>>(
  source: C,
  spec: {
    readonly kind: "Map" | "Set";
    readonly empty: () => C;
    readonly mutators: ReadonlySet<string>;
    readonly forEach: (
      container: C,
      proxy: C,
      callback: (value: unknown, key: unknown, container: C) => void,
      thisArg: unknown,
    ) => void;
    readonly populate: (target: C, source: C) => void;
  },
  memo: WeakMap<object, unknown>,
): C => {
  const target = spec.empty();
  let proxy: C;
  proxy = new Proxy(target, {
    get(container, property) {
      if (typeof property === "string" && spec.mutators.has(property)) {
        return () => mutationError(spec.kind, property);
      }
      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, container: C) => void,
          thisArg?: unknown,
        ): void => spec.forEach(container as C, proxy, callback, thisArg);
      }
      const member = Reflect.get(container, property, container) as unknown;
      return typeof member === "function" ? member.bind(container) : member;
    },
  }) as C;
  memo.set(source, proxy);
  spec.populate(target, source);
  Object.freeze(target);
  return proxy;
};

const MAP_MUTATORS: ReadonlySet<string> = new Set(["set", "delete", "clear"]);
const SET_MUTATORS: ReadonlySet<string> = new Set(["add", "delete", "clear"]);

const readonlyMap = (
  source: Map<unknown, unknown>,
  freeze: (value: unknown) => unknown,
  memo: WeakMap<object, unknown>,
): Map<unknown, unknown> =>
  readonlyContainer(
    source,
    {
      kind: "Map",
      empty: () => new Map<unknown, unknown>(),
      mutators: MAP_MUTATORS,
      forEach: (map, proxy, callback, thisArg) => {
        map.forEach((value, key) => callback.call(thisArg, value, key, proxy));
      },
      populate: (target, from) => {
        for (const [key, value] of from) target.set(freeze(key), freeze(value));
      },
    },
    memo,
  );

const readonlySet = (
  source: Set<unknown>,
  freeze: (value: unknown) => unknown,
  memo: WeakMap<object, unknown>,
): Set<unknown> =>
  readonlyContainer(
    source,
    {
      kind: "Set",
      empty: () => new Set<unknown>(),
      mutators: SET_MUTATORS,
      // A Set's forEach passes the value as BOTH value and key, matching the
      // native contract.
      forEach: (set, proxy, callback, thisArg) => {
        set.forEach((value) => callback.call(thisArg, value, value, proxy));
      },
      populate: (target, from) => {
        for (const value of from) target.add(freeze(value));
      },
    },
    memo,
  );

const readonlyDate = (source: Date, memo: WeakMap<object, unknown>): Date => {
  let proxy: Date;
  proxy = new Proxy(source, {
    get(date, property) {
      if (typeof property === "string" && property.startsWith("set")) {
        return () => mutationError("Date", property);
      }
      const member = Reflect.get(date, property, date) as unknown;
      return typeof member === "function" ? member.bind(date) : member;
    },
  });
  memo.set(source, proxy);
  Object.freeze(source);
  return proxy;
};

/**
 * Recursively make a detached structured value runtime-immutable.
 *
 * Repeated references and cycles preserve identity through `memo`. Plain
 * property descriptors are retained; only their value is replaced when a
 * nested Map/Set/Date needs a read-only proxy.
 */
export const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  const memo = new WeakMap<object, unknown>();

  const freeze = (current: unknown): unknown => {
    if (current === null || typeof current !== "object") return current;
    const known = memo.get(current);
    if (known !== undefined) return known;

    if (current instanceof Map) return readonlyMap(current, freeze, memo);
    if (current instanceof Set) return readonlySet(current, freeze, memo);
    if (current instanceof Date) return readonlyDate(current, memo);

    memo.set(current, current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const frozenValue = freeze(descriptor.value);
      if (frozenValue !== descriptor.value) {
        Reflect.defineProperty(current, key, { ...descriptor, value: frozenValue });
      }
    }
    Object.freeze(current);
    return current;
  };

  return freeze(value) as DeepReadonly<T>;
};
