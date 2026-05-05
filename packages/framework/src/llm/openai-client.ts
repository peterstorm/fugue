import OpenAI from "openai";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.js";

/**
 * Recursively adds `additionalProperties: false` to all object-type schemas.
 * Required by Azure OpenAI structured output (strict mode).
 * Zod v4's toJSONSchema already adds it at the top level but not always nested.
 */
function addAdditionalPropertiesFalse(schema: Record<string, unknown>): void {
  if (schema.type === "object" && schema.properties) {
    schema.additionalProperties = false;
    for (const prop of Object.values(schema.properties as Record<string, Record<string, unknown>>)) {
      if (prop && typeof prop === "object") {
        addAdditionalPropertiesFalse(prop);
      }
    }
  }
  if (schema.items && typeof schema.items === "object") {
    addAdditionalPropertiesFalse(schema.items as Record<string, unknown>);
  }
}

export class OpenAILlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly openai: OpenAI, opts?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 120_000;
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    try {
      const schema = z.toJSONSchema(req.schema as any) as Record<string, unknown>;
      // Remove $schema key — OpenAI/Azure don't want it
      delete schema.$schema;
      // Ensure additionalProperties: false everywhere for Azure strict mode
      addAdditionalPropertiesFalse(schema);

      const params: any = {
        model: req.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "structured_output",
            strict: true,
            schema: schema as Record<string, unknown>,
          },
        },
      };

      // Enable reasoning for models that support it (e.g., gpt-5.1)
      if (req.thinking?.type === "enabled") {
        params.reasoning = { effort: "medium" };
      }

      const response = await this.openai.chat.completions.create(
        params,
        { signal: AbortSignal.timeout(this.requestTimeoutMs) },
      );

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: "OpenAI response contained no content",
        });
      }

      const rawText = choice.message.content;

      // Extract reasoning content if present (GPT-5.1, o-series models)
      const thinking = (choice.message as any).reasoning_content ?? undefined;

      // Parse JSON
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `OpenAI response was not valid JSON: ${rawText.slice(0, 200)}`,
        });
      }

      // Validate with zod
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `Schema validation failed: ${parsed.error.message}`,
        });
      }

      const tokensIn = response.usage?.prompt_tokens ?? 0;
      const tokensOut = response.usage?.completion_tokens ?? 0;

      return ok({
        output: parsed.data as O,
        tokensIn,
        tokensOut,
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
