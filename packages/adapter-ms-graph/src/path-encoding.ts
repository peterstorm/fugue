/**
 * Graph path encoding — ONE definition, in a dependency-free module.
 *
 * `index.ts` and `path-resolving.ts` each previously carried their own copy,
 * then a differently-named local alias for this one (`encodePath` /
 * `encSegments`, dropped in round 38 — an alias that adds no translation only
 * gives the same function two more names to search for). Both build request
 * URLs that the Graph
 * service parses strictly, so a divergence between them would surface as
 * mismatched 404s between two adapters that are supposed to address items
 * identically. The shared definition lives here rather than in either module
 * because those two already re-export across each other; a third, leaf module
 * keeps the value edge acyclic.
 */

/**
 * Percent-encode each path segment while preserving `/` separators.
 *
 * Segment-wise, NOT whole-string: `encodeURIComponent` on the full path would
 * escape the separators too, and Graph would read the result as one literal
 * segment containing `%2F`. Empty segments are dropped so a doubled or leading
 * slash cannot produce an empty path component.
 */
export const encodePathSegments = (p: string): string =>
  p
    .split("/")
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join("/");
