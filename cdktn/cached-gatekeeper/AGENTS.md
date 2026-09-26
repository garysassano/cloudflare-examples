# Agent notes

For authorization, cache, resource-routing, or entrypoint changes, read the relevant architecture section in `README.md` and preserve these load-bearing invariants:

1. **Only `github.ts` reads `GITHUB_TOKEN`.** The point of a gatekeeper is one auditable place where the credential is used. Reading it anywhere else defeats the design.
2. **The gateway entrypoint must stay uncached.** `cache: { enabled: false }` on `default` is what guarantees every call is authorized, including the ones the cache answers. Enabling it would serve responses without an authorization check.
3. **Caching only ever happens on the `Upstream` entrypoint,** reached via `ctx.exports`. Workers Cache does not cache RPC, so any new capability method must route through a loopback `fetch()` to be cacheable.
4. **The canonical cache key must remain a valid GitHub REST path.** `resources.ts` builds the key and the fetched URL from the same value. Deriving them separately lets them drift, and a drifted cache serves one resource under another's key.
5. **Purging runs inside `Upstream`, never the gateway.** `ctx.cache.purge()` acts on the calling entrypoint's cache, and the gateway has none, so purging there silently does nothing while reporting success.
6. **`ctx.props` carries a digest of the caller's read scope, not their identity.** Identity would be safe but would cache nothing. Widening what goes in there changes the security boundary.
7. **The loopback request must carry no `Authorization` or `Cookie` header.** Workers Cache bypasses requests that do, which would disable caching entirely.
8. **`wrangler.jsonc` and `src/stacks/my-stack.ts` must agree** on cache config, compatibility date, and compatibility flags. Wrangler drives `pnpm dev`, Terraform drives the deploy. A test asserts this; keep it passing.

## Validation and live proof

```sh
pnpm check
pnpm dev
pnpm run deploy
```

`pnpm check` is local and has no production access. For implementation changes, run it, fix failures caused by the work, and rerun affected checks before finishing.

`wrangler dev` exercises logic but does not apply Workers Cache. A cache-behavior claim requires a deployment; when the task includes live verification, prove hits by watching `originId` stop changing or run `pnpm bench` against the deployed URL. Deployment requires `CLOUDFLARE_API_TOKEN`.

No em dashes in prose, here or in the README.
