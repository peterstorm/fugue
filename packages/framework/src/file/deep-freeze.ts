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

const readonlyMap = (
  source: Map<unknown, unknown>,
  freeze: (value: unknown) => unknown,
  memo: WeakMap<object, unknown>,
): Map<unknown, unknown> => {
  const target = new Map<unknown, unknown>();
  let proxy: Map<unknown, unknown>;
  proxy = new Proxy(target, {
    get(map, property) {
      if (property === "set" || property === "delete" || property === "clear") {
        return () => mutationError("Map", property);
      }
      if (property === "forEach") {
        return (callback: (value: unknown, key: unknown, map: Map<unknown, unknown>) => void, thisArg?: unknown): void => {
          map.forEach((value, key) => callback.call(thisArg, value, key, proxy));
        };
      }
      const member = Reflect.get(map, property, map) as unknown;
      return typeof member === "function" ? member.bind(map) : member;
    },
  });
  memo.set(source, proxy);
  for (const [key, value] of source) target.set(freeze(key), freeze(value));
  Object.freeze(target);
  return proxy;
};

const readonlySet = (
  source: Set<unknown>,
  freeze: (value: unknown) => unknown,
  memo: WeakMap<object, unknown>,
): Set<unknown> => {
  const target = new Set<unknown>();
  let proxy: Set<unknown>;
  proxy = new Proxy(target, {
    get(set, property) {
      if (property === "add" || property === "delete" || property === "clear") {
        return () => mutationError("Set", property);
      }
      if (property === "forEach") {
        return (callback: (value: unknown, key: unknown, set: Set<unknown>) => void, thisArg?: unknown): void => {
          set.forEach((value) => callback.call(thisArg, value, value, proxy));
        };
      }
      const member = Reflect.get(set, property, set) as unknown;
      return typeof member === "function" ? member.bind(set) : member;
    },
  });
  memo.set(source, proxy);
  for (const value of source) target.add(freeze(value));
  Object.freeze(target);
  return proxy;
};

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
