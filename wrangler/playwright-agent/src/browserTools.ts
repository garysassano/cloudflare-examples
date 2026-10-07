import type { Page } from "@cloudflare/playwright";
import { tool } from "ai";
import { z } from "zod";

// Larger snapshots are cut, so one page can't exhaust the model's context.
const MAX_SNAPSHOT_CHARS = 40_000;

// Playwright's private AI snapshot: the accessibility tree that Playwright MCP
// serves, with a `[ref=e12]` tag on each element and an `aria-ref=e12`
// selector engine to find it again. It is not in Playwright's public types.
type SnapshottingPage = Page & { _snapshotForAI(): Promise<{ full: string }> };

const ref = z.string().describe('Element ref from the latest snapshot, such as "e12"');

/**
 * Browser tools in the style of Playwright MCP, run in-process on one page.
 * Every action answers with a fresh snapshot, so the model sees the page it
 * changed without spending a turn on reading it.
 */
export function browserTools(page: Page) {
  const snapshot = async (): Promise<string> => {
    const { full } = await (page as SnapshottingPage)._snapshotForAI();
    const text = `URL: ${page.url()}\n${full}`;
    return text.length > MAX_SNAPSHOT_CHARS
      ? `${text.slice(0, MAX_SNAPSHOT_CHARS)}\n[truncated]`
      : text;
  };
  const element = (target: string) => page.locator(`aria-ref=${target}`);

  return {
    navigate: tool({
      description: "Open a URL in the browser.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        await page.goto(url);
        return snapshot();
      },
    }),
    snapshot: tool({
      description: "Read the current page as an accessibility tree with element refs.",
      inputSchema: z.object({}),
      execute: snapshot,
    }),
    click: tool({
      description: "Click an element.",
      inputSchema: z.object({ ref }),
      execute: async ({ ref }) => {
        await element(ref).click();
        return snapshot();
      },
    }),
    type: tool({
      description: "Replace the text in an input, optionally pressing Enter afterwards.",
      inputSchema: z.object({ ref, text: z.string(), submit: z.boolean().optional() }),
      execute: async ({ ref, text, submit }) => {
        await element(ref).fill(text);
        if (submit) await element(ref).press("Enter");
        return snapshot();
      },
    }),
    press_key: tool({
      description: 'Press a key on the focused element, such as "Enter", "Escape" or "ArrowDown".',
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        await page.keyboard.press(key);
        return snapshot();
      },
    }),
    select_option: tool({
      description: "Choose an option in a select element, by value or label.",
      inputSchema: z.object({ ref, value: z.string() }),
      execute: async ({ ref, value }) => {
        await element(ref).selectOption(value);
        return snapshot();
      },
    }),
  };
}
