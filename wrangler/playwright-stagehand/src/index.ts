import { Stagehand } from "@browserbasehq/stagehand";
import { endpointURLString } from "@cloudflare/playwright";
import { z } from "zod";
import { WorkersAIClient } from "./workersAIClient";

// Debbie O'Brien's Playwright movies demo. It replaced demo.playwright.dev/movies,
// whose data API no longer resolves.
const MOVIES_APP_URL = "https://debs-obrien.github.io/playwright-movies-app/";

const MovieInfo = z.object({
  title: z.string(),
  year: z.number(),
  rating: z.number(),
  genres: z.array(z.string()),
  duration: z.number().describe("Duration in minutes"),
});

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });

    const stagehand = new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: { cdpUrl: endpointURLString(env.BROWSER) },
      llmClient: new WorkersAIClient(env.AI),
      verbose: 1,
    });

    let initialized = false;
    try {
      await stagehand.init();
      initialized = true;
      const page = stagehand.page;

      await page.goto(MOVIES_APP_URL);

      // A search can take several steps, so observe returns every action to perform.
      const actions = await page.observe('Search for "Furiosa"');
      for (const action of actions) await page.act(action);

      await page.act("Click the search result");

      // Plain Playwright calls work alongside the AI ones.
      await page.waitForSelector(".cast");

      const movieInfo = await page.extract({
        instruction: "Extract movie information",
        schema: MovieInfo,
      });

      return Response.json(movieInfo);
    } catch (error) {
      // Report the failure instead of crashing the invocation, so the caller
      // sees why the agent stopped rather than Cloudflare's error 1101.
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 502 });
    } finally {
      // Always release the browser: an open session keeps consuming browser
      // time and a concurrency slot until it times out. `close()` throws on an
      // instance whose `init()` failed (for example a 429 from Browser Run),
      // which would replace the error response above with a crash.
      if (initialized) await stagehand.close();
    }
  },
} satisfies ExportedHandler<Env>;
