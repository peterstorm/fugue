/**
 * parseJsonObject — tolerantly parse an HTTP response body string as a JSON
 * OBJECT. An empty body, a non-JSON body (e.g. an HTML 502 page), or a JSON
 * non-object (array/scalar) all collapse to `{}`, so the caller classifies the
 * response by STATUS and a malformed body never has to become a transport
 * reject. Pure. Shared by both live transports (`fetch-http-post.ts` form-POST
 * and `fetch-graph-http.ts` Graph) so the one parser has a single owner and the
 * two cannot drift.
 */
export const parseJsonObject = (body: string): Record<string, unknown> => {
  const trimmed = body.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};
