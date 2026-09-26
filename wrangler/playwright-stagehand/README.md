# wrangler-playwright-stagehand

Wrangler app that instructs Stagehand to perform certain actions using Cloudflare Workers AI and Browser Run with Playwright.

## Architecture Diagram

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./src/assets/arch-diagram-dark.svg">
  <img alt="Architecture Diagram" src="./src/assets/arch-diagram.svg">
</picture>

## Prerequisites

- **_Cloudflare:_**
  - Must have set the `CLOUDFLARE_API_TOKEN` variable in your local environment, with the `Workers Scripts:Edit` and `Account Settings:Read` permissions.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages Node and pnpm.

## Installation

```sh
mise install
pnpm install
```

## Deployment

```sh
pnpm run deploy
```

## Usage

Open the `workers.dev` URL from the deployment output. The Worker drives a browser through the [Playwright movies demo](https://debs-obrien.github.io/playwright-movies-app/), searches for "Furiosa", opens the result, and returns the extracted movie details as JSON. A run takes around a minute.

If the run fails, the Worker answers `502` with the reason as `{ "error": ... }` and still closes the browser.

## Cleanup

```sh
pnpm wrangler delete
```

## How it works

Stagehand 2.5 drives a Browser Run session over CDP. Browser Run supports only Stagehand 2.5.x, because later versions are not Playwright-based, and Stagehand 2.5 in turn requires Zod 3.

`src/workersAIClient.ts` answers Stagehand's model calls with Workers AI. Every call carries a Zod schema; the client asks the model for JSON matching it, validates the reply, and retries a malformed one. The default model is `@cf/nvidia/nemotron-3-120b-a12b`. Any Workers AI model with an OpenAI-compatible chat API and JSON Schema output works; pass `{ model }` to `WorkersAIClient` to change it.

On the Workers Free plan, Browser Run allows 10 minutes of browser time per day and one new browser every 20 seconds. Past either limit, runs fail with a `429` until the allowance resets.
