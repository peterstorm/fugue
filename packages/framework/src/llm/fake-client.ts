import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError } from "../types/errors.js";
import { safeErrorMessage } from "../types/safe-error.js";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
} from "../types/llm.js";
import type { NodeContext } from "../types/node.js";
import { ensureToolNames } from "./tools.js";
import {
  dispatchToolCallsWithSpans,
  type ToolCall,
  type ToolDispatchResult,
} from "./tool-dispatch.js";
import {
  withLlmSpan,
  setLlmUsageAttributes,
  setLlmResponseAttributes,
} from "./spans.js";

/**
 * Scripted response source for `FakeLlmClient`.
 *
 * Map resolution order (documented here; pinned by the Map-lookup test):
 * `responses.get(req.model) ?? responses.get(req.system)` — the model key
 * wins when present, otherwise the system-prompt key is the fallback.
 *
 * The seam is SYNCHRONOUS: the payload type is `unknown`-wide, so an
 * accidentally-`async` function type-checks, and a returned Promise would
 * stringify to `"{}"` — silently resolving an empty response. Thenables are
 * therefore rejected with a typed node-crash at the seam (pinned in
 * `llm-fake-client.test.ts`); return the value directly instead.
 */
export type FakeResponseProvider =
  | Map<string, unknown | FrameworkError>
  | ((req: LlmRequest<any>) => unknown | FrameworkError);

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
  readonly responseId?: string;
  readonly responseModel?: string;
  readonly finishReason?: string;
};

