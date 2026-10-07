import Anthropic from "@anthropic-ai/sdk";
import { type BetaURLContext, ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { type Browser, launch } from "@cloudflare/playwright";
import { z } from "zod";
import { PlaywrightBrowser } from "./playwrightBrowser";

// Debbie O'Brien's Playwright movies demo. It replaced demo.playwright.dev/movies,
// whose data API no longer resolves.
const MOVIES_APP_URL = "https://debs-obrien.github.io/playwright-movies-app/";

// Claude may open pages only on these hosts. Images and API calls the pages
// make themselves are not restricted; Browser Run's network isolates the browser.
const ALLOWED_HOSTS = ["debs-obrien.github.io"];

// Each turn can carry several browser calls; this bounds the whole run.
const MAX_TURNS = 25;

const MovieInfo = z.object({
  title: z.string(),
  year: z.number(),
  rating: z.number(),
  genres: z.array(z.string()),
  duration: z.number().describe("Duration in minutes"),
});

const TASK = `Open ${MOVIES_APP_URL}, search for "Furiosa", open the matching movie, and report its details.`;

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

function isAllowed(url: string): boolean {
  if (url.toLowerCase() === "about:blank") return true;
  const withScheme = SCHEME_PREFIX.test(url) ? url : `https://${url}`;
  // A browser reads "\" as "/" in a web URL.
  const parsed = URL.parse(withScheme.replaceAll("\\", "/"));
  const host = parsed?.hostname ?? "";
  const listed = ALLOWED_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  return (parsed?.protocol === "http:" || parsed?.protocol === "https:") && listed;
}

function urlPolicy(_ctx: BetaURLContext, url: string): void {
  if (!isAllowed(url)) throw new ToolError(`blocked: ${url} is not on an allowed host`);
}

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    let session: Browser | undefined;
    let browser: PlaywrightBrowser | undefined;
    try {
      session = await launch(env.BROWSER);
      browser = await PlaywrightBrowser.open(session, isAllowed, { urlPolicy });

      const message = await client.beta.messages.toolRunner({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        max_iterations: MAX_TURNS,
        // The final answer is JSON matching MovieInfo; tool calls are unaffected.
        output_config: { effort: "medium", format: betaZodOutputFormat(MovieInfo) },
        // On a policy refusal, the API reruns the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: [browser],
        messages: [{ role: "user", content: TASK }],
      });

      if (message.stop_reason !== "end_turn") {
        throw new Error(`Claude stopped before answering: ${message.stop_reason}`);
      }
      const answer = message.content.findLast((block) => block.type === "text")?.text ?? "";
      const movie = MovieInfo.safeParse(JSON.parse(answer));
      if (!movie.success) throw new Error(`Claude's answer is not a MovieInfo: ${answer}`);
      return Response.json(movie.data);
    } catch (error) {
      // Report the failure instead of crashing the invocation, so the caller
      // sees why the agent stopped rather than Cloudflare's error 1101.
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 502 });
    } finally {
      // Always release the browser: an open session keeps consuming browser
      // time and a concurrency slot until it times out.
      await browser?.close();
      await session?.close();
    }
  },
} satisfies ExportedHandler<Env>;
