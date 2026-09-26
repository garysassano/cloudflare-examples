import { launch } from "@cloudflare/playwright";

type LaunchBrowser = typeof launch;

export const createHandler = (launchBrowser: LaunchBrowser = launch) => ({
  async fetch(_request: Request, env: Env) {
    const browser = await launchBrowser(env.BROWSER);
    const page = await browser.newPage();

    await page.goto("https://demo.playwright.dev/todomvc");

    const TODO_ITEMS = ["buy some cheese", "feed the cat", "book a doctors appointment"];

    const newTodo = page.getByPlaceholder("What needs to be done?");
    for (const item of TODO_ITEMS) {
      await newTodo.fill(item);
      await newTodo.press("Enter");
    }

    const img = await page.screenshot();
    await browser.close();

    return new Response(img, {
      headers: {
        "Content-Type": "image/png",
      },
    });
  },
});

export default createHandler();
