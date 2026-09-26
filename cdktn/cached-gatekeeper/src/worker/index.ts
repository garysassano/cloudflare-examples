/**
 * The gatekeeper.
 *
 * Two things are happening in this file, and the second one is the reason the
 * project exists.
 *
 * 1. It is a Cloudflare OS style Gatekeeper: agents get typed methods
 *    (`listIssues`, `getFile`) instead of a GitHub token, and every call is
 *    authorized against the caller's scope before anything is fetched.
 *
 * 2. Workers Cache does not cache RPC. Only `fetch()` on a WorkerEntrypoint
 *    goes through it. `ctx.exports.Backend.getUser(id)` bypasses the cache
 *    entirely. So a gatekeeper built the obvious way, as a bag of RPC methods,
 *    can never be cached, and every agent that re-asks the same question pays
 *    full upstream latency and full rate limit.
 *
 *    The fix is to keep the RPC surface for the agent and route each method
 *    through an internal HTTP call to a second entrypoint. The agent still sees
 *    `await env.GITHUB.listIssues({...})`; underneath, that becomes a cacheable
 *    GET against `Upstream`, and on a hit `Upstream` never runs.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { explorerPage } from "./explorer.js";
import { githubFetch } from "./github.js";
import type { Scope } from "./policy.js";
import {
  AuthorizationError,
  assertAllowed,
  assertWritable,
  parsePolicy,
  resolveScope,
  scopeDigest,
} from "./policy.js";
import type { ResourcePlan } from "./resources.js";
import {
  planFile,
  planIssue,
  planIssues,
  planPulls,
  planRepo,
  planSearchIssues,
} from "./resources.js";
import type { CacheMetadata, Env, GatekeeperResult } from "./types.js";

export { Upstream } from "./upstream.js";

/**
 * Fallback hit threshold, used only where the runtime does not set
 * `Cf-Cache-Status`. Generous enough to absorb a slow upstream fetch and small
 * clock skew.
 */
const FRESH_THRESHOLD_MS = 2_000;

/** Internal origin for loopback requests. The host is not part of the cache key. */
const LOOPBACK_ORIGIN = "https://gatekeeper.internal";

