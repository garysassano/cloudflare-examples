import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/playwright", () => ({ launch: vi.fn() }));

import { createHandler } from "../src/index.js";

describe("screenshot worker", () => {
  it("creates the todo list and returns its screenshot", async () => {
    const fill = vi.fn();
    const press = vi.fn();
    const goto = vi.fn();
    const screenshot = vi.fn().mockResolvedValue(Uint8Array.from([137, 80, 78, 71]));
    const close = vi.fn();
    const page = {
      goto,
      getByPlaceholder: vi.fn().mockReturnValue({ fill, press }),
      screenshot,
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close,
    };
    const launchBrowser = vi.fn().mockResolvedValue(browser);
    const binding = {} as Env["BROWSER"];
    const handler = createHandler(launchBrowser as unknown as Parameters<typeof createHandler>[0]);

    const response = await handler.fetch(new Request("https://example.com"), {
      BROWSER: binding,
    } as Env);

    expect(launchBrowser).toHaveBeenCalledWith(binding);
    expect(goto).toHaveBeenCalledWith("https://demo.playwright.dev/todomvc");
    expect(fill.mock.calls).toEqual([
      ["buy some cheese"],
      ["feed the cat"],
      ["book a doctors appointment"],
    ]);
    expect(press).toHaveBeenCalledTimes(3);
    expect(press).toHaveBeenCalledWith("Enter");
    expect(screenshot).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from([137, 80, 78, 71]),
    );
  });
});
