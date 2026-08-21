/**
 * Regression pin for the surviving critical `silent-failure-hunter-1`
 * (standalone review run `run.vtN26syQLu`): pipeline-fatal prompt loads
 * (synthesis / synthesis-system) MUST fail bootstrap loudly instead of
 * log-and-continue — a missing system prompt cannot be detected per-request
 * (the LLM node silently falls back to its generic default system prompt and
 * every /summarize completes 200 degraded). The post-hoc eval rubric stays
 * best-effort (log-and-continue).
 *
 * `loadAppPrompts` is the extracted bootstrap seam (cf. `setUpTracing`), so
 * these tests exercise the fatal-vs-best-effort contract with a plain-object
 * `PromptRegistry` fake — no Redis/LLM/server, no mocks.
 */
import { describe, it, expect } from "bun:test";
import { ok, err, type PromptRegistry, type PromptEntry, type FrameworkError } from "@fuguejs/framework";
import { loadAppPrompts } from "../bootstrap.js";
import type { AppLogger } from "../logger.js";

const entry = (text: string): PromptEntry => ({ text, hash: "h", version: "1" });

const promptNotFound = (promptName: string, reason: string): FrameworkError => ({
  kind: "prompt-not-found",
  promptName,
  reason,
});

/** Plain-object port fake: per-name ok/err table. */
const fakeRegistry = (
  entries: Record<string, string>,
  failures: Record<string, FrameworkError> = {},
): PromptRegistry => ({
  load: async (name) => {
    const failure = failures[name];
    if (failure !== undefined) return err(failure);
    const text = entries[name];
    if (text === undefined) return err(promptNotFound(name, "file not found"));
    return ok(entry(text));
  },
});

const recordingLogger = (): { log: AppLogger; warnings: string[] } => {
  const warnings: string[] = [];
  return {
    warnings,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string) => { warnings.push(msg); },
      error: () => undefined,
    },
  };
};

const allPrompts: Record<string, string> = {
  synthesis: "Summarize {{customerId}}",
  "synthesis-system": "You are the synthesis system.",
  "summary-eval-rubric": "Rubric",
};

describe("loadAppPrompts (surviving critical silent-failure-hunter-1)", () => {
  it("all loads ok → the map carries all three texts", async () => {
    const { log } = recordingLogger();
    const prompts = await loadAppPrompts(fakeRegistry(allPrompts), log);
    expect(prompts.get("synthesis")).toBe(allPrompts.synthesis);
    expect(prompts.get("synthesis-system")).toBe(allPrompts["synthesis-system"]);
    expect(prompts.get("summary-eval-rubric")).toBe(allPrompts["summary-eval-rubric"]);
  });

  it("synthesis load failure → rejects, naming the prompt and the registry reason (fail bootstrap loudly)", async () => {
    const { log } = recordingLogger();
    await expect(
      loadAppPrompts(fakeRegistry(allPrompts, { synthesis: promptNotFound("synthesis", "file not found") }), log),
    ).rejects.toThrow('Required prompt "synthesis" failed to load — file not found');
  });

  it("synthesis-system load failure → rejects, naming the prompt and the registry reason", async () => {
    const { log } = recordingLogger();
    await expect(
      loadAppPrompts(
        fakeRegistry(allPrompts, { "synthesis-system": promptNotFound("synthesis-system", "hash mismatch — prompt edited without version bump") }),
        log,
      ),
    ).rejects.toThrow('Required prompt "synthesis-system" failed to load — hash mismatch — prompt edited without version bump');
  });

  it("rubric load failure → degrades: resolves with both fatal prompts present and a warning", async () => {
    const { log, warnings } = recordingLogger();
    const prompts = await loadAppPrompts(
      fakeRegistry(
        { synthesis: allPrompts.synthesis, "synthesis-system": allPrompts["synthesis-system"] },
        { "summary-eval-rubric": promptNotFound("summary-eval-rubric", "registry file does not exist") },
      ),
      log,
    );
    expect(prompts.get("synthesis")).toBe(allPrompts.synthesis);
    expect(prompts.get("synthesis-system")).toBe(allPrompts["synthesis-system"]);
    expect(prompts.has("summary-eval-rubric")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("summary-eval-rubric");
  });
});
