/**
 * Boot-time HITL notifier transport selection (host.ts
 * `selectHitlNotifierTransport`, architecture-tech-lead-1 of review run
 * run.vtN26syQLu).
 *
 * The pure authority seam extracted from `createHost` so the selection
 * branches are unit-testable WITHOUT a full host boot (modeled on
 * `broker-selection.test.ts` for the sibling `selectCapabilityBroker`).
 * Pins:
 *   - the complete `BOT_APP_ID` + `BOT_APP_PASSWORD` pair selects the Bot
 *     Framework transport — and BEATS the webhook when both are configured;
 *   - a lone `BOT_APP_ID` (password missing) with NO webhook is classified
 *     `disabled/bot-password-missing` (the shell's single boot warning);
 *   - a lone `BOT_APP_ID` with a configured webhook still selects the webhook
 *     (the original chain's order — a complete webhook wins over an
 *     incomplete bot pair; behavior preserved by the extraction);
 *   - `TEAMS_WEBHOOK_URL` selects the webhook transport with the explicit
 *     `HITL_APPROVAL_BASE_URL` or the `http://localhost:<PORT>` default;
 *   - neither transport configured → `disabled/unconfigured` (HITL stays off).
 */

import { describe, it, expect } from "bun:test";
import { selectHitlNotifierTransport } from "../host.js";

type SelectionConfig = Parameters<typeof selectHitlNotifierTransport>[0];

const base = (overrides: Partial<SelectionConfig> = {}): SelectionConfig => ({
  PORT: 8080,
  ...overrides,
});

describe("selectHitlNotifierTransport (boot wiring, ADR-0060)", () => {
  it("selects the Bot Framework transport from the complete BOT_APP_ID + BOT_APP_PASSWORD pair", () => {
    const selection = selectHitlNotifierTransport(
      base({ BOT_APP_ID: "app-1", BOT_APP_PASSWORD: "pw-1" }),
    );
    expect(selection).toEqual({ kind: "bot-framework", appId: "app-1", appPassword: "pw-1" });
  });

  it("carries the optional BOT_TOKEN_URL through the Bot Framework selection", () => {
    const selection = selectHitlNotifierTransport(
      base({ BOT_APP_ID: "app-1", BOT_APP_PASSWORD: "pw-1", BOT_TOKEN_URL: "https://token.example.com" }),
    );
    expect(selection).toEqual({
      kind: "bot-framework",
      appId: "app-1",
      appPassword: "pw-1",
      tokenUrl: "https://token.example.com",
    });
  });

  it("Bot Framework WINS over the webhook when both are configured (in-Teams precedence)", () => {
    const selection = selectHitlNotifierTransport(
      base({
        BOT_APP_ID: "app-1",
        BOT_APP_PASSWORD: "pw-1",
        TEAMS_WEBHOOK_URL: "https://hook.example.com/hook",
      }),
    );
    expect(selection.kind).toBe("bot-framework");
  });

  it("a lone BOT_APP_ID with no webhook is disabled/bot-password-missing (the shell's single boot warning)", () => {
    const selection = selectHitlNotifierTransport(base({ BOT_APP_ID: "app-1" }));
    expect(selection).toEqual({ kind: "disabled", reason: "bot-password-missing" });
  });

  it("a lone BOT_APP_ID still falls through to a configured webhook — the original chain's order, preserved", () => {
    // The pre-extraction chain was: complete bot pair → webhook → lone
    // BOT_APP_ID warning. A complete webhook therefore wins over an
    // incomplete bot pair (and no warning is due: HITL is functional via
    // the webhook). The extraction must not reorder this.
    const selection = selectHitlNotifierTransport(
      base({ BOT_APP_ID: "app-1", TEAMS_WEBHOOK_URL: "https://hook.example.com/hook" }),
    );
    expect(selection).toEqual({
      kind: "webhook",
      webhookUrl: "https://hook.example.com/hook",
      approvalBaseUrl: "http://localhost:8080",
    });
  });

  it("TEAMS_WEBHOOK_URL alone selects the webhook with the http://localhost:<PORT> default approval base", () => {
    const selection = selectHitlNotifierTransport(
      base({ PORT: 9999, TEAMS_WEBHOOK_URL: "https://hook.example.com/hook" }),
    );
    expect(selection).toEqual({
      kind: "webhook",
      webhookUrl: "https://hook.example.com/hook",
      approvalBaseUrl: "http://localhost:9999",
    });
  });

  it("an explicit HITL_APPROVAL_BASE_URL overrides the derived default", () => {
    const selection = selectHitlNotifierTransport(
      base({
        PORT: 9999,
        TEAMS_WEBHOOK_URL: "https://hook.example.com/hook",
        HITL_APPROVAL_BASE_URL: "https://approve.example.com",
      }),
    );
    expect(selection).toEqual({
      kind: "webhook",
      webhookUrl: "https://hook.example.com/hook",
      approvalBaseUrl: "https://approve.example.com",
    });
  });

  it("neither transport configured → disabled/unconfigured (HITL stays off)", () => {
    const selection = selectHitlNotifierTransport(base({}));
    expect(selection).toEqual({ kind: "disabled", reason: "unconfigured" });
  });
});
