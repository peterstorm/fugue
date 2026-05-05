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

/**
 * OpenAI LLM client using the Responses API (/openai/responses).
 * Works with all models (gpt-4o-mini, gpt-5-mini, gpt-5.2-codex) and
 * provides native reasoning support on capable models.
 */
export class OpenAILlmClient implements LlmClient {
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: string | undefined;

  constructor(private readonly openai: OpenAI, opts?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 120_000;
    this.baseUrl = (openai as any).baseURL ?? (openai as any)._options?.baseURL ?? "";
    this.apiKey = (openai as any).apiKey ?? (openai as any)._options?.apiKey ?? "";
    this.apiVersion = (openai as any)._options?.defaultQuery?.["api-version"] ?? undefined;
  }

  private buildRequestConfig(): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url: string;
    if (this.apiVersion) {
      const base = this.baseUrl.replace(/\/openai(\/deployments\/[^/]+)?$/, "");
      url = `${base}/openai/responses?api-version=${this.apiVersion}`;
      headers["api-key"] = this.apiKey;
    } else {
      url = `${this.baseUrl}/responses`;
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return { url, headers };
  }

  async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
    try {
      const schema = z.toJSONSchema(req.schema as any) as Record<string, unknown>;
      delete schema.$schema;
      addAdditionalPropertiesFalse(schema);

      // Build Responses API request body
      const body: Record<string, unknown> = {
        model: req.model,
        input: [
          { role: "developer", content: req.system },
          { role: "user", content: req.user },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "structured_output",
            strict: true,
            schema,
          },
        },
      };

      // Configure reasoning effort
      if (req.thinking?.type === "enabled") {
        body.reasoning = { effort: "high", summary: "auto" };
      }

      const { url, headers } = this.buildRequestConfig();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      const httpRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!httpRes.ok) {
        const errBody = await httpRes.text();
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `${httpRes.status} ${errBody}`,
        });
      }

      const response: any = await httpRes.json();

      // Extract text content from output blocks
      const messageBlock = response.output?.find((b: any) => b.type === "message");
      const textContent = messageBlock?.content?.find((c: any) => c.type === "output_text");
      const rawText = textContent?.text ?? "";

      if (!rawText) {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: "Responses API returned no text output",
        });
      }

      // Extract reasoning summary if present
      const reasoningBlock = response.output?.find((b: any) => b.type === "reasoning");
      const thinking = reasoningBlock?.summary?.length
        ? reasoningBlock.summary.map((s: any) => s.text ?? s).join("\n")
        : undefined;

      // Parse JSON
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        return err({
          kind: "node-crash",
          nodeId: req.model,
          message: `Response was not valid JSON: ${rawText.slice(0, 200)}`,
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

      const tokensIn = response.usage?.input_tokens ?? 0;
      const tokensOut = response.usage?.output_tokens ?? 0;

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
