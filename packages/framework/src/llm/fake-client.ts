import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
} from "./client.js";
import type { NodeContext } from "../types/node.js";
import { ensureToolNames } from "./tools.js";
import {
  dispatchToolCallsWithSpans,
  type ToolCall,
  type ToolDispatchResult,
} from "./tool-dispatch.js";
import { withLlmSpan, setLlmUsageAttributes } from "./spans.js";

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

/**
 * One scripted turn of `sendWithTools`. Either the model emits tool calls
 * (which the loop dispatches and feeds back), or it emits a final answer
 * which is parsed against `req.schema`.
 */
export type FakeToolUseTurn = {
  readonly type: "tool_use";
  readonly calls: readonly ToolCall[];
  readonly tokensIn?: number;
  readonly tokensOut?: number;
};

export type FakeFinalTurn = {
  readonly type: "final";
  /** Final answer object — JSON-stringified into `rawText`, parsed by the loop. */
  readonly content: unknown;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly thinking?: string;
};

export type FakeTurn = FakeToolUseTurn | FakeFinalTurn;

export interface FakeWithToolsTurnContext {
  readonly turn: number;
  readonly toolResults: readonly ToolDispatchResult[];
}

export type FakeWithToolsScript =
  | readonly FakeTurn[]
  | ((
      req: SendWithToolsRequest<any>,
      ctx: FakeWithToolsTurnContext,
    ) => FakeTurn);

export interface FakeLlmClientOpts {
  /**
   * Per-call script for `sendWithTools`. If an array, plays back in order;
   * if a function, called once per turn with the prior tool results.
   */
  readonly withToolsScript?: FakeWithToolsScript;
}

export class FakeLlmClient implements LlmClient {
  private readonly responses: FakeResponseProvider;
  private readonly withToolsScript: FakeWithToolsScript | undefined;

  constructor(
    responses: FakeResponseProvider,
    opts?: FakeLlmClientOpts,
  ) {
    this.responses = responses;
    this.withToolsScript = opts?.withToolsScript;
  }

  async sendStructured<O>(
    req: LlmRequest<O>,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> {
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

  async sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> {
    if (this.withToolsScript === undefined) {
      return err({
        kind: "node-crash",
        nodeId: req.model,
        message: "FakeLlmClient: no withToolsScript configured",
      });
    }

    try {
      ensureToolNames(req.tools);
    } catch (e) {
      return err({
        kind: "validation",
        nodeId: req.model,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    const maxIterations = req.maxIterations ?? 10;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastThinking: string | undefined;
    let lastToolResults: readonly ToolDispatchResult[] = [];
    const arrayScript = Array.isArray(this.withToolsScript)
      ? (this.withToolsScript as readonly FakeTurn[])
      : null;

    for (let turn = 0; turn < maxIterations; turn++) {
      if (req.signal?.aborted) {
        return err({ kind: "aborted", reason: "signal" });
      }

      const turnSpec: FakeTurn | undefined = arrayScript
        ? arrayScript[turn]
        : (this.withToolsScript as Exclude<FakeWithToolsScript, readonly FakeTurn[]>)(
            req,
            { turn, toolResults: lastToolResults },
          );

      if (!turnSpec) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `FakeLlmClient: script ran out at turn ${turn}`,
        });
      }

      const tokensIn = turnSpec.tokensIn ?? 10;
      const tokensOut = turnSpec.tokensOut ?? 5;

      await withLlmSpan(
        ctx.tracer ?? null,
        { provider: "fake", model: req.model, operation: "chat" },
        async () => {
          totalTokensIn += tokensIn;
          totalTokensOut += tokensOut;
          setLlmUsageAttributes(tokensIn, tokensOut);
        },
      );

      if (turnSpec.type === "final") {
        if (turnSpec.thinking !== undefined) lastThinking = turnSpec.thinking;
        const parsed = req.schema.safeParse(turnSpec.content);
        if (!parsed.success) {
          return err({
            kind: "node-crash",
            nodeId: req.model,
            message: `Schema validation failed: ${parsed.error.message}`,
          });
        }
        return ok({
          output: parsed.data as O,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          thinking: lastThinking,
          rawText: JSON.stringify(turnSpec.content),
        });
      }

      // tool_use turn — dispatch all calls in parallel.
      // toolChoice = "none" disables tools entirely.
      if (req.toolChoice === "none") {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: "FakeLlmClient: tool_use turn emitted while toolChoice='none'",
        });
      }

      lastToolResults = await dispatchToolCallsWithSpans(
        turnSpec.calls,
        req.tools,
        ctx,
      );
    }

    return err({
      kind: "transient",
      message: `Tool-call iteration limit (${maxIterations}) reached`,
    });
  }
}
