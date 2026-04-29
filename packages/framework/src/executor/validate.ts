import type { z } from "zod";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";

export const validateInput = <T>(
  schema: z.ZodType<T>,
  data: unknown,
  nodeId: string,
): Result<T, FrameworkError> => validate(schema, data, nodeId, "input");

export const validateOutput = <T>(
  schema: z.ZodType<T>,
  data: unknown,
  nodeId: string,
): Result<T, FrameworkError> => validate(schema, data, nodeId, "output");

const validate = <T>(
  schema: z.ZodType<T>,
  data: unknown,
  nodeId: string,
  direction: string,
): Result<T, FrameworkError> => {
  const result = schema.safeParse(data);
  if (result.success) {
    return ok(result.data as T);
  }
  return err({
    kind: "validation" as const,
    nodeId,
    message: `${direction} validation failed: ${JSON.stringify(result.error.issues ?? result.error)}`,
  });
};
