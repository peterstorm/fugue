/**
 * Tests for domain/auth.ts — pure auth logic.
 *
 * Covers:
 * - canAccessDag authorization rules
 * - Token generation (formatToken)
 * - Token hashing (hashToken — deterministic)
 * - Token shape validation (isTeamTokenShape)
 */

import { describe, it, expect } from "bun:test";
import {
  canAccessDag,
  formatToken,
  hashToken,
  isTeamTokenShape,
  TOKEN_PREFIX,
  TOKEN_MIN_LENGTH,
} from "../../domain/auth.js";
import type { AuthIdentity } from "../../domain/auth.js";

describe("canAccessDag", () => {
  it("admin can access any team's DAGs", () => {
    const admin: AuthIdentity = { kind: "admin" };
    expect(canAccessDag(admin, "team-a")).toBe(true);
    expect(canAccessDag(admin, "team-b")).toBe(true);
    expect(canAccessDag(admin, "anything")).toBe(true);
  });

  it("team identity can access own DAGs", () => {
    const identity: AuthIdentity = { kind: "team", team: "team-a", label: "Team A" };
    expect(canAccessDag(identity, "team-a")).toBe(true);
  });

  it("team identity cannot access other team's DAGs", () => {
    const identity: AuthIdentity = { kind: "team", team: "team-a", label: "Team A" };
    expect(canAccessDag(identity, "team-b")).toBe(false);
  });

  it("team comparison is exact (case-sensitive)", () => {
    const identity: AuthIdentity = { kind: "team", team: "team-a", label: "Team A" };
    expect(canAccessDag(identity, "Team-A")).toBe(false);
    expect(canAccessDag(identity, "TEAM-A")).toBe(false);
  });
});

describe("formatToken", () => {
  it("starts with the token prefix", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it("is at least TOKEN_MIN_LENGTH long", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    expect(token.length).toBeGreaterThanOrEqual(TOKEN_MIN_LENGTH);
  });

  it("produces different tokens for different random bytes", () => {
    const bytes1 = crypto.getRandomValues(new Uint8Array(32));
    const bytes2 = crypto.getRandomValues(new Uint8Array(32));
    const token1 = formatToken(bytes1);
    const token2 = formatToken(bytes2);
    expect(token1).not.toBe(token2);
  });

  it("is deterministic for same input", () => {
    const bytes = new Uint8Array(32).fill(42);
    const token1 = formatToken(bytes);
    const token2 = formatToken(bytes);
    expect(token1).toBe(token2);
  });

  it("contains only URL-safe characters", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    // base64url: [A-Za-z0-9_-] plus the prefix
    expect(token).toMatch(/^fug_[A-Za-z0-9_-]+$/);
  });
});

describe("hashToken", () => {
  it("returns a hex string", async () => {
    const hash = await hashToken("test-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
  });

  it("is deterministic", async () => {
    const hash1 = await hashToken("same-input");
    const hash2 = await hashToken("same-input");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await hashToken("token-a");
    const hash2 = await hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });
});

describe("isTeamTokenShape", () => {
  it("returns true for valid token shape", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = formatToken(bytes);
    expect(isTeamTokenShape(token)).toBe(true);
  });

  it("returns false for string without prefix", () => {
    expect(isTeamTokenShape("no-prefix-token-that-is-long-enough")).toBe(false);
  });

  it("returns false for too-short string with prefix", () => {
    expect(isTeamTokenShape("fug_short")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTeamTokenShape("")).toBe(false);
  });
});
