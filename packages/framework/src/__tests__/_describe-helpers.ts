// Shared describe fixture helpers for tests that build described DAGs.
//
// Usage:
//   import { inertWarningSink } from "./_describe-helpers.js";
//
// `warningSink` is a required describe input so a degraded schema is always
// observable somewhere; fixtures that do not assert on warnings pass the
// inert sink rather than omitting the diagnostic channel.
import type { DescribeWarningSink } from "../describe/build-described-dag.js";

export const inertWarningSink: DescribeWarningSink = {
  onSchemaSerializationError: () => {},
};
