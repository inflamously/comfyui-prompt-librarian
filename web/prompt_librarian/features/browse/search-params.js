/* The /search request for one page of the list. Filtering happens on the
 * server: a local filter would disagree with its match percentages, duplicate
 * counts and pagination.
 */

/**
 * @param {{q: string, tags: string[], dupesOnly: boolean, sort: string}} query
 * @param {{threshold?: number, currentId?: string|null}} context
 */
export function searchParams(query, context, offset, limit) {
  return {
    q: query.q || "",
    tags: query.tags && query.tags.length ? query.tags : null,
    dupes_only: query.dupesOnly ? true : null,
    group: true,
    sort: query.sort || "relevance",
    offset,
    limit,
    threshold: context.threshold,
    match_id: context.currentId || null,
  };
}
