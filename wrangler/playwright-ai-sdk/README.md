# wrangler-playwright-ai-sdk

Wrangler app in which a Workers AI model drives a Cloudflare Browser Run session through Playwright tools, deciding every step itself.

### Related Apps

- [wrangler/playwright-stagehand](../../wrangler/playwright-stagehand) - Scripts the steps with Stagehand instead of letting the model drive.
- [wrangler/playwright-anthropic-sdk](../../wrangler/playwright-anthropic-sdk) - Uses Claude's browser toolset and the paid Claude API instead of Workers AI.

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

Open the `workers.dev` URL from the deployment output. A `GET /` gives the model one task: open the [Playwright movies demo](https://debs-obrien.github.io/playwright-movies-app/), search for "Furiosa", open the result, and report the movie's details. The Worker answers with those details as JSON.

If the run fails, the Worker answers `502` with the reason as `{ "error": ... }` and still closes the browser.

## Cleanup

```sh
pnpm wrangler delete
```

## How it works

The model drives the workflow. The Worker gives it the whole task and a set of browser tools, and Vercel's [AI SDK](https://ai-sdk.dev/) (`ai`) runs the loop. On each step, the model picks one tool call, the Worker carries it out with Playwright, and the result goes back to the model. The run ends when the model calls `report_movie`, or after 20 steps.

A run, step by step. The model sets the order, and the Worker carries out what it asks:

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker (AI SDK loop)
  participant AI as Workers AI
  participant B as Browser Run

  W->>AI: goal + tool list
  loop until report_movie, at most 20 steps
    AI-->>W: tool call: navigate, type, click...
    W->>B: perform it with Playwright
    B-->>W: new snapshot with element refs
    W->>AI: tool result: the snapshot
  end
  AI-->>W: report_movie({ title, year, ... })
  Note over W: Zod checks the report, and the Worker returns it
```

`src/browserTools.ts` holds the tools, modeled on [Playwright MCP](https://github.com/microsoft/playwright-mcp)'s: `navigate`, `snapshot`, `click`, `type`, `press_key`, and `select_option`. They run inside the Worker rather than behind an MCP server. Each tool answers with Playwright's AI snapshot of the page: the accessibility tree that Playwright MCP serves, with a ref on each element for the next click or input. That method is private in Playwright (`page._snapshotForAI()`), so a Playwright upgrade can change it.

`report_movie` has no `execute` function. Its Zod schema checks the model's report, and the Worker returns that report as the response. `toolChoice: "required"` makes every step a tool call, so the model can't stop by replying in prose.

A Playwright route refuses every page-level navigation off `ALLOWED_HOSTS`, whether the model typed the URL, clicked a link, or followed a redirect. Images and API requests that the page makes itself are not checked.

The model is `@cf/qwen/qwen3.8-27b` at low reasoning effort. It is available on the Workers Free plan and has a 262k token context for the page snapshots. Any Workers AI model with tool calling works; change `MODEL` in `src/index.ts`. Open models are less reliable than frontier models at multi-step browsing, so expect some runs to stop without a report.

On the Workers Free plan, Browser Run allows 10 minutes of browser time per day and one new browser every 20 seconds. Past either limit, runs fail with a `429` until the allowance resets.

## Code-driven or model-driven

This example lets the model plan the steps. [`wrangler/playwright-stagehand`](../../wrangler/playwright-stagehand) runs the same task the other way round: its code scripts the steps and asks the model only how to perform each one. [`wrangler/playwright-anthropic-sdk`](../../wrangler/playwright-anthropic-sdk) is model-driven too, with Claude's browser toolset and the paid Claude API.

```mermaid
flowchart LR
  subgraph S["playwright-stagehand: code-driven"]
    direction TB
    C1["Code fixes the steps:<br/>goto, search, click result, extract"] --> Q1["Ask the model one<br/>narrow question per step"]
    Q1 --> A1["Stagehand performs the answer"]
    A1 --> N1{"More steps<br/>in the script?"}
    N1 -- yes --> Q1
    N1 -- no --> R1["Return the extracted JSON"]
  end
  subgraph M["playwright-ai-sdk: model-driven"]
    direction TB
    C2["Code gives the goal<br/>and a set of tools"] --> Q2["Model picks the next tool call"]
    Q2 --> A2["Worker runs it with Playwright<br/>and returns a fresh snapshot"]
    A2 --> N2{"Did the model call<br/>report_movie?"}
    N2 -- no --> Q2
    N2 -- yes --> R2["Return the report as JSON"]
  end
```

| | `playwright-stagehand` | `playwright-ai-sdk` |
| --- | --- | --- |
| Who plans the steps | the code | the model |
| Model calls per run | a few, fixed by the script | one per step, chosen by the model |
| Predictability | same steps on every run | the model can wander or stop early |
| Unexpected pages, such as a cookie banner | the run fails unless the script handles them | the model can deal with them first |
| How the model reaches the browser | Stagehand's own prompts, through `WorkersAIClient` | standard tool calling, through `workers-ai-provider` |
| Structured result | `extract({ schema })` | the `report_movie` tool's schema |
| Dependencies | Stagehand 2.5 and Zod 3, the newest Browser Run supports | current AI SDK and Zod 4 |

Scripted steps suit a fixed, known flow like this one. A model-driven agent suits tasks where the goal is clear but the exact steps aren't. Stagehand 3 supports both styles, but Browser Run supports only Stagehand 2.5.
