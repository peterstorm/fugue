import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.js";

export class AnthropicLlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly anthropic: Anthropic, opts?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 120_000;
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    try {
      const jsonSchema = z.toJSONSchema(req.schema as any) as Record<string, unknown>;
      delete jsonSchema.$schema;
      const toolDef = {
        name: "structured_output",
        description: "Return the structured output",
        input_schema: jsonSchema as Anthropic.Tool["input_schema"],
      };

      const params: Anthropic.MessageCreateParams = {
        model: req.model,
        max_tokens: 16384,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [toolDef],
        tool_choice: { type: "tool", name: "structured_output" },
      };

      if (req.thinking) {
        // Anthropic extended thinking requires streaming; skip tool_choice forcing
        // For now, we keep the tool_use approach without extended thinking params
        // Extended thinking integration will be refined in a future task
      }

      const response = await this.anthropic.messages.create(params, { signal: AbortSignal.timeout(this.requestTimeoutMs) });

      // Extract thinking content if present
      const thinkingBlock = response.content.find((b) => b.type === "thinking");
      const thinking = thinkingBlock?.type === "thinking" ? thinkingBlock.thinking : undefined;

      // Extract tool use result
      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: "Anthropic response did not contain a tool_use block",
        });
      }

      // Parse with zod
      const parsed = req.schema.safeParse(toolUseBlock.input);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `Schema validation failed: ${parsed.error.message}`,
        });
      }

      const rawText = JSON.stringify(toolUseBlock.input);

      return ok({
        output: parsed.data as O,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        thinking,
        rawText,
      });
    } catch (error) {
      return err({
        kind: "node-crash",
        nodeId: req.model,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
