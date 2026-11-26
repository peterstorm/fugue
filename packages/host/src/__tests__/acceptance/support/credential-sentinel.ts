/**
 * FR-022 scan support for every contract's acceptance (INV-3: no credential
 * material in any observable surface).
 *
 * - `CredentialSentinels`: one distinctive value per credential kind. The
 *   identity fakes answer with these values (opaque tokens) or embed them as
 *   the jti claim of the JWTs they sign, and record every concrete credential they
 *   issue or a test presents in a `CredentialLedger`.
 * - `CapturedSurfaces`: a closed record of the ten surfaces a credential could
 *   leak into, filled only from the capturing sinks and transports.
 * - `assertNoCredentialMaterial` renders every captured value with
 *   `JSON.stringify`, `String()` and `Bun.inspect`, and fails on any sentinel or
 *   ledger value, its base64, base64url or hex encoding, or any JWT segment of
 *   16+ characters. A failure names the surface, the rendering, the credential
 *   kind and the form, never the credential itself.
 * - `assertCustodyCiphertextOnly`: every custody record at rest is a sealed
 *   refresh credential (or a revoked marker with no sealed bytes), carries no
 *   credential material, and opens only under its own binding.
 */

import { z } from "zod";

// ── Sentinels and the ledger ─────────────────────────────────────────────────

export const CREDENTIAL_KINDS = [
  "realm-user-token",
  "entra-user-token",
  "realm-assertion",
  "t1-token",
  "entra-app-access-token",
  "obo-access-token",
  "refresh-token",
  "redeem-refresh-token",
  "reauthorization-realm-user-token",
  "reauthorization-entra-user-token",
] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** One distinctive value per credential kind. */
export type CredentialSentinels = { readonly [K in CredentialKind]: string };

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Fresh sentinels: `sentinel-<kind>-<128 random bits>`, so no two runs or kinds collide. */
export const createCredentialSentinels = (): CredentialSentinels => {
  const entries = CREDENTIAL_KINDS.map((kind) => [kind, `sentinel-${kind}-${randomHex(16)}`] as const);
  return Object.freeze(Object.fromEntries(entries) as Record<CredentialKind, string>);
};

/** A credential value to scan for, labelled by its kind. */
export type Needle = { readonly kind: CredentialKind; readonly value: string };

/**
 * The sentinels plus every concrete credential carrying one (a signed JWT
 * whose jti claim is its kind's sentinel, a token a fake transport issued).
 */
export type CredentialLedger = {
  readonly sentinels: CredentialSentinels;
  readonly record: (kind: CredentialKind, value: string) => void;
  readonly needles: () => readonly Needle[];
};

export const createCredentialLedger = (sentinels: CredentialSentinels = createCredentialSentinels()): CredentialLedger => {
  const recorded = new Map<string, CredentialKind>();
  return {
    sentinels,
    record: (kind, value) => {
      recorded.set(value, kind);
    },
    needles: () => [
      ...CREDENTIAL_KINDS.map((kind) => ({ kind, value: sentinels[kind] })),
      ...[...recorded].map(([value, kind]) => ({ kind, value })),
    ],
  };
};

// ── Surfaces ─────────────────────────────────────────────────────────────────

export const SURFACE_NAMES = [
  "logs",
  "audit",
  "spans",
  "httpResponses",
  "errors",
  "handles",
  "origins",
  "runRecords",
  "custodyAtRest",
  "notifications",
] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

/**
 * Every observable surface: log lines, audit records, trace spans, HTTP
 * responses, error values, capability handles, authority and origin values,
 * HITL run records and checkpoints, custody at rest, and what the notifier
 * transports received.
 */
export type CapturedSurfaces = { readonly [K in SurfaceName]: readonly unknown[] };

/** A closed record: a surface a contract does not reach is captured as empty. */
export const capturedSurfaces = (captured: Partial<CapturedSurfaces>): CapturedSurfaces => {
  const entries = SURFACE_NAMES.map((name) => [name, captured[name] ?? []] as const);
  return Object.fromEntries(entries) as Record<SurfaceName, readonly unknown[]>;
};

// ── The scan ─────────────────────────────────────────────────────────────────

type Rendering = "json" | "string" | "inspect";

const safeJson = (value: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      }) ?? ""
    );
  } catch (e) {
    // A value whose toJSON throws still has its String() and inspect renderings scanned.
    return `[unserializable: ${e instanceof Error ? e.name : typeof e}]`;
  }
};

const safeString = (value: unknown): string => {
  try {
    return String(value);
  } catch (e) {
    return `[unstringifiable: ${e instanceof Error ? e.name : typeof e}]`;
  }
};

const renderingsOf = (value: unknown): readonly { readonly rendering: Rendering; readonly text: string }[] => [
  { rendering: "json", text: safeJson(value) },
  { rendering: "string", text: safeString(value) },
  { rendering: "inspect", text: Bun.inspect(value, { depth: Infinity }) },
];