export class UpstreamError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Upstream responded ${status}`);
    this.name = "UpstreamError";
    this.status = status;
    this.body = body;
  }
}

interface Credentialed {
  /** Only needed when calling over RPC without platform-supplied props. */
  credential?: string;
}

export default class Gatekeeper extends WorkerEntrypoint<Env> {
  // ---------------------------------------------------------------------
  // Capability binding. This is what an agent sees.
  // ---------------------------------------------------------------------

  async getRepo(input: Credentialed & { owner: string; repo: string }) {
    return this.read(input.credential, planRepo(input.owner, input.repo));
  }

  async listIssues(
    input: Credentialed & {
      owner: string;
      repo: string;
      state?: "open" | "closed" | "all";
      labels?: string[];
      assignee?: string;
      perPage?: number;
      page?: number;
    },
  ) {
    return this.read(input.credential, planIssues(input));
  }

  async getIssue(input: Credentialed & { owner: string; repo: string; number: number }) {
    return this.read(input.credential, planIssue(input.owner, input.repo, input.number));
  }

  async listPullRequests(
    input: Credentialed & {
      owner: string;
      repo: string;
      state?: "open" | "closed" | "all";
      base?: string;
      perPage?: number;
      page?: number;
    },
  ) {
    return this.read(input.credential, planPulls(input));
  }

  async getFile(input: Credentialed & { owner: string; repo: string; path: string; ref?: string }) {
    return this.read(input.credential, planFile(input.owner, input.repo, input.path, input.ref));
  }

  async searchIssues(input: Credentialed & { query: string; perPage?: number; page?: number }) {
    return this.read(input.credential, planSearchIssues(input.query, input.perPage, input.page));
  }

  /**
   * The write path, and the other half of a correct cache.
   *
   * A cache that is only ever filled is a cache that lies. Every mutation
   * purges the tags covering what it changed, so the agent that just commented
   * on an issue does not then read a version of that issue without its own
   * comment, the single most confusing thing a cached agent tool can do.
   */
  async commentOnIssue(
    input: Credentialed & { owner: string; repo: string; number: number; body: string },
  ) {
    const scope = this.scopeFor(input.credential);
    const plan = planIssue(input.owner, input.repo, input.number);
    assertWritable(scope, plan.repo);

    if (!this.env.GITHUB_TOKEN) {
      throw new UpstreamError(501, "Writes require GITHUB_TOKEN to be configured.");
    }

    const response = await githubFetch(this.env, `${plan.key}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: input.body }),
      headers: { "content-type": "application/json" },
    });
    const text = await response.text();
    if (!response.ok) throw new UpstreamError(response.status, text);

    // Purging runs inside Upstream, because `ctx.cache.purge()` acts on the
    // calling entrypoint's cache and the gateway deliberately has none.
    const purged = plan.tags.filter((tag) => tag !== `repo:${plan.repo}`);
    const result = await this.ctx.exports.Upstream.purge(purged);

    return { data: JSON.parse(text) as unknown, purgedTags: purged, purge: result };
  }

  /** Purge by tag without writing, for callers that mutate GitHub elsewhere. */
  async invalidate(input: Credentialed & { tags: string[] }) {
    const scope = this.scopeFor(input.credential);
    for (const tag of input.tags) {
      const slug = tag.split(":")[1]?.split("#")[0];
      if (slug?.includes("/")) assertWritable(scope, slug);
    }
    const result = await this.ctx.exports.Upstream.purge(input.tags);
    return { purgedTags: input.tags, purge: result };
  }

  // ---------------------------------------------------------------------
  // HTTP surface: the same capabilities, for anything that is not an OS
  // service binding, plus a page that makes the cache visible.
  // ---------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(explorerPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, tokenConfigured: Boolean(this.env.GITHUB_TOKEN) });
    }

    const credential = bearer(request) ?? url.searchParams.get("key") ?? undefined;

    try {
      const result = await this.route(request, url, credential);
      if (!result) return json({ error: "Not found." }, 404);
      return json(result);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return json({ error: error.message }, error.status);
      }
      if (error instanceof UpstreamError) {
        return json({ error: error.message, upstream: safeJson(error.body) }, error.status);
      }
      throw error;
    }
  }

  private async route(
    request: Request,
    url: URL,
    credential: string | undefined,
  ): Promise<unknown | null> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1") return null;
    const q = url.searchParams;

    if (segments[1] === "search" && segments[2] === "issues") {
      return this.searchIssues({
        credential,
        query: q.get("q") ?? "",
        perPage: numberParam(q.get("per_page")),
      });
    }

    // Purge by tag. Reachable over HTTP so the invalidation path is testable
    // without a service binding, and usable by callers that mutate GitHub
    // elsewhere and only need the cache told about it.
    if (segments[1] === "invalidate" && request.method === "POST") {
      const payload = (await request.json()) as { tags?: string[] };
      return this.invalidate({ credential, tags: payload.tags ?? [] });
    }

    if (segments[1] !== "repos" || !segments[2] || !segments[3]) return null;
    const owner = segments[2];
    const repo = segments[3];

    // /v1/repos/:owner/:repo
    if (segments.length === 4) return this.getRepo({ credential, owner, repo });

    // /v1/repos/:owner/:repo/issues/:n/comments  (POST)
    if (segments[4] === "issues" && segments[6] === "comments" && request.method === "POST") {
      const payload = (await request.json()) as { body?: string };
      return this.commentOnIssue({
        credential,
        owner,
        repo,
        number: Number(segments[5]),
        body: payload.body ?? "",
      });
    }

    if (segments[4] === "issues" && segments[5]) {
      return this.getIssue({ credential, owner, repo, number: Number(segments[5]) });
    }
    if (segments[4] === "issues") {
      return this.listIssues({
        credential,
        owner,
        repo,
        state: (q.get("state") as "open" | "closed" | "all" | null) ?? undefined,
        labels: q.get("labels")?.split(",") ?? undefined,
        perPage: numberParam(q.get("per_page")),
      });
    }
    if (segments[4] === "pulls") {
      return this.listPullRequests({
        credential,
        owner,
        repo,
        state: (q.get("state") as "open" | "closed" | "all" | null) ?? undefined,
        perPage: numberParam(q.get("per_page")),
      });
    }
    if (segments[4] === "contents") {
      return this.getFile({
        credential,
        owner,
        repo,
        path: segments.slice(5).join("/"),
        ref: q.get("ref") ?? undefined,
      });
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private scopeFor(credential: string | undefined): Scope {
    const policy = parsePolicy(this.env.GATEKEEPER_POLICY);
    // Under Cloudflare OS the platform authenticates the caller and delivers
    // identity as props; standalone, the caller presents a credential.
    const fromProps = (this.ctx.props as { credential?: string } | undefined)?.credential;
    return resolveScope(policy, credential ?? fromProps ?? null);
  }

  private async read<T>(
    credential: string | undefined,
    plan: ResourcePlan,
  ): Promise<GatekeeperResult<T>> {
    const scope = this.scopeFor(credential);
    if (plan.repo) assertAllowed(scope, plan.repo);

    const digest = await scopeDigest(scope);

    // Deliberately a bare GET with no inherited headers. An `Authorization`
    // or `Cookie` header on this request would make Workers Cache bypass the
    // entry entirely. That is the correct default for a public cache and
    // exactly the wrong outcome here, since authorization has already been
    // decided above and is represented by the scope digest in props.
    const request = new Request(`${LOOPBACK_ORIGIN}${plan.key}`, { method: "GET" });

    // Calling the loopback stub with props returns a fetcher bound to them.
    // The props land in the callee's cache key, which is what keeps one
    // scope's cached responses out of another scope's reach.
    const response = await this.ctx.exports
      .Upstream({ props: { scopeDigest: digest } })
      .fetch(request);

    const text = await response.text();
    if (!response.ok) throw new UpstreamError(response.status, text);

    return { data: JSON.parse(text) as T, cache: readCacheMetadata(plan.key, response) };
  }
}

/** Statuses that mean the request was answered without running Upstream. */
const CACHED_STATUSES = new Set(["HIT", "UPDATING", "REVALIDATED"]);

function readCacheMetadata(key: string, response: Response): CacheMetadata {
  const fetchedAt = response.headers.get("x-origin-fetched-at") ?? "";
  const parsed = Date.parse(fetchedAt);
  const ageMs = Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0;
  const remainingRaw = response.headers.get("x-upstream-ratelimit-remaining") ?? "";
  const remaining = remainingRaw === "" ? null : Number.parseInt(remainingRaw, 10);
  const status = response.headers.get("cf-cache-status");

  return {
    key,
    originId: response.headers.get("x-origin-id") ?? "",
    originFetchedAt: fetchedAt,
    ageMs,
    status,
    // Prefer what the runtime reports; fall back to the age heuristic where it
    // reports nothing, as local `wrangler dev` does.
    servedFromCache: status ? CACHED_STATUSES.has(status) : ageMs > FRESH_THRESHOLD_MS,
    upstreamRateLimitRemaining: Number.isFinite(remaining as number) ? remaining : null,
  };
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function numberParam(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