export type FakeFinalTurn = {
  readonly type: "final";
  /** Final answer object — JSON-stringified into `rawText`, parsed by the loop. */
  readonly content: unknown;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly thinking?: string;
  readonly responseId?: string;
  readonly responseModel?: string;
  readonly finishReason?: string;
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

/**
 * Synchronous-seam guard: the provider/script return types are wide enough
 * that an accidentally-`async` function type-checks, and a thenable payload
 * must fail LOUDLY — `JSON.stringify(promise)` is `"{}"`, which would
 * silently resolve an empty (wrong) response. Total on hostile values: only
 * an object whose `then` read SUCCEEDS and is a function is thenable. A
 * throwing `then` getter or Proxy `get` trap makes the probe catch instead
 * of reject — the value is then not a thenable, and it flows into the
 * existing JSON-serialization guard, where the re-read of `then` throws and
 * becomes a typed node-crash (never a raw rejection across the LlmClient
 * port, FR-040 — parity with the real clients).
 */
const isThenable = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    // A throwing `then` getter / Proxy `get` trap is not a thenable — the
    // trap is swallowed here (NOT rejected raw) and the value fails at the
    // JSON-serialization guard instead, where the re-read throws into the
    // typed crash builder.
    return false;
  }
};

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
    // One encoding for this method's guarded seams: the deterministic
    // retriable node-crash bound to `req.nodeId` (the deliberate
    // non-retriable iteration-limit site in `sendWithTools` stays explicit
    // instead of hiding in the builder).
    const crash = (message: string) => ({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: req.nodeId,
      message,
    }) as const;
    // The response provider is caller code (and possibly a hostile Proxy): a
    // throw must become a typed node-crash, never a raw rejection (FR-040 —
    // the real clients keep every LLM seam inside the Result boundary).
    let raw: unknown;
    try {
      raw = this.responses instanceof Map
        ? this.responses.get(req.model) ?? this.responses.get(req.system)
        : this.responses(req);
    } catch (error) {
      return err(crash(`FakeLlmClient: response provider threw: ${safeErrorMessage(error)}`));
    }

    if (raw === undefined) {
      return err(crash(`FakeLlmClient: no response configured for model="${req.model}"`));
    }

    if (isFrameworkError(raw)) {
      return err(raw);
    }

    // Synchronous seam: a thenable response (accidentally-`async` provider)
    // would stringify to "{}" and silently resolve an empty response — reject
    // it loudly with the typed crash instead.
    if (isThenable(raw)) {
      return err(
        crash(
          "FakeLlmClient: response provider returned a Promise — the provider seam is synchronous; return the value directly instead of an async provider",
        ),
      );
    }

    let rawText: string;
    try {
      rawText = JSON.stringify(raw);
    } catch (error) {
      return err(crash(`FakeLlmClient: response is not JSON-serializable: ${safeErrorMessage(error)}`));
    }

    return ok({
      output: raw as O,
      tokensIn: 100,
      tokensOut: 50,
      rawText,
    });
  }

  async sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> {
    // One encoding for this method's guarded seams (see the twin builder in
    // `sendStructured`): deterministic retriable node-crash bound to
    // `req.nodeId`; the non-retriable iteration-limit exit below stays
    // explicit as the deliberate exception.
    const crash = (message: string) => ({
      kind: "node-crash",
      retriability: "retriable",
      nodeId: req.nodeId,
      message,
    }) as const;
    if (this.withToolsScript === undefined) {
      return err(crash("FakeLlmClient: no withToolsScript configured"));
    }

    try {
      ensureToolNames(req.tools);
    } catch (e) {
      return err({
        kind: "validation",
        nodeId: req.nodeId,
        message: safeErrorMessage(e),
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
      if (req.signal?.aborted || ctx.signal?.aborted) {
        return err({ kind: "aborted", reason: "signal" });
      }

      // The script is caller code: a throw must become a typed node-crash
      // (the real clients map script/tool-dispatch failures into the typed
      // node-crash machinery; the fake must not green-light raw rejections).
      let turnSpec: FakeTurn | undefined;
      try {
        turnSpec = arrayScript
          ? arrayScript[turn]
          : (this.withToolsScript as Exclude<FakeWithToolsScript, readonly FakeTurn[]>)(
              req,
              { turn, toolResults: lastToolResults },
            );
      } catch (error) {
        return err(
          crash(`FakeLlmClient: withToolsScript threw at turn ${turn}: ${safeErrorMessage(error)}`),
        );
      }

      if (!turnSpec) {
        return err(crash(`FakeLlmClient: script ran out at turn ${turn}`));
      }

      // Synchronous seam (parity with the `sendStructured` guard): an
      // accidentally-`async` script function returns a Promise, which would
      // fall through as a truthy turn with no `type`/`calls` and misattribute
      // the failure deep in tool dispatch — reject it loudly instead.
      if (isThenable(turnSpec)) {
        return err(
          crash(
            `FakeLlmClient: withToolsScript returned a Promise at turn ${turn} — the script seam is synchronous; return the turn directly instead of an async function`,
          ),
        );
      }

      // The returned turn is caller data: a value whose property reads throw
      // (hostile getter / Proxy `get` trap) must fail here as a typed
      // node-crash, not reject raw when the loop below reads its fields
      // (FR-040 — the `sendStructured` twin's post-probe observations are
      // total/guarded; this seam's field reads were the remaining raw hole).
      let turnType: FakeTurn["type"] | undefined;
      let turnThinking: string | undefined;
      let tokensIn: number;
      let tokensOut: number;
      try {
        turnType = turnSpec.type;
        // `thinking` is final-turn-only on the union; read it through the
        // shared optional shape — it is `undefined` on tool_use turns by
        // construction, and this read is what keeps a hostile getter on the
        // field inside the guarded block.
        turnThinking = (turnSpec as { thinking?: string }).thinking;
        tokensIn = turnSpec.tokensIn ?? 10;
        tokensOut = turnSpec.tokensOut ?? 5;
      } catch (error) {
        return err(
          crash(
            `FakeLlmClient: withToolsScript returned a turn with unreadable fields at turn ${turn}: ${safeErrorMessage(error)}`,
          ),
        );
      }

      try {
        await withLlmSpan(
          ctx.tracer ?? null,
          { provider: "fake", model: req.model, operation: "chat" },
          async () => {
            totalTokensIn += tokensIn;
            totalTokensOut += tokensOut;
            setLlmUsageAttributes(tokensIn, tokensOut);
            if (
              turnSpec.responseId ||
              turnSpec.responseModel ||
              turnSpec.finishReason
            ) {
              setLlmResponseAttributes({
                model: turnSpec.responseModel,
                id: turnSpec.responseId,
                finishReasons: turnSpec.finishReason ? [turnSpec.finishReason] : undefined,
              });
            }
          },
        );
      } catch (error) {
        // A hostile tracer must not escape the Result boundary.
        return err(crash(`FakeLlmClient: span/tracer threw at turn ${turn}: ${safeErrorMessage(error)}`));
      }

      if (turnType === "final") {
        // The snapshot proved the discriminant (`type === "final"`); recover
        // the narrowed union arm for the payload reads below (every read
        // stays inside the guarded FR-040 region).
        const finalTurn = turnSpec as FakeFinalTurn;
        if (turnThinking !== undefined) lastThinking = turnThinking;
        // FR-040: the final payload is hostile until proven otherwise. A
        // throwing getter during `safeParse`, or `JSON.stringify` on
        // cyclic/BigInt content accepted by an `unknown`-typed schema arm,
        // must become a typed node-crash — never a raw rejection across the
        // LlmClient port (parity with the `sendStructured`-path guard).
        try {
          const parsed = req.schema.safeParse(finalTurn.content);
          if (!parsed.success) {
            return err(crash(`Schema validation failed: ${parsed.error.message}`));
          }
          let rawText: string;
          try {
            rawText = JSON.stringify(finalTurn.content);
          } catch (error) {
            return err(crash(`FakeLlmClient: final content is not JSON-serializable: ${safeErrorMessage(error)}`));
          }
          return ok({
            output: parsed.data as O,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            thinking: lastThinking,
            rawText,
          });
        } catch (error) {
          return err(crash(`FakeLlmClient: schema validation threw at final turn: ${safeErrorMessage(error)}`));
        }
      }

      // tool_use turn — dispatch all calls in parallel.
      // toolChoice = "none" disables tools entirely.
      if (req.toolChoice === "none") {
        return err(crash("FakeLlmClient: tool_use turn emitted while toolChoice='none'"));
      }

      // The snapshot discriminant rules out `final`; recover the tool arm.
      const toolTurn = turnSpec as FakeToolUseTurn;
      try {
        lastToolResults = await dispatchToolCallsWithSpans(
          toolTurn.calls,
          req.tools,
          ctx,
          { model: req.model },
        );
      } catch (error) {
        // Tool EXECUTION failures are already per-call is_error results;
        // anything that throws here (dispatch seam, tracer) stays typed.
        return err(crash(`FakeLlmClient: tool dispatch threw at turn ${turn}: ${safeErrorMessage(error)}`));
      }
    }

    return err({
      kind: "node-crash",
      retriability: "non-retriable",
      nodeId: req.nodeId,
      message: `Tool-call iteration limit (${maxIterations}) reached`,
    });
  }
}