/** Minimum length of a JWT segment that counts as credential material on its own. */
export const MIN_JWT_SEGMENT_LENGTH = 16;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

type Form = { readonly form: string; readonly text: string; readonly caseInsensitive: boolean };

/** Every form of a credential that must not appear: itself, its encodings and its JWT segments. */
const forbiddenFormsOf = (value: string): readonly Form[] => {
  const bytes = Buffer.from(value, "utf8");
  const segments = JWT_SHAPE.test(value)
    ? value
        .split(".")
        .map((segment, i) => ({ form: `jwt-segment-${i}`, text: segment, caseInsensitive: false }))
        .filter((s) => s.text.length >= MIN_JWT_SEGMENT_LENGTH)
    : [];
  return [
    { form: "raw", text: value, caseInsensitive: false },
    { form: "base64", text: bytes.toString("base64"), caseInsensitive: false },
    { form: "base64url", text: bytes.toString("base64url"), caseInsensitive: false },
    { form: "hex", text: bytes.toString("hex"), caseInsensitive: true },
    ...segments,
  ];
};

export type CredentialLeak = {
  readonly surface: SurfaceName;
  readonly index: number;
  readonly rendering: Rendering;
  readonly kind: CredentialKind;
  readonly form: string;
};

/** Every place a needle, in any forbidden form, appears in any rendering of any captured value. */
export const findCredentialMaterial = (
  surfaces: CapturedSurfaces,
  needles: readonly Needle[],
): readonly CredentialLeak[] => {
  const forms = needles.map((needle) => ({ kind: needle.kind, forms: forbiddenFormsOf(needle.value) }));
  return SURFACE_NAMES.flatMap((surface) =>
    surfaces[surface].flatMap((value, index) =>
      renderingsOf(value).flatMap(({ rendering, text }) => {
        const lower = text.toLowerCase();
        return forms.flatMap(({ kind, forms: candidates }) =>
          candidates
            .filter((f) => (f.caseInsensitive ? lower.includes(f.text.toLowerCase()) : text.includes(f.text)))
            .map((f) => ({ surface, index, rendering, kind, form: f.form })),
        );
      }),
    ),
  );
};

/** Throws, naming every leak by surface, rendering, kind and form (never the value), when any surface carries credential material. */
export const assertNoCredentialMaterial = (surfaces: CapturedSurfaces, needles: readonly Needle[]): void => {
  const leaks = findCredentialMaterial(surfaces, needles);
  if (leaks.length === 0) return;
  const described = leaks
    .map((l) => `${l.surface}[${l.index}] (${l.rendering}): ${l.kind} as ${l.form}`)
    .join("\n  ");
  throw new Error(`credential material found in ${leaks.length} place(s):\n  ${described}`);
};

// ── Custody at rest ──────────────────────────────────────────────────────────

/** One custody key and its stored bytes, read straight from the storage fake. */
export type CustodyRecordAtRest = { readonly key: string; readonly value: string };

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

const sealedSchema = z.strictObject({ kid: z.string().min(1), iv: base64url, ciphertext: base64url });

/** What a custody record may be at rest: sealed ciphertext, or a revoked marker with the sealed bytes dropped. */
const custodyAtRestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("held"), sealed: sealedSchema }),
  z.strictObject({ kind: z.literal("revoked"), reason: z.literal("refused") }),
]);

export type SealedRefreshCredentialAtRest = z.infer<typeof sealedSchema>;

/**
 * Opens a sealed record with the deployment keyring: under the binding its
 * own run authority derives (must open), and under a foreign binding (must not).
 */
export type CustodyOpenCheck = (
  record: CustodyRecordAtRest,
  sealed: SealedRefreshCredentialAtRest,
) => Promise<{ readonly ownBinding: boolean; readonly foreignBinding: boolean }>;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const assertCustodyCiphertextOnly = async (
  records: readonly CustodyRecordAtRest[],
  needles: readonly Needle[],
  opens: CustodyOpenCheck,
): Promise<void> => {
  assertNoCredentialMaterial(capturedSurfaces({ custodyAtRest: records }), needles);
  const problems: string[] = [];
  for (const record of records) {
    const raw: unknown = parseJson(record.value);
    const parsed = custodyAtRestSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${record.key}: not a sealed refresh credential or a revoked marker`);
      continue;
    }
    if (parsed.data.kind === "revoked") continue;
    const opened = await opens(record, parsed.data.sealed);
    if (!opened.ownBinding) problems.push(`${record.key}: does not open under its own binding`);
    if (opened.foreignBinding) problems.push(`${record.key}: opens under a foreign binding`);
  }
  if (problems.length > 0) throw new Error(`custody at rest is not ciphertext-only:\n  ${problems.join("\n  ")}`);
};
