# cdktn-playwright-screenshot

CDKTN app that takes a web page screenshot using Cloudflare Browser Run with Playwright.

### Related Apps

- [wrangler/playwright-screenshot](../../wrangler/playwright-screenshot) - Built with Wrangler instead of CDKTN.

## Architecture Diagram

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./src/assets/arch-diagram-dark.svg">
  <img alt="Architecture Diagram" src="./src/assets/arch-diagram.svg">
</picture>

## Prerequisites

- **_Cloudflare:_**
  - Must have set the `CLOUDFLARE_API_TOKEN` variable in your local environment, with the `Workers Scripts:Edit` and `Account Settings:Read` permissions.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages Node, pnpm, and OpenTofu.

## Installation

```sh
mise install
pnpm install
pnpm gen
```

`pnpm gen` generates the Cloudflare provider constructs into `.gen/`. Re-run it whenever the provider constraint in `cdktf.json` changes.

## Deployment

```sh
pnpm run deploy
```

## Cleanup

```sh
pnpm destroy
```

## How it works

Wrangler owns the Worker **bundle**, CDKTN owns the **deployment**:

1. `pnpm bundle` runs `wrangler deploy --dry-run --outdir dist`, which bundles `src/worker/index.ts` with the Node.js compatibility polyfills that `@cloudflare/playwright` needs (on by default from compatibility date 2026-08-04).
2. `src/stacks/my-stack.ts` picks up `dist/index.js` as a `TerraformAsset` and uploads it through `cloudflare_workers_script` (`content_file` + `content_sha256`), with the Browser Run binding declared in Terraform.

`pnpm synth`, `pnpm diff`, `pnpm run deploy`, and `pnpm test` all run the bundle step first, so the synthesized stack always matches the current source. The stack reads `dist/index.js` while it is being constructed, so nothing that instantiates it works without a bundle.

`pnpm dev` runs the Worker locally through `wrangler dev` using the same `wrangler.jsonc`. Keep the compatibility date, compatibility flags, and bindings in `wrangler.jsonc` in sync with `src/stacks/my-stack.ts`. Wrangler needs them to bundle and to run locally, OpenTofu needs them to deploy.
