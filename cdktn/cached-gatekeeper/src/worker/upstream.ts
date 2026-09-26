/**
 * The cached entrypoint.
 *
 * `wrangler.jsonc` and the Terraform stack enable Workers Cache for this
 * entrypoint and only this entrypoint. On a hit the runtime answers before any
 * of this code runs, which is why the credential and the upstream call live
 * here rather than in the gateway: a cache hit must not be able to reach GitHub
 * at all.
 *
 * This is also the half of the Worker that is *not* reachable from the network.
 * It has no route and no service binding; the gateway addresses it through
 * `ctx.exports`, which is exactly the hop Workers Cache sits on.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { githubFetch, rateLimitRemaining } from "./github.js";
import { FRESHNESS, isFetchablePath, kindForPath, tagsForPath } from "./resources.js";
import type { Env, UpstreamProps } from "./types.js";

/** A 404 from GitHub is cached briefly; agents guess file paths constantly. */
const NOT_FOUND_FRESHNESS = { maxAge: 30, staleWhileRevalidate: 60 };

export class Upstream extends WorkerEntrypoint<Env, UpstreamProps> {
  /**
   * The cacheable read path.
   *
   * The request URL *is* the canonical cache key: `resources.ts` builds every
   * key as a valid GitHub REST path, so the key and the fetched URL cannot
   * drift apart and there is no need for `cf.cacheKey`, which is just as well,
   * since that override is Enterprise-gated.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!isFetchablePath(url.pathname)) {
      return json({ error: "Path not in the gatekeeper's resource catalogue." }, 404, {
        "cache-control": "no-store",
      });
    }

    const upstream = await githubFetch(this.env, url.pathname + url.search);
    const body = await upstream.text();
    const remaining = rateLimitRemaining(upstream);

    const stamped: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      // Stamped only when this code actually ran, so a repeated id across a run
      // proves the response came from the cache rather than from GitHub.
      "x-origin-id": crypto.randomUUID(),
      "x-origin-fetched-at": new Date().toISOString(),
      "x-upstream-status": String(upstream.status),
      "x-upstream-ratelimit-remaining": remaining === null ? "" : String(remaining),
    };

    if (upstream.ok) {
      const freshness = FRESHNESS[kindForPath(url.pathname)];
      stamped["cache-control"] =
        `public, max-age=${freshness.maxAge}, stale-while-revalidate=${freshness.staleWhileRevalidate}`;
      stamped["cache-tag"] = tagsForPath(url.pathname).join(",");
      return new Response(body, { status: 200, headers: stamped });
    }

    if (upstream.status === 404) {
      stamped["cache-control"] =
        `public, max-age=${NOT_FOUND_FRESHNESS.maxAge}, stale-while-revalidate=${NOT_FOUND_FRESHNESS.staleWhileRevalidate}`;
      stamped["cache-tag"] = tagsForPath(url.pathname).join(",");
      return new Response(body, { status: 404, headers: stamped });
    }

    // Never cache a rate-limit or auth failure. Caching a 403 turns a transient
    // upstream problem into a sticky one for everyone sharing the scope, which
    // is the worst failure mode this design has.
    stamped["cache-control"] = "no-store";
    return new Response(body, { status: upstream.status, headers: stamped });
  }

  /**
   * Invalidation has to run *here*, not in the gateway.
   *
   * `ctx.cache.purge()` acts on the calling entrypoint's cache. The gateway has
   * no cache, which is the whole design, so purging from there would silently
   * do nothing while appearing to succeed. Reaching this over RPC is fine:
   * Workers Cache does not cache RPC, and a purge should never be cached.
   */
  async purge(tags: string[]): Promise<{ success: boolean; errors: string[] }> {
    // `ctx.cache` is absent when caching is not enabled for the entrypoint,
    // which includes some local development configurations.
    const cache = this.ctx.cache;
    if (!cache) return { success: false, errors: ["Workers Cache is not enabled."] };

    const result = await cache.purge({ tags });
    return { success: result.success, errors: result.errors.map((error) => String(error.message)) };
  }
}

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
