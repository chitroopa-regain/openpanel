/**
 * Does this retention response have anything to draw?
 *
 * Split out of the component because the naive version — `data.length === 0` —
 * was wrong the moment cohort buckets arrived: with a breakdown, the rows live
 * in `buckets`, and an empty FIRST bucket would blank a report whose second
 * bucket was full. That is the exact case a cohort breakdown exists to show
 * ("nobody in this cohort, everybody outside it"), so it has to be a tested
 * decision rather than an inline expression.
 */
export function hasRenderableRetention(response: {
  data: unknown[];
  buckets?: Array<{ data: unknown[] }>;
}): boolean {
  if (response.buckets?.length) {
    // Buckets are the answer when present. All-empty is genuinely empty; any
    // populated bucket must render, and the empty ones are synthesised as
    // all-zero grids beside it.
    return response.buckets.some((bucket) => bucket.data.length > 0);
  }
  return response.data.length > 0;
}
