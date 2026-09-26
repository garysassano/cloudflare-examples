/**
 * The only module that reads the GitHub credential.
 *
 * Keeping it to one file is the point of the gatekeeper pattern: agents receive
 * a typed capability, never a token, and there is exactly one place to audit
 * when asking "where could this credential go?".
 */

import type { Env } from "./types.js";

export const GITHUB_API = "https://api.github.com";

const USER_AGENT = "cloudflare-cached-gatekeeper";

export function githubHeaders(env: Env, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": USER_AGENT,
    ...extra,
  });
  // Absent token is a supported mode: the anonymous API allows 60 requests an
  // hour, which is a realistic way to see what the cache is actually doing.
  if (env.GITHUB_TOKEN) {
    headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`);
  }
  return headers;
}

export async function githubFetch(
  env: Env,
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${GITHUB_API}${pathAndQuery}`, {
    ...init,
    headers: githubHeaders(env, (init.headers as Record<string, string>) ?? {}),
  });
}

/** `x-ratelimit-remaining`, or null when GitHub did not report it. */
export function rateLimitRemaining(response: Response): number | null {
  const raw = response.headers.get("x-ratelimit-remaining");
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}
