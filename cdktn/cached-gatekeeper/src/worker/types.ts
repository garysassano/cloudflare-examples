export interface Env {
  /** Optional. Absent or empty means the anonymous GitHub API (60 requests/hour). */
  GITHUB_TOKEN?: string;
  /** JSON: `{ "<caller credential>": { "subject": string, "allow": string[] } }`. */
  GATEKEEPER_POLICY?: string;
}

/**
 * What the Upstream entrypoint receives as `ctx.props`, and therefore what the
 * runtime folds into its cache key. Deliberately a digest of the caller's
 * permissions rather than the caller's identity. See `policy.ts`.
 */
export interface UpstreamProps {
  scopeDigest: string;
}

export interface CacheMetadata {
  /** Canonical key the call resolved to. */
  key: string;
  /** Opaque id stamped by the Upstream entrypoint when it actually ran. */
  originId: string;
  originFetchedAt: string;
  ageMs: number;
  /**
   * `Cf-Cache-Status` as reported by Workers Cache: HIT, MISS, BYPASS,
   * UPDATING, EXPIRED or REVALIDATED. Null where the runtime does not set it,
   * which includes local `wrangler dev`.
   */
  status: string | null;
  /**
   * True when the response did not come from GitHub on this request. Taken
   * from `status` when the runtime reports it, and otherwise inferred: Upstream
   * stamps the wall clock at the moment it fetched, so a response older than a
   * couple of seconds cannot have been produced by the request in flight.
   */
  servedFromCache: boolean;
  /** Remaining upstream GitHub quota, as reported on the last real fetch. */
  upstreamRateLimitRemaining: number | null;
}

export interface GatekeeperResult<T> {
  data: T;
  cache: CacheMetadata;
}
