/**
 * The one fake for `RedisCheckpointerDriver`, shared by every Redis
 * checkpointer test that does not talk to a real server.
 *
 * Before the port existed, each fake was a partial object literal forced past
 * the compiler with `as never` / `as unknown as Redis`, so nothing checked that
 * a fake's methods matched how the adapter calls the driver — a fake taking
 * `evalsha`'s arguments in the wrong order type-checked fine and its test still
 * passed. Overrides here are checked against the port instead.
 *
 * What a test does NOT override is still part of its assertion, and now says so
 * out loud: every unlisted method throws naming itself, so an adapter that
 * reaches a call the path should not reach fails with
 * `RedisCheckpointer called eval, which this test does not expect` rather than
 * `undefined is not a function`. Tests that assert "no write was issued" rely on
 * this, so nothing here may be given a silent default.
 */

import type { RedisCheckpointerDriver } from "../checkpoint/redis-checkpointer.js";

const unexpected =
  (method: keyof RedisCheckpointerDriver) =>
  async (): Promise<never> => {
    throw new Error(
      `RedisCheckpointer called ${method}, which this test does not expect`,
    );
  };

export const redisDriverFake = (
  overrides: Partial<RedisCheckpointerDriver> = {},
): RedisCheckpointerDriver => ({
  get: unexpected("get"),
  set: unexpected("set"),
  hgetall: unexpected("hgetall"),
  script: unexpected("script"),
  evalsha: unexpected("evalsha"),
  eval: unexpected("eval"),
  ...overrides,
});
