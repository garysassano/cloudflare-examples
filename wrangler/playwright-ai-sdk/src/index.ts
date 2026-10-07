import { type Browser, launch } from "@cloudflare/playwright";
import { generateText, hasToolCall, isStepCount, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { browserTools } from "./browserTools";

// Debbie O'Brien's Playwright movies demo. It replaced demo.playwright.dev/movies,
// whose data API no longer resolves.
const MOVIES_APP_URL = "https://debs-obrien.github.io/playwright-movies-app/";

// The browser may open pages only on these hosts. Images and API calls the
// pages make themselves are not restricted.
const ALLOWED_HOSTS = ["debs-obrien.github.io"];

// Any Workers AI model with tool calling works here. Nemotron 3 120B A12B is
// available on the Workers Free plan and has a 256k token context, which
// matters because every tool result carries a page snapshot.
const MODEL = "@cf/nvidia/nemotron-3-120b-a12b";

// Each step is one model call; this bounds the whole run.
const MAX_STEPS = 20;

const MovieInfo = z.object({
  title: z.string(),
  year: z.number(),
  rating: z.number(),
  genres: z.array(z.string()),
  duration: z.number().describe("Duration in minutes"),
});

const TASK = `Open ${MOVIES_APP_URL}, search for "Furiosa", open the matching movie,
and call report_movie with its details.`;

function isAllowed(url: string): boolean {
  const parsed = URL.parse(url);
  const host = parsed?.hostname ?? "";
  const listed = ALLOWED_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  return (parsed?.protocol === "http:" || parsed?.protocol === "https:") && listed;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });

    let browser: Browser | undefined;
    try {
      browser = await launch(env.BROWSER);
      const page = await browser.newPage();

      // Refuse every page-level navigation off the allowed hosts: a URL the
      // model typed, a link it clicked, or a redirect.
      await page.route("**/*", (route) => {
        const request = route.request();
        const offHost =
          request.isNavigationRequest() &&
          !request.frame().parentFrame() &&
          !isAllowed(request.url());
        return offHost ? route.abort("blockedbyclient") : route.continue();
      });

      const result = await generateText({
        model: createWorkersAI({ binding: env.AI })(MODEL),
        prompt: TASK,
        tools: {
          ...browserTools(page),
          // No execute function: the run ends when the model calls it.
          report_movie: tool({
            description: "Report the movie's details.",
            inputSchema: MovieInfo,
          }),
        },
        // Every step is a tool call, so the model acts or reports, never chats.
        toolChoice: "required",
        stopWhen: [hasToolCall("report_movie"), isStepCount(MAX_STEPS)],
      });

      const report = result.toolCalls.find((call) => call.toolName === "report_movie");
      if (!report) throw new Error(`No report after ${result.steps.length} steps`);
      return Response.json(report.input);
    } catch (error) {
      // Report the failure instead of crashing the invocation, so the caller
      // sees why the agent stopped rather than Cloudflare's error 1101.
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 502 });
    } finally {
      // Always release the browser: an open session keeps consuming browser
      // time and a concurrency slot until it times out.
      await browser?.close();
    }
  },
} satisfies ExportedHandler<Env>;
