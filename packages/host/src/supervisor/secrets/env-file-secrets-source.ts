/**
 * Env-file `SecretsSource` adapter (AD-6 default adapter).
 *
 * Given a `SecretsRef` that denotes a mounted per-tenant env-file PATH, this
 * reads and parses that file into the resolved `ResolvedSecrets` map. It is the
 * concrete authority a worker wires at bootstrap (T6): constructing it is the
 * seam that carries filesystem-read authority. The supervisor does not import
 * this module (or any concrete `SecretsSource`) — enforced by convention today,
 * verified end-to-end in T11 — so no resolution path for this port exists
 * supervisor-side and the supervisor's inert `SecretsRef` is not dereferenced
 * there (multi-tenant spec FR-005, FR-006, SC-002). A future Vault adapter drops in behind the
 * same `SecretsSource` port without changing any caller.
 *
 * ── Fail-closed (multi-tenant spec FR-006) ──────────────────────────────────────────────────────
 *   - missing file            → `config-invalid` Left
 *   - unreadable file (perms, dir, …) → `config-invalid` Left
 *   - malformed line          → `config-invalid` Left (NEVER silently dropped —
 *                               a skipped line would silently drop a secret)
 *   - duplicate key           → `config-invalid` Left (ambiguous; never
 *                               last-wins-silently)
 * There is no partial / empty silent success: the only `Ok` is a fully-parsed
 * map. An empty FILE is a valid empty map (the tenant declared zero secrets);
 * an empty map is distinct from a parse failure.
 *
 * ── Never log values (mirrors keycloak-entra spec NFR-014) ────────────────────────────────────────
 * No error message here interpolates a secret VALUE. The ref/path and offending
 * KEY name / line NUMBER are safe to surface; the VALUE never is. The adapter
 * performs no logging at all.
 *
 * @satisfies multi-tenant spec FR-031 — resolves the per-tenant secrets reference; wired only inside the owning worker.
 * @satisfies multi-tenant spec FR-006 — fail-closed: any read/parse problem is a Left, never a partial map.
 */

import { readFileSync } from "node:fs";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { SecretsRef } from "../../domain/tenant.js";
import type { HostError } from "../../domain/host-error.js";
import type { ResolvedSecrets, SecretsSource } from "./secrets-source.js";

/**
 * KEY syntax accepted on the left of `=`. Conservative POSIX-ish env name:
 * a letter or underscore, then letters/digits/underscores. Rejecting odd keys
 * up front is part of fail-closed parsing — a malformed key is a parse error,
 * not a silently-skipped line.
 */
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A `config-invalid` Left describing an env-file resolution failure. The
 * `path`/`ref` and a structural reason (line number, key name) are safe to name;
 * a secret VALUE is NEVER passed in. Centralized so every failure path produces
 * a uniform, value-free error.
 */
const parseError = (refPath: string, reason: string): Result<never, HostError> =>
  err({ kind: "config-invalid", message: `env-file secrets source '${refPath}': ${reason}` });

/**
 * Strip a surrounding pair of matching quotes from a value, if present.
 *
 * - `"..."` — double-quoted: supports the common escapes `\n \r \t \\ \"` so a
 *   secret containing a newline (e.g. a PEM key) can be expressed on one line.
 * - `'...'` — single-quoted: LITERAL, no escape processing (shell semantics).
 * - otherwise — bare value, used verbatim (already trimmed of surrounding
 *   whitespace by the caller).
 *
 * Returns `undefined` for a malformed quoted value (an opening quote with no
 * matching close), so the caller can fail closed. NOTE: never logs the value.
 */
