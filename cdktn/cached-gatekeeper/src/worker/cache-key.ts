/**
 * Canonicalization.
 *
 * The reason this file exists: a cache in front of an agent is not a cache in
 * front of a browser. Browsers emit byte-identical requests for the same page.
 * A language model emits a *different* argument object every time it asks the
 * same question: keys in a different order, `state: "open"` sometimes spelled
 * out and sometimes left to the default, `per_page: 30` one turn and `25` the
 * next, a stray `_t` it invented to "avoid stale data".
 *
 * All of those are the same question. Cached naively they are separate entries,
 * and the hit rate collapses to roughly zero at exactly the moment the cache
 * would have been most useful. So every call is reduced to a canonical form
 * before it is used as `cf.cacheKey`.
 */

export type ParamValue = string | number | boolean | string[] | undefined | null;
export type Params = Record<string, ParamValue>;

/** Parameters an agent adds to defeat caching, or that a UI adds for tracking. */
const VOLATILE_PARAMS = /^(_|t|ts|timestamp|nocache|cachebust|rand|random|utm_.*)$/i;

/** Page sizes are snapped to these, so 25 and 30 share one cached entry. */
const PAGE_SIZE_BUCKETS = [10, 30, 50, 100] as const;

/** GitHub treats owner and repository names case-insensitively; the cache should too. */
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

/** `owner/repo`, normalized, with any surrounding URL or `.git` suffix removed. */
export function normalizeRepo(owner: string, repo: string): string {
  return `${normalizeSlug(owner)}/${normalizeSlug(repo).replace(/\.git$/, "")}`;
}

export function bucketPageSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size) || size <= 0) {
    return PAGE_SIZE_BUCKETS[1];
  }
  for (const bucket of PAGE_SIZE_BUCKETS) {
    if (size <= bucket) return bucket;
  }
  return PAGE_SIZE_BUCKETS[PAGE_SIZE_BUCKETS.length - 1] as number;
}

function normalizeValue(value: Exclude<ParamValue, undefined | null>): string {
  if (Array.isArray(value)) {
    // Label filters and similar lists are sets, not sequences: ["bug","p1"]
    // and ["p1","bug","bug"] select the same issues.
    const unique = [...new Set(value.map((entry) => entry.trim().toLowerCase()))];
    return unique.filter(Boolean).sort().join(",");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return value.trim();
}

/**
 * Reduce a parameter bag to a stable query string.
 *
 * Dropped: volatile parameters, empty values, and anything that matches the
 * upstream default, so `state: "open"` and an omitted `state` agree.
 */
export function canonicalQuery(params: Params, defaults: Params = {}): string {
  const normalizedDefaults = new Map<string, string>();
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined || value === null) continue;
    normalizedDefaults.set(key.toLowerCase(), normalizeValue(value));
  }

  const pairs: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = rawKey.trim().toLowerCase();
    if (!key || VOLATILE_PARAMS.test(key)) continue;
    if (rawValue === undefined || rawValue === null) continue;

    const value = normalizeValue(rawValue);
    if (value === "") continue;
    if (normalizedDefaults.get(key) === value) continue;

    pairs.push([key, value]);
  }

  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * The value handed to `cf.cacheKey`. It replaces the path and query portion of
 * the cache key; the entrypoint name and `ctx.props` are still mixed in by the
 * runtime, so this never has to carry identity itself.
 */
export function canonicalKey(path: string, params: Params = {}, defaults: Params = {}): string {
  const normalizedPath = `/${path.split("/").filter(Boolean).join("/")}`;
  const query = canonicalQuery(params, defaults);
  return query ? `${normalizedPath}?${query}` : normalizedPath;
}
