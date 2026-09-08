import type { MappedChildScope } from "../types/mapped-child-scope.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";

/** The root binds this runner only to children included in its preparation. */
export type ExecuteMappedChild = (
  input: unknown,
  scope: MappedChildScope,
) => Promise<Result<unknown, FrameworkError>>;

/** Root owns fan dispatch; a child owns only its scoped output address. */
export type ExecutionScope =
  | Readonly<{ kind: "root"; executeMappedChild: ExecuteMappedChild }>
  | Readonly<{ kind: "mapped-child"; scope: MappedChildScope }>;
