/**
 * The resource catalogue.
 *
 * Every read the gatekeeper exposes is planned here, and the plan's `key` is a
 * canonical GitHub REST path. Making the cache key *be* a valid upstream path
 * removes a class of bug that this architecture invites: if the key and the
 * fetched URL are derived separately they can drift, and a drifted cache serves
 * one resource under another's key.
 *
 * Nothing in this file performs I/O, so all of it is directly testable.
 */

import type { Params } from "./cache-key.js";
import { bucketPageSize, canonicalKey, normalizeRepo } from "./cache-key.js";

export type ResourceKind = "repo" | "issues" | "issue" | "pulls" | "pull" | "file" | "search";

export interface Freshness {
  /** Seconds a response is served without consulting GitHub. */
  maxAge: number;
  /**
   * Seconds past `maxAge` during which a stale response is served immediately
   * while the refresh happens out of band. This is the single most valuable
   * directive for an agent workload, because the agent is never blocked on a
   * revalidation it did not ask for. It is also the reason to reach for
   * Workers Cache rather than the older `caches.default` API, which ignores
   * `stale-while-revalidate` entirely.
   */
  staleWhileRevalidate: number;
}

export const FRESHNESS: Record<ResourceKind, Freshness> = {
  // Repository metadata: description, default branch, topics. Rarely moves.
  repo: { maxAge: 300, staleWhileRevalidate: 3600 },
  // Issue lists churn, but an agent triaging a backlog re-reads them constantly.
  issues: { maxAge: 60, staleWhileRevalidate: 600 },
  // A single issue is short-lived because an agent may be commenting on it.
  issue: { maxAge: 30, staleWhileRevalidate: 300 },
  pulls: { maxAge: 60, staleWhileRevalidate: 600 },
  pull: { maxAge: 30, staleWhileRevalidate: 300 },
  // File contents pinned to a ref are immutable in practice; unpinned ones are
  // still the thing an agent re-reads most often while writing code.
  file: { maxAge: 300, staleWhileRevalidate: 86400 },
  search: { maxAge: 120, staleWhileRevalidate: 600 },
};

export interface ResourcePlan {
  kind: ResourceKind;
  /** `owner/repo` the call reads, for the authorization check. Empty for search. */
  repo: string;
  /** Canonical GitHub REST path plus query. Used verbatim as the cache key. */
  key: string;
  tags: string[];
}

/** Upstream defaults, so an explicit default collapses onto the omitted form. */
const ISSUE_LIST_DEFAULTS: Params = {
  state: "open",
  sort: "created",
  direction: "desc",
  per_page: 30,
  page: 1,
};

const PULL_LIST_DEFAULTS: Params = {
  state: "open",
  sort: "created",
  direction: "desc",
  per_page: 30,
  page: 1,
};

function repoTag(repo: string): string {
  return `repo:${repo}`;
}

export function planRepo(owner: string, repo: string): ResourcePlan {
  const slug = normalizeRepo(owner, repo);
  return {
    kind: "repo",
    repo: slug,
    key: canonicalKey(`/repos/${slug}`),
    tags: [repoTag(slug)],
  };
}

export interface IssueListInput {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  sort?: string;
  direction?: string;
  perPage?: number;
  page?: number;
}

export function planIssues(input: IssueListInput): ResourcePlan {
  const slug = normalizeRepo(input.owner, input.repo);
  const params: Params = {
    state: input.state,
    labels: input.labels,
    assignee: input.assignee,
    sort: input.sort,
    direction: input.direction,
    per_page: bucketPageSize(input.perPage),
    page: input.page,
  };
  return {
    kind: "issues",
    repo: slug,
    key: canonicalKey(`/repos/${slug}/issues`, params, ISSUE_LIST_DEFAULTS),
    tags: [repoTag(slug), `issues:${slug}`],
  };
}

export function planIssue(owner: string, repo: string, number: number): ResourcePlan {
  const slug = normalizeRepo(owner, repo);
  return {
    kind: "issue",
    repo: slug,
    key: canonicalKey(`/repos/${slug}/issues/${number}`),
    tags: [repoTag(slug), `issue:${slug}#${number}`, `issues:${slug}`],
  };
}