const unquote = (raw: string): { readonly value: string } | undefined => {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1);
    // The trailing `"` is only a real terminator if it is NOT itself escaped. If
    // `inner` ends in an ODD run of backslashes, the apparent closing quote was
    // an escaped `\"` and the value is actually UNTERMINATED (e.g. `"abc\"`) —
    // fail closed rather than emit a silently-truncated secret. (An even run,
    // e.g. `"abc\\"`, is a real closing quote after an escaped backslash.)
    let trailingBackslashes = 0;
    for (let i = inner.length - 1; i >= 0 && inner[i] === "\\"; i--) trailingBackslashes++;
    if (trailingBackslashes % 2 === 1) return undefined;
    let out = "";
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "\\" && i + 1 < inner.length) {
        const n = inner[i + 1];
        out +=
          n === "n" ? "\n" :
          n === "r" ? "\r" :
          n === "t" ? "\t" :
          n === '"' ? '"' :
          n === "\\" ? "\\" :
          `\\${n}`; // unknown escape: keep both chars verbatim
        i++;
        continue;
      }
      out += c;
    }
    return { value: out };
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return { value: raw.slice(1, -1) };
  }
  // A lone unmatched quote at the start is a malformed value — fail closed.
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return undefined;
  }
  return { value: raw };
};

/**
 * Parse env-file CONTENT into a `ResolvedSecrets` map (pure — no I/O).
 * Exported for direct unit testing of the parser independent of the filesystem.
 *
 * Accepts: `KEY=VALUE` lines, blank lines, and `#` comment lines (a `#` is a
 * comment only at the START of a trimmed line — a `#` inside a value is literal).
 * Fail-closed on any malformed line, bad key, malformed quoting, or duplicate
 * key. Never includes a value in an error.
 *
 * @param refPath the ref/path, used ONLY in error messages (safe to name).
 * @param content the raw file contents.
 */
export const parseEnvFile = (refPath: string, content: string): Result<ResolvedSecrets, HostError> => {
  const out: Record<string, string> = Object.create(null);
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();

    // Blank line or full-line comment — skip (not a secret).
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      // A non-blank, non-comment line with no '=' would silently drop whatever
      // the author intended — fail closed rather than skip it.
      return parseError(refPath, `malformed line ${lineNo}: expected KEY=VALUE`);
    }

    // Allow an optional leading `export ` (common in sourced env files).
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();

    if (!ENV_KEY_REGEX.test(key)) {
      // Name the KEY (safe) and line number — never the value.
      return parseError(refPath, `invalid key on line ${lineNo}: must match ${ENV_KEY_REGEX.source}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      return parseError(refPath, `duplicate key '${key}' on line ${lineNo}`);
    }

    const rawValue = trimmed.slice(eq + 1).trim();
    const unquoted = unquote(rawValue);
    if (unquoted === undefined) {
      // Malformed quoting — report the KEY/line, NOT the value.
      return parseError(refPath, `malformed quoted value for key '${key}' on line ${lineNo}`);
    }
    out[key] = unquoted.value;
  }

  // Freeze a defensive, immutable snapshot. `Object.create(null)` already has no
  // prototype, so inherited-key confusion is impossible.
  return ok(Object.freeze({ ...out }) as ResolvedSecrets);
};

/**
 * Construct the env-file `SecretsSource`. This is the concrete adapter a WORKER
 * wires at bootstrap (T6); the supervisor does not call it (it does not import
 * this module — convention today, verified e2e in T11). Invoking the constructor
 * is the seam that carries filesystem-read authority (multi-tenant spec FR-005, SC-002).
 *
 * The returned `SecretsSource` reads the file at the ref's path on each call and
 * parses it, failing closed on any read or parse problem. It is synchronous to
 * satisfy the `SecretsSource` contract; worker bootstrap resolves once at spawn.
 */
export const createEnvFileSecretsSource = (): SecretsSource => {
  return (ref: SecretsRef): Result<ResolvedSecrets, HostError> => {
    // A `SecretsRef` is, for THIS adapter, the env-file path. Other adapters
    // (Vault) interpret the same brand differently — the port keeps them
    // substitutable.
    const refPath = ref as string;

    let content: string;
    try {
      content = readFileSync(refPath, "utf8");
    } catch (e) {
      // Fail closed on ANY read failure (missing file, permission denied, is a
      // directory, …). The error names the PATH and the OS error code — never a
      // secret value (the failed read produced no value anyway).
      const code =
        typeof e === "object" && e !== null && "code" in e && typeof (e as { code?: unknown }).code === "string"
          ? (e as { code: string }).code
          : "unknown";
      return parseError(refPath, `unreadable (${code})`);
    }

    return parseEnvFile(refPath, content);
  };
};
