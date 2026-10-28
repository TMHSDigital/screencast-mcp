/**
 * Helpers for ffmpeg expressions (libavutil/eval) built from many terms.
 *
 * ffmpeg's expression parser fails on a flat sum of 100 or more terms and on
 * nesting deeper than about 40 calls (#225). A sum grouped in parentheses of
 * at most SUM_GROUP terms has neither problem, so long timelines (zoom
 * keyframes, idle cuts) are built as grouped sums rather than nested if()s.
 */

/** Terms per parenthesised group; ffmpeg rejects a flat sum of 100. */
export const SUM_GROUP = 50;

/** Sum terms as `(a+b+...)+(...)`, grouping recursively so no level has more
 * than SUM_GROUP terms. Pure. */
export function sumExpr(terms: string[]): string {
  if (terms.length === 0) return "0";
  if (terms.length <= SUM_GROUP) return terms.join("+");
  const groups: string[] = [];
  for (let i = 0; i < terms.length; i += SUM_GROUP) groups.push(`(${terms.slice(i, i + SUM_GROUP).join("+")})`);
  return sumExpr(groups);
}
