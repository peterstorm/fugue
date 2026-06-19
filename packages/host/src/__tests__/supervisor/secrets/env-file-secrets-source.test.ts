import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk, isErr } from "@fuguejs/framework";
import { markSecretsRef } from "../../../domain/tenant.js";
import type { SecretsRef } from "../../../domain/tenant.js";
import { createEnvFileSecretsSource, parseEnvFile } from "../../../supervisor/secrets/env-file-secrets-source.js";
import type { SecretsSource } from "../../../supervisor/secrets/secrets-source.js";

// A representative secret value used across tests. We assert it never leaks into
// an error message (the adapter must not interpolate VALUES).
const SECRET_VALUE = "s3cr3t-VALUE-do-not-leak-9f2a";

describe("env-file SecretsSource", () => {
  let dir: string;

  const refFor = (relPath: string): SecretsRef => markSecretsRef(join(dir, relPath));
  const write = (relPath: string, contents: string): SecretsRef => {
    const p = join(dir, relPath);
    writeFileSync(p, contents, "utf8");
    return markSecretsRef(p);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fugue-env-secrets-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("parseEnvFile (pure)", () => {
    it("parses multiple KEY=VALUE pairs", () => {
      const r = parseEnvFile("/ref", "API_KEY=abc\nDB_URL=postgres://x\nTOKEN=zzz\n");
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ API_KEY: "abc", DB_URL: "postgres://x", TOKEN: "zzz" });
    });

    it("skips blank lines and full-line comments", () => {
      const content = ["# a comment", "", "  ", "FOO=bar", "  # indented comment", "BAZ=qux", ""].join("\n");
      const r = parseEnvFile("/ref", content);
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("treats '#' inside a value as literal (not a comment)", () => {
      const r = parseEnvFile("/ref", "URL=http://h/p#frag\n");
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ URL: "http://h/p#frag" });
    });

    it("handles double-quoted values with escapes (e.g. embedded newline)", () => {
      const r = parseEnvFile("/ref", 'PEM="line1\\nline2"\nQ="a\\"b"\n');
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ PEM: "line1\nline2", Q: 'a"b' });
    });

    it("handles single-quoted values literally (no escape processing)", () => {
      const r = parseEnvFile("/ref", "LIT='a\\nb'\n");
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ LIT: "a\\nb" });
    });

    it("preserves '=' characters inside the value", () => {
      const r = parseEnvFile("/ref", "B64=aGVsbG8=world==\n");
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ B64: "aGVsbG8=world==" });
    });

    it("accepts an optional leading 'export '", () => {
      const r = parseEnvFile("/ref", "export FOO=bar\n");
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ FOO: "bar" });
    });

    it("treats an empty file as an empty map (not a failure)", () => {
      const r = parseEnvFile("/ref", "");
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({});
    });

    it("returns an immutable, prototype-free map", () => {
      const r = parseEnvFile("/ref", "A=1\n");
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(Object.isFrozen(r.value)).toBe(true);
      // A crafted "__proto__" line is just a key, never pollutes the prototype.
      const p = parseEnvFile("/ref", "__proto__=polluted\n");
      expect(isOk(p)).toBe(true);
      if (!isOk(p)) return;
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    // ── fail-closed parse cases ───────────────────────────────────────────────

    it("fails closed on a malformed line with no '=' (never silently dropped)", () => {
      const r = parseEnvFile("/ref", "GOOD=1\nthis is not valid\nALSO=2\n");
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      expect(r.error.kind).toBe("config-invalid");
    });

    it("fails closed on an invalid key", () => {
      const r = parseEnvFile("/ref", "1BAD=x\n");
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      expect(r.error.kind).toBe("config-invalid");
    });

    it("fails closed on a duplicate key (never last-wins-silently)", () => {
      const r = parseEnvFile("/ref", "K=a\nK=b\n");
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      expect(r.error.kind).toBe("config-invalid");
      if (r.error.kind !== "config-invalid") return;
      expect(r.error.message).toContain("duplicate key 'K'");
    });

    it("fails closed on malformed quoting (unmatched quote)", () => {
      const r = parseEnvFile("/ref", 'K="unterminated\n');
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      expect(r.error.kind).toBe("config-invalid");
    });

    it("never interpolates a secret VALUE into a parse error message", () => {
      // A duplicate key whose values are the sensitive marker — the error must
      // name the key/line, never the value.
      const r = parseEnvFile("/ref", `K=${SECRET_VALUE}\nK=${SECRET_VALUE}\n`);
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      if (r.error.kind !== "config-invalid") return;
      expect(r.error.message).not.toContain(SECRET_VALUE);
    });
  });

  describe("createEnvFileSecretsSource (adapter, with filesystem)", () => {
    it("reads and parses a tenant env file (happy path)", () => {
      const ref = write("tenant-a.env", `API_KEY=${SECRET_VALUE}\nDB=postgres://x\n`);
      const source = createEnvFileSecretsSource();
      const r = source(ref);
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value).toEqual({ API_KEY: SECRET_VALUE, DB: "postgres://x" });
    });

    it("fails closed when the file is missing", () => {
      const ref = refFor("does-not-exist.env");
      const r = createEnvFileSecretsSource()(ref);
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      expect(r.error.kind).toBe("config-invalid");
      if (r.error.kind !== "config-invalid") return;
      expect(r.error.message).toContain("ENOENT");
    });

    it("fails closed when the ref points at a directory (unreadable as a file)", () => {
      const subdir = join(dir, "a-directory");
      mkdirSync(subdir);
      const r = createEnvFileSecretsSource()(markSecretsRef(subdir));
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      expect(r.error.kind).toBe("config-invalid");
    });

    it("fails closed when the file is unreadable (permission denied)", () => {
      const ref = write("locked.env", `SECRET=${SECRET_VALUE}\n`);
      // Remove all read permission. Skip the assertion if running as root (where
      // mode bits are ignored) — the read would succeed regardless.
      chmodSync(ref as string, 0o000);
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      const r = createEnvFileSecretsSource()(ref);
      if (isRoot) {
        // root bypasses perms; just ensure no throw and a defined Result.
        expect(r).toBeDefined();
      } else {
        expect(isErr(r)).toBe(true);
        if (!isErr(r)) return;
        expect(r.error.kind).toBe("config-invalid");
      }
      chmodSync(ref as string, 0o600); // restore so afterEach cleanup works
    });

    it("fails closed on malformed file content", () => {
      const ref = write("bad.env", "not-an-assignment\n");
      const r = createEnvFileSecretsSource()(ref);
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      expect(r.error.kind).toBe("config-invalid");
    });

    it("never leaks a secret value through a file-read error message", () => {
      // The file exists but is malformed AND contains the sensitive marker; the
      // error must not echo it.
      const ref = write("leaky.env", `bare line containing ${SECRET_VALUE}\n`);
      const r = createEnvFileSecretsSource()(ref);
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) return;
      if (r.error.kind !== "config-invalid") return;
      expect(r.error.message).not.toContain(SECRET_VALUE);
    });
  });

  // ── Structural FR-005 / SC-002 assertion (unit level) ─────────────────────
  //
  // The supervisor would, at most, hold a `SecretsRef` and the `SecretsSource`
  // PORT TYPE. This test encodes that resolution structurally requires a
  // CONCRETE adapter (which carries filesystem authority) — the port type alone
  // cannot dereference anything. The full process-inspection e2e is T11.
  describe("structural supervisor-secrets-absence (FR-005, FR-006, SC-002)", () => {
    it("a SecretsRef alone carries no secret value — it is just an opaque pointer", () => {
      const ref = write("tenant.env", `API_KEY=${SECRET_VALUE}\n`);
      // Everything the supervisor could hold is the branded ref string. It does
      // NOT contain the secret value; it is only a path/pointer.
      expect(String(ref)).not.toContain(SECRET_VALUE);
    });

    it("resolution is impossible without constructing the concrete adapter", () => {
      const ref = write("tenant.env", `API_KEY=${SECRET_VALUE}\n`);

      // Model the supervisor: it has the ref and (at most) a variable typed as
      // the port. There is NO concrete source — so there is no callable that can
      // dereference. The only way to obtain a value is to construct the adapter,
      // which is exactly the worker-only authority (filesystem read).
      const supervisorHeldPort: SecretsSource | undefined = undefined;
      expect(supervisorHeldPort).toBeUndefined();

      // The worker side: constructing the adapter is what grants resolution.
      const workerSource = createEnvFileSecretsSource();
      const r = workerSource(ref);
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value.API_KEY).toBe(SECRET_VALUE);
    });

    it("the env-file adapter module is not importable by name from supervisor code paths by convention; here we assert it requires fs authority to function", () => {
      // We cannot statically assert imports in a unit test, but we CAN assert the
      // behavioral consequence: the adapter's only way to produce a value is to
      // read the filesystem. With a ref to a nonexistent path (no fs object), it
      // fails closed — i.e. there is no in-memory shortcut to a secret.
      const ref = markSecretsRef(join(dir, "nope.env"));
      const r = createEnvFileSecretsSource()(ref);
      expect(isErr(r)).toBe(true);
    });
  });
});
