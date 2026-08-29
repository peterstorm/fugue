/**
 * Transparent LlmClient decorator. All mutable accounting, enforcement,
 * logging, and ledger sequencing live in the shared `RunSpendAuthority`; this
 * module only adapts the two client operations to that deep interface.
 */

import type {
  Capability,
  FrameworkError,
  LlmClient,
  LlmRequest,
  LlmResponse,
  NodeContext,
  Result,
  SendWithToolsRequest,
} from "@fuguejs/framework";
import type { RunSpendAuthority } from "./run-spend-authority.js";

export const createMeteredLlm = (
  inner: LlmClient,
  clientKey: Capability,
  authority: RunSpendAuthority,
): LlmClient => ({
  sendStructured: <O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> =>
    authority.execute({
      clientKey,
      operation: "sendStructured",
      request: req,
      call: () => inner.sendStructured(req),
    }),

  sendWithTools: <O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
    authority.execute({
      clientKey,
      operation: "sendWithTools",
      request: req,
      call: () => inner.sendWithTools(req, ctx),
    }),
});
