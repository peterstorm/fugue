import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError } from "../types/errors.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { __brandNodeId, type NodeId } from "../types/ids.js";
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
 * `responses.has(req.model) ? responses.get(req.model) : responses.get(req.system)`
 * — the model key wins when OWNED by the Map, otherwise the system-prompt key
 * is the fallback. Ownership (`has`), not truthiness (`??`): a configured
 * `null` under the model key is a legal response — the function form can
 * express one (`(req) => null` round-trips to `ok({ output: null, … })`) — and
 * the Map form must not silently substitute the system-key fixture for it.
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

/**
 * Fabricated, grammar-valid node id for a node-crash whose request's own
 * `nodeId` read threw or was missing (hostile request object). Mirrors the
 * checkpoint-write-failed truthful-branding policy: a typed error always
 * carries a grammar-valid id and the message carries the true cause — never
 * a raw rejection (FR-040). The `llm_` namespace keeps the placeholder out of
 * the real-node id space for metering attribution.
 */
const UNKNOWN_NODE_ID: NodeId = __brandNodeId("llm_unknown_node");

/**
 * Total read of one field of a possibly-hostile request/context object. The
 * read is the seam: a throwing getter or Proxy `get` trap — and a missing
 * field — become `fallback`, never a raw throw (FR-040). `req`/`ctx` arrive
 * across the LlmClient port from caller (or test-fixture) code and are
 * hostile until proven otherwise; every unguarded field read is a
 * raw-rejection hole, and the `crash` builders are the sharpest of them —
 * they run from catch blocks, where a second throw would replace the typed
 * rejection with a raw one.
 */
const readHostileField = <T,>(host: object, key: string, fallback: T): T => {
  try {
    const value = Reflect.get(host, key);
    return value === undefined ? fallback : (value as T);
  } catch {
    return fallback;
  }
};

/**
 * Total per-turn abort probe: `signal` and `aborted` are each independently
 * hostile reads (a throwing getter on either must not reject raw, FR-040).
 * An unreadable or absent signal reads as NOT aborted — the probe is an
 * escape hatch for a live abort, and an unreadable state cannot claim one;
 * a broken fixture surfaces itself at the next guarded seam. Truthiness
 * matches the plain `signal?.aborted` semantics the port contract implies.
 */
const signalAborted = (host: object): boolean => {
  let signal: unknown;
  try {
    signal = Reflect.get(host, "signal");
  } catch {
    return false;
  }
  if (signal === null || typeof signal !== "object") return false;
  try {
    return Boolean(Reflect.get(signal, "aborted"));
  } catch {
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
    // FR-040 field reads of the hostile request: `nodeId` and `model` are
    // snapshotted under the total read ONCE (the `crash` builder and the
    // unguarded message sites below read the snapshots, never the request —
    // the builder runs from catch blocks, where a second throw would replace
    // the typed rejection with a raw one). `req.system` is read only inside
    // the provider guard below, so it needs no snapshot.
    const nodeId = readHostileField(req, "nodeId", UNKNOWN_NODE_ID);
    const model = readHostileField(req, "model", "");
    // One encoding for this method's guarded seams: the deterministic
    // retriable node-crash bound to the request's node id (the deliberate
    // non-retriable iteration-limit site in `sendWithTools` stays explicit
    // instead of hiding in the builder).
    const crash = (message: string) => ({
      kind: "node-crash",
      retriability: "retriable",
      nodeId,
      message,
    }) as const;
    // The response provider is caller code (and possibly a hostile Proxy): a
    // throw must become a typed node-crash, never a raw rejection (FR-040 —
    // the real clients keep every LLM seam inside the Result boundary).
    let raw: unknown;
    try {
      raw = this.responses instanceof Map
        ? this.responses.has(model)
          ? this.responses.get(model)
          : this.responses.get(req.system)
        : this.responses(req);
    } catch (error) {
      return err(crash(`FakeLlmClient: response provider threw: ${safeErrorMessage(error)}`));
    }

    if (raw === undefined) {
      return err(crash(`FakeLlmClient: no response configured for model="${model}"`));
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

    // The declared schema IS the contract of `O` (parity with the
    // `withTools` final-turn seam, where the check runs BEFORE
    // serialization): a fixture violating it must fail here with a typed
    // node-crash, not silently pass the `raw as O` cast — the cast is
    // uncheckable across the `unknown` seam, so the fake validates exactly
    // what the real clients' response contract would have enforced.
    let output: O;
    try {
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        return err(crash(`Schema validation failed: ${parsed.error.message}`));
      }
      output = parsed.data as O;
    } catch (error) {
      return err(crash(`FakeLlmClient: schema validation threw: ${safeErrorMessage(error)}`));
    }

    // `rawText` is the raw payload as the provider emitted it (provenance —
    // not a serialization of the parsed output), exactly as the withTools
    // final-turn seam records `finalTurn.content`.
    let rawText: string;
    try {
      rawText = JSON.stringify(raw);
    } catch (error) {
      return err(crash(`FakeLlmClient: response is not JSON-serializable: ${safeErrorMessage(error)}`));
    }

    return ok({
      output,
      tokensIn: 100,
      tokensOut: 50,
      rawText,
    });
  }

  async sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> {
    // FR-040 field reads of the hostile request: `nodeId` is snapshotted
    // under the total read ONCE (the `crash` builder, the validation exit,
    // and the iteration-limit exit all read the snapshot, never the request
    // — the builder runs from catch blocks, where a second throw would
    // replace the typed rejection with a raw one); `maxIterations` is
    // snapshotted at the same seam (an unreadable limit keeps the default).
    // Per-turn live reads (signal, toolChoice) stay per turn but go through
    // total probes; `req.tools`/`req.schema`/`req.model` are read only inside
    // guarded regions below and need no snapshot.
    const nodeId = readHostileField(req, "nodeId", UNKNOWN_NODE_ID);
    const maxIterations = readHostileField(req, "maxIterations", undefined) ?? 10;
    // One encoding for this method's guarded seams (see the twin builder in
    // `sendStructured`): deterministic retriable node-crash bound to the
    // request's node id; the non-retriable iteration-limit exit below stays
    // explicit as the deliberate exception.
    const crash = (message: string) => ({
      kind: "node-crash",
      retriability: "retriable",
      nodeId,
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
        nodeId,
        message: safeErrorMessage(e),
      });
    }

    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastThinking: string | undefined;
    let lastToolResults: readonly ToolDispatchResult[] = [];
    const arrayScript = Array.isArray(this.withToolsScript)
      ? (this.withToolsScript as readonly FakeTurn[])
      : null;

    for (let turn = 0; turn < maxIterations; turn++) {
      // Live per-turn probe through the total reads: a throwing `signal`
      // getter on either side cannot reject raw (FR-040).
      if (signalAborted(req) || signalAborted(ctx)) {
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
      if (readHostileField(req, "toolChoice", undefined) === "none") {
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
      nodeId,
      message: `Tool-call iteration limit (${maxIterations}) reached`,
    });
  }
}
