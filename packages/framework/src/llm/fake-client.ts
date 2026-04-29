import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.js";

export type FakeResponseProvider =
  | Map<string, unknown | FrameworkError>
  | ((req: LlmRequest<any>) => unknown | FrameworkError);

function isFrameworkError(value: unknown): value is FrameworkError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as any).kind === "string"
  );
}

export class FakeLlmClient implements LlmClient {
  constructor(private readonly responses: FakeResponseProvider) {}

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    const raw = this.responses instanceof Map
      ? this.responses.get(req.model) ?? this.responses.get(req.system)
      : this.responses(req);

    if (raw === undefined) {
      return err({
        kind: "node-crash",
        nodeId: req.model,
        message: `FakeLlmClient: no response configured for model="${req.model}"`,
      });
    }

    if (isFrameworkError(raw)) {
      return err(raw);
    }

    return ok({
      output: raw as O,
      tokensIn: 100,
      tokensOut: 50,
      rawText: JSON.stringify(raw),
    });
  }
}
