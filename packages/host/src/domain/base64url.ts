/**
 * base64url encoding (RFC 4648 §5, unpadded) — ONE definition for the host.
 *
 * Two independent copies previously existed (`domain/auth.ts`'s team-token
 * formatter and `supervisor/secrets/redis-acl-provisioner.ts`'s ACL password
 * formatter). Both mint SECRETS, so a divergence between them would be a
 * silently-weakened credential rather than a cosmetic difference — exactly the
 * kind of duplication that must be collapsed rather than kept in sync by hand.
 */

/**
 * Encode bytes as unpadded base64url.
 *
 * The byte→binary-string step is an explicit loop, NOT
 * `String.fromCharCode(...bytes)`: the spread form passes one argument per byte
 * and overflows the call-argument limit (a `RangeError`) once the input grows
 * past a few tens of kilobytes. Callers here pass short secrets today, but a
 * secret-minting helper must not carry a size cliff that turns a longer key
 * into a crash.
 */
export const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
