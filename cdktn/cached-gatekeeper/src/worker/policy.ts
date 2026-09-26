/**
 * Authorization, and the trick that makes it cheap.
 *
 * A gatekeeper has to answer "may this caller see this resource?" before every
 * fetch. The obvious way to keep a cache safe under that rule is to key it by
 * user id, which is correct and nearly useless: a hundred engineers with
 * identical read access to the same repositories generate a hundred copies of
 * every response.
 *
 * Instead the cache is keyed by a digest of the *scope*, meaning the set of
 * resources a caller may read. Two callers with the same scope cannot, by construction,
 * receive anything the other was not already entitled to, so they can safely
 * share an entry. Two callers with different scopes never touch the same key.
 * Authorization stays per-caller; the cache partitions per-permission.
 */

export interface Scope {
  /** Stable identity of the caller, for logging. Never part of the cache key. */
  subject: string;
  /** Repository glob patterns, e.g. `cloudflare/*`. A lone `*` matches one segment. */
  allow: string[];
  /**
   * Repositories the caller may *write* to. Separate from `allow` on purpose:
   * an agent that can read a backlog should not thereby be able to comment on
   * it. Omitted means read-only.
   */
  write?: string[];
}

export interface PolicyTable {
  [credential: string]: Scope;
}

export class AuthorizationError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthorizationError";
    this.status = status;
  }
}

export function parsePolicy(raw: string | undefined): PolicyTable {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PolicyTable;
  } catch {
    return {};
  }
}

export function resolveScope(policy: PolicyTable, credential: string | null): Scope {
  if (!credential) {
    throw new AuthorizationError("Missing caller credential.", 401);
  }
  const scope = policy[credential];
  if (!scope) {
    throw new AuthorizationError("Unknown caller credential.", 401);
  }
  return scope;
}

/** A single `owner/repo` glob. `*` matches within one path segment. */
function matchesPattern(pattern: string, repo: string): boolean {
  const escaped = pattern
    .trim()
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(repo);
}

export function isAllowed(scope: Scope, repo: string): boolean {
  return scope.allow.some((pattern) => matchesPattern(pattern, repo.toLowerCase()));
}

export function assertAllowed(scope: Scope, repo: string): void {
  if (!isAllowed(scope, repo)) {
    throw new AuthorizationError(`Scope "${scope.subject}" may not read ${repo}.`);
  }
}

export function isWritable(scope: Scope, repo: string): boolean {
  const patterns = scope.write ?? [];
  return patterns.some((pattern) => matchesPattern(pattern, repo.toLowerCase()));
}

export function assertWritable(scope: Scope, repo: string): void {
  // Writing implies reading, so both checks run and the read error wins first.
  assertAllowed(scope, repo);
  if (!isWritable(scope, repo)) {
    throw new AuthorizationError(`Scope "${scope.subject}" may not write to ${repo}.`);
  }
}

/**
 * A short, stable digest of the scope's *rules*, deliberately not of the
 * subject. Sorted and deduplicated so two equivalent policies written in a
 * different order still collide, which is the whole point.
 */
export async function scopeDigest(scope: Scope): Promise<string> {
  const canonical = [...new Set(scope.allow.map((p) => p.trim().toLowerCase()))].sort().join("\n");
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
