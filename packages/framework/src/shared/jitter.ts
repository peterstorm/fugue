// Symmetric jitter applied to a backoff delay.
//
//   1. Symmetric jitter around the base delay (`±jitterRatio`) — the form
//      `baseDelay * (1 + (2·random()-1) * ratio)` distributes evenly above
//      and below the base delay (vs. `baseDelay * (1 + ratio * random())`,
//      which only ever adds time).
//
//   2. The RNG is an explicit argument. Production callers pass `Math.random`;
//      tests pass a seeded deterministic source.

export const applyJitter = (
  delayMs: number,
  jitterRatio: number,
  random: () => number,
): number => {
  const jitter = (random() * 2 - 1) * jitterRatio;
  return Math.round(delayMs * (1 + jitter));
};
