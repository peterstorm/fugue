/**
 * Tests for the pure capability-scope module (domain/capability-scope.ts).
 *
 * Covers: parse-don't-validate round-trips and rejection of malformed names,
 * the scope→handle-kind mapping, and the SC-007 TYPE-LEVEL guarantee that an
 * operation-narrowed handle exposes ONLY its named operation — no raw client,
 * no token, no apiKey field is reachable.
 */

import { describe, it, expect } from "bun:test";
import { match } from "ts-pattern";
import {
  parseScope,
  handleKindForScope,
  type DownstreamScope,
  type HandleKind,
  type MailSendHandle,
  type SitesReadHandle,
  type DynamicsReadHandle,
} from "../capability-scope.js";

describe("parseScope — parse-don't-validate", () => {
  it("round-trips msgraph:mail.send into a typed scope", () => {
    const r = parseScope("msgraph:mail.send");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ provider: "msgraph", operation: "mail.send" });
    }
  });

  it("round-trips msgraph:sites.read", () => {
    const r = parseScope("msgraph:sites.read");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ provider: "msgraph", operation: "sites.read" });
  });

  it("round-trips dynamics:read", () => {
    const r = parseScope("dynamics:read");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ provider: "dynamics", operation: "read" });
  });

  it.each([
    ["", "empty"],
    ["msgraph", "no operation"],
    ["msgraph:", "trailing colon, empty operation"],
    [":mail.send", "leading colon, empty provider"],
    ["msgraph:unknown.op", "unknown operation"],
    ["dynamics:write", "operation not granted on this provider"],
    ["unknownprovider:read", "unknown provider"],
    ["msgraph:mail.send:extra", "extra segment — operation 'mail.send:extra' unknown"],
  ])("rejects malformed/unknown name %p (%s) as a policy-refusal", (name) => {
    const r = parseScope(name);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // An unparseable scope is a config/authorization defect — fail-closed.
      expect(r.error.kind).toBe("policy-refusal");
      if (r.error.kind === "policy-refusal") {
        expect(r.error.scope).toBe(name);
      }
    }
  });

  it("parse is the ONLY constructor — every produced scope is recognised", () => {
    const names = ["msgraph:mail.send", "msgraph:sites.read", "dynamics:read"];
    for (const n of names) {
      const r = parseScope(n);
      expect(r.ok).toBe(true);
    }
  });
});

describe("handleKindForScope — exhaustive scope→handle mapping", () => {
  it("maps each recognised scope to its handle kind", () => {
    const cases: ReadonlyArray<[DownstreamScope, HandleKind]> = [
      [{ provider: "msgraph", operation: "mail.send" }, "mail.send"],
      [{ provider: "msgraph", operation: "sites.read" }, "sites.read"],
      [{ provider: "dynamics", operation: "read" }, "dynamics.read"],
    ];
    for (const [scope, kind] of cases) {
      expect(handleKindForScope(scope)).toBe(kind);
    }
  });

  it("composes with parseScope end-to-end", () => {
    const r = parseScope("msgraph:mail.send");
    expect(r.ok).toBe(true);
    if (r.ok) expect(handleKindForScope(r.value)).toBe("mail.send");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SC-007: TYPE-LEVEL assertion — the narrowed handle exposes ONLY its named
// operation. 0 raw-client fields, 0 token/key fields reachable. These checks
// are compile-time: if a `client`/`token`/`apiKey` member ever appeared on a
// handle, the `@ts-expect-error` lines would stop erroring and the test would
// fail to compile. The `Equal<keyof Handle, ...>` assertions pin the exact
// member set, leaving no escape hatch.
// @satisfies SC-007 @satisfies FR-W3-004 @satisfies FR-W3-005
// ───────────────────────────────────────────────────────────────────────────

type _Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type _Expect<T extends true> = T;

// MailSendHandle exposes EXACTLY `sendMail` and nothing else.
type _MailKeysExact = _Expect<_Equal<keyof MailSendHandle, "sendMail">>;
// SitesReadHandle exposes EXACTLY `readSite`.
type _SitesKeysExact = _Expect<_Equal<keyof SitesReadHandle, "readSite">>;
// DynamicsReadHandle exposes EXACTLY `read`.
type _DynamicsKeysExact = _Expect<_Equal<keyof DynamicsReadHandle, "read">>;

// Reference the type aliases so the compiler keeps them (and so an `unused`
// lint, if any, stays quiet). A `true` value only assigns if the assertions hold.
const _mailOk: _MailKeysExact = true;
const _sitesOk: _SitesKeysExact = true;
const _dynamicsOk: _DynamicsKeysExact = true;

describe("SC-007 — narrowed handle exposes no raw client / no token / no key", () => {
  it("type-level: handle key sets are exactly the named operation", () => {
    // The compile-time assertions above carry the guarantee; these runtime
    // `true`s exist only to anchor the test and prove the file type-checked.
    expect(_mailOk && _sitesOk && _dynamicsOk).toBe(true);
  });

  it("type-level: accessing .client / .token / .apiKey on a handle is a compile error", () => {
    // A structurally-typed stub satisfying ONLY the operation surface.
    const mail: MailSendHandle = {
      sendMail: async (m) =>
        match(m)
          .otherwise(() => ({ ok: true as const, value: { messageId: "id" } })),
    };
    // @ts-expect-error — SC-007: no raw downstream client is reachable.
    void mail.client;
    // @ts-expect-error — FR-W3-005: no raw token is reachable.
    void mail.token;
    // @ts-expect-error — FR-W3-005: no vendor API key is reachable.
    void mail.apiKey;

    // The named operation IS reachable (sanity: the surface is not empty).
    expect(typeof mail.sendMail).toBe("function");
  });
});