export interface PullListInput {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  base?: string;
  sort?: string;
  direction?: string;
  perPage?: number;
  page?: number;
}

export function planPulls(input: PullListInput): ResourcePlan {
  const slug = normalizeRepo(input.owner, input.repo);
  const params: Params = {
    state: input.state,
    base: input.base,
    sort: input.sort,
    direction: input.direction,
    per_page: bucketPageSize(input.perPage),
    page: input.page,
  };
  return {
    kind: "pulls",
    repo: slug,
    key: canonicalKey(`/repos/${slug}/pulls`, params, PULL_LIST_DEFAULTS),
    tags: [repoTag(slug), `pulls:${slug}`],
  };
}

export function planFile(owner: string, repo: string, path: string, ref?: string): ResourcePlan {
  const slug = normalizeRepo(owner, repo);
  // File paths are case-sensitive, so they are not lowercased, only trimmed of
  // the leading slash an agent frequently includes and GitHub rejects.
  const cleanPath = path.replace(/^\/+/, "");
  const params: Params = { ref: ref ?? null };
  return {
    kind: "file",
    repo: slug,
    key: canonicalKey(`/repos/${slug}/contents/${cleanPath}`, params),
    tags: [repoTag(slug), `contents:${slug}`],
  };
}

export function planSearchIssues(query: string, perPage?: number, page?: number): ResourcePlan {
  const params: Params = {
    q: query.replace(/\s+/g, " ").trim(),
    per_page: bucketPageSize(perPage),
    page,
  };
  return {
    kind: "search",
    repo: "",
    key: canonicalKey("/search/issues", params, { per_page: 30, page: 1 }),
    tags: ["search:issues"],
  };
}

/**
 * Paths the Upstream entrypoint is willing to fetch.
 *
 * Upstream is the only holder of the GitHub credential, so it must not be a
 * general-purpose proxy. It is unreachable from outside the Worker, since only
 * `ctx.exports` addresses it, but an allowlist keeps a future bug in the
 * gateway from turning into credential laundering.
 */
const ALLOWED_PATHS: RegExp[] = [
  /^\/repos\/[\w.-]+\/[\w.-]+$/,
  /^\/repos\/[\w.-]+\/[\w.-]+\/issues$/,
  /^\/repos\/[\w.-]+\/[\w.-]+\/issues\/\d+$/,
  /^\/repos\/[\w.-]+\/[\w.-]+\/pulls$/,
  /^\/repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/,
  /^\/repos\/[\w.-]+\/[\w.-]+\/contents\/.+$/,
  /^\/search\/issues$/,
];

export function isFetchablePath(pathname: string): boolean {
  return ALLOWED_PATHS.some((pattern) => pattern.test(pathname));
}

/** Recover the resource kind from a canonical path, for freshness and tags. */
export function kindForPath(pathname: string): ResourceKind {
  if (/^\/search\//.test(pathname)) return "search";
  if (/\/contents\//.test(pathname)) return "file";
  if (/\/issues\/\d+$/.test(pathname)) return "issue";
  if (/\/pulls\/\d+$/.test(pathname)) return "pull";
  if (/\/issues$/.test(pathname)) return "issues";
  if (/\/pulls$/.test(pathname)) return "pulls";
  return "repo";
}

/** Cache tags for a canonical path, so Upstream can tag what it stores. */
export function tagsForPath(pathname: string): string[] {
  const repoMatch = pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)/);
  if (!repoMatch?.[1]) return ["search:issues"];
  const slug = repoMatch[1];
  const kind = kindForPath(pathname);
  switch (kind) {
    case "issue": {
      const number = pathname.split("/").pop();
      return [repoTag(slug), `issue:${slug}#${number}`, `issues:${slug}`];
    }
    case "issues":
      return [repoTag(slug), `issues:${slug}`];
    case "pull": {
      const number = pathname.split("/").pop();
      return [repoTag(slug), `pull:${slug}#${number}`, `pulls:${slug}`];
    }
    case "pulls":
      return [repoTag(slug), `pulls:${slug}`];
    case "file":
      return [repoTag(slug), `contents:${slug}`];
    default:
      return [repoTag(slug)];
  }
}
