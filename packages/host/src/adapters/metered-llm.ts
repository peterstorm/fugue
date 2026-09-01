/**
 * Narrow run-scoped `LlmClient` decorator.
 *
 * All mutable accounting, enforcement, logging, and ledger sequencing live in
 * the shared `RunSpendAuthority`; this module exposes only the two standard
 * provider operations and delegates both through that authority. It deliberately
 * does not proxy subtype methods: an augmented capability declares aliases in
 * `CapabilityHandle.runScopedOperations`, and the host binds them to this
 * metered surface so provider aliases cannot self-call behind the budget gate.
 */

import type {
  Capability,
  FrameworkError,
  LlmClient,
  LlmPricingModel,
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
  pricingModel: LlmPricingModel,
): LlmClient => Object.freeze({
  sendStructured: <O>(
    req: LlmRequest<O>,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
    authority.execute({
      clientKey,
      operation: "sendStructured",
      pricingModel,
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
      pricingModel,
      request: req,
      call: () => inner.sendWithTools(req, ctx),
    }),
});
