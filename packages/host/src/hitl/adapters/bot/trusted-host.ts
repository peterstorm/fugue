/**
 * Bot Framework `serviceUrl` allowlist (ADR-0060, security).
 *
 * The inbound `serviceUrl` on a Teams activity tells the connector WHERE to POST
 * the proactive review card — with an app-only bearer token attached. The JWT
 * verifier proves the request came from *a* Bot Framework caller but does not
 * bind the `serviceUrl`, so a forged/cross-tenant `serviceUrl` would otherwise
 * exfiltrate the connector credential (and the output under review) to an
 * attacker-controlled host (SSRF + credential leak).
 *
 * Mirrors the Microsoft SDK's trusted-host model: only `https` URLs whose host
 * is a known Bot Framework / Teams service endpoint are accepted. Pure +
 * exported so the allowlist is unit-tested directly.
 */

/**
 * Hosts (exact or dot-suffix) Microsoft uses for the Bot Framework / Teams
 * channel service. The Teams `serviceUrl` is `https://smba.trafficmanager.net/<region>/`;
 * connector/channel hosts live under `*.botframework.com` / `*.skype.com`.
 */
const TRUSTED_SUFFIXES = [
  ".botframework.com",
  ".skype.com",
  ".smba.trafficmanager.net",
] as const;
const TRUSTED_EXACT = new Set(["smba.trafficmanager.net"]);

/**
 * True iff `serviceUrl` is a well-formed `https` URL pointing at a trusted Bot
 * Framework / Teams host. Everything else (http, a foreign host, an unparseable
 * value) is rejected — the connector must never send its bearer token there.
 */
export const isTrustedBotServiceUrl = (serviceUrl: string): boolean => {
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (TRUSTED_EXACT.has(host)) return true;
  return TRUSTED_SUFFIXES.some((suffix) => host.endsWith(suffix));
};
