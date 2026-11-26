/**
 * Self-test of the FR-022 scan every contract's acceptance relies on: a
 * sentinel planted on any surface, in any forbidden form, is found and the
 * failure names the surface, the kind and the form, never the credential.
 */

import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_KINDS,
  SURFACE_NAMES,
  assertNoCredentialMaterial,
  capturedSurfaces,
  createCredentialLedger,
} from "./credential-sentinel.js";
import type { CredentialKind, CredentialLedger, SurfaceName } from "./credential-sentinel.js";

const b64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** A JWT-shaped credential carrying the kind's sentinel as its jti; recorded in the ledger as a concrete credential. */
const recordedJwtOf = (ledger: CredentialLedger, kind: CredentialKind): string => {
  const signature = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const jwt = [
    b64url(JSON.stringify({ alg: "RS256", kid: "self-test" })),
    b64url(JSON.stringify({ sub: "self-test", jti: ledger.sentinels[kind] })),
    signature,
  ].join(".");
  ledger.record(kind, jwt);
  return jwt;
};

type PlantedForm = "raw" | "base64" | "base64url" | "hex" | "jwt-signature-segment" | "jwt-payload-segment";

/** The text planted on a surface for a kind, and the form name the scan must report for it. */
const plantedText = (
  ledger: CredentialLedger,
  kind: CredentialKind,
  form: PlantedForm,
): { readonly text: string; readonly reported: string } => {
  const sentinel = Buffer.from(ledger.sentinels[kind], "utf8");
  switch (form) {
    case "raw":
      return { text: ledger.sentinels[kind], reported: "raw" };
    case "base64":
      return { text: sentinel.toString("base64"), reported: "base64" };
    case "base64url":
      return { text: sentinel.toString("base64url"), reported: "base64url" };
    case "hex":
      // Case-insensitive: an upper-cased hex dump is still the credential.
      return { text: sentinel.toString("hex").toUpperCase(), reported: "hex" };
    case "jwt-signature-segment": {
      const segment = recordedJwtOf(ledger, kind).split(".")[2] as string;
      return { text: segment, reported: "jwt-segment-2" };
    }
    case "jwt-payload-segment": {
      const segment = recordedJwtOf(ledger, kind).split(".")[1] as string;
      return { text: segment, reported: "jwt-segment-1" };
    }
    default:
      return assertNeverForm(form);
  }
};

const assertNeverForm = (form: never): never => {
  throw new Error(`unreachable form: ${String(form)}`);
};

const PLANTED_FORMS: readonly PlantedForm[] = [
  "raw",
  "base64",
  "base64url",
  "hex",
  "jwt-signature-segment",
  "jwt-payload-segment",
];

/** Every surface filled with credential-free values, so a planted leak is the only one. */
const cleanSurfaces = (): Partial<Record<SurfaceName, readonly unknown[]>> =>
  Object.fromEntries(
    SURFACE_NAMES.map((surface) => [
      surface,
      [{ surface, message: "run admitted", status: 200, at: 1_700_000_000_000 }, `plain ${surface} line`],
    ]),
  );

const thrownBy = (run: () => void): Error => {
  try {
    run();
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`threw a non-Error: ${String(e)}`);
  }
  throw new Error("expected assertNoCredentialMaterial to throw, and it did not");
};

describe("assertNoCredentialMaterial", () => {
  test("passes when every surface is clean", () => {
    const ledger = createCredentialLedger();
    for (const kind of CREDENTIAL_KINDS) recordedJwtOf(ledger, kind);
    expect(() => assertNoCredentialMaterial(capturedSurfaces(cleanSurfaces()), ledger.needles())).not.toThrow();
  });

  test("passes when every surface is empty", () => {
    expect(() => assertNoCredentialMaterial(capturedSurfaces({}), createCredentialLedger().needles())).not.toThrow();
  });

  for (const surface of SURFACE_NAMES) {
    for (const form of PLANTED_FORMS) {
      test(`finds every kind's sentinel planted on ${surface} as ${form}, naming the surface and never the value`, () => {
        for (const kind of CREDENTIAL_KINDS) {
          const ledger = createCredentialLedger();
          const planted = plantedText(ledger, kind, form);
          const surfaces = capturedSurfaces({
            ...cleanSurfaces(),
            [surface]: [{ surface, message: "run admitted" }, { nested: { detail: `before ${planted.text} after` } }],
          });

          const error = thrownBy(() => assertNoCredentialMaterial(surfaces, ledger.needles()));

          expect(error.message).toContain(`${surface}[1]`);
          expect(error.message).toContain(`${kind} as ${planted.reported}`);
          expect(error.message).not.toContain(`${surface}[0]`);
          expect(error.message).not.toContain(planted.text);
          expect(error.message).not.toContain(ledger.sentinels[kind]);
        }
      });
    }
  }

  test("a JWT segment under 16 characters is not credential material on its own", () => {
    const ledger = createCredentialLedger();
    const jwt = recordedJwtOf(ledger, "entra-user-token");
    const header = jwt.split(".")[0] as string;
    expect(header.length).toBeGreaterThanOrEqual(16);
    const shortSegment = header.slice(0, 15);
    expect(() =>
      assertNoCredentialMaterial(capturedSurfaces({ logs: [`segment ${shortSegment}`] }), ledger.needles()),
    ).not.toThrow();
  });
});
