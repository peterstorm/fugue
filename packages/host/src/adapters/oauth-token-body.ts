import { err, ok } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";

export type OAuthTokenBody = Readonly<{
  accessToken: string;
  expiresInSec: number;
}>;

/** Parse the shared OAuth access_token/expires_in success-body invariant. */
export const parseOAuthTokenBody = (
  body: Readonly<Record<string, unknown>>,
): Result<OAuthTokenBody, "malformed-oauth-token-body"> => {
  const accessToken = body.access_token;
  const expiresInSec = body.expires_in;
  return typeof accessToken === "string" &&
    accessToken.length > 0 &&
    typeof expiresInSec === "number" &&
    Number.isFinite(expiresInSec) &&
    expiresInSec > 0
    ? ok({ accessToken, expiresInSec })
    : err("malformed-oauth-token-body");
};

/**
 * The RFC 6749 §5.2 error-body description, or `undefined` when the body
 * carries neither field as a string.
 *
 * Sits beside `parseOAuthTokenBody` — the success-body convention these same
 * two adapters already share — so the ERROR-body convention has one home too.
 * `error_description` is preferred because it is the human-readable field; the
 * machine-readable `error` code is the fallback. Callers supply their own
 * "denied (HTTP nnn)" default so the provider stays named in the message.
 */
export const oauthErrorDescription = (
  body: Readonly<Record<string, unknown>>,
): string | undefined =>
  [body.error_description, body.error].find(
    (value): value is string => typeof value === "string",
  );
