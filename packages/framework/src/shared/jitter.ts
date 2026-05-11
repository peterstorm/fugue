// Symmetric jitter applied to a backoff delay.
//
// Wave 7 §7.6 extracted this from `dag-runtime/executor.ts` and changed two
// things:
//
//   1. Symmetric jitter around the base delay (`±jitterRatio`) instead of the
//      previous always-positive bias. The old form `baseDelay * (1 + ratio *
//      random())` added 0..ratio×delay extra time; the new form
//      `baseDelay * (1 + (2·random()-1) * ratio)` is true random jitter.
//
//   2. The RNG is an explicit argument. Production callers pass `Math.random`;
//      tests can pass a seeded deterministic source.

export const applyJitter = (
  delayMs: number,
  jitterRatio: number,
  random: () => number,
): number => {
  const jitter = (random() * 2 - 1) * jitterRatio;
  return Math.round(delayMs * (1 + jitter));
};
