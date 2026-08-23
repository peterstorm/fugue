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
