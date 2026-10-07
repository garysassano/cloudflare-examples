import {
  BetaAbstractBrowserToolset20260801,
  type BetaBrowserNavigateResult,
  type BetaBrowserState,
  type BetaBrowserToolsetOptions,
  type BetaScreenshotResult,
  type BetaToolsetCallContext,
  ToolError,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type {
  BetaBrowserClickTarget,
  BetaBrowserFindInput,
  BetaBrowserFormInputInput,
  BetaBrowserGetPageTextInput,
  BetaBrowserHoverInput,
  BetaBrowserKeyInput,
  BetaBrowserLeftClickInput,
  BetaBrowserNavigateInput,
  BetaBrowserReadPageInput,
  BetaBrowserScreenshotInput,
  BetaBrowserScrollInput,
  BetaBrowserScrollToInput,
  BetaBrowserStateTabEntry,
  BetaBrowserTypeInput,
  BetaBrowserWaitInput,
} from "@anthropic-ai/sdk/resources/beta";
import type { Browser, BrowserContext, Page } from "@cloudflare/playwright";

type StateChange = NonNullable<BetaBrowserState["state_changes"]>[number];

// The viewport Claude's coordinates refer to. Screenshots are taken at this
// size, so they already fit the model's image limits.
const VIEWPORT = { width: 1280, height: 800 };

// The API caps read_page output at 50,000 characters, and find at 20 matches.
const MAX_PAGE_CHARS = 50_000;
const MAX_FIND_MATCHES = 20;
const DEFAULT_DEPTH = 15;

// Pixels per scroll-wheel notch.
const NOTCH_PX = 100;

// Playwright's private AI snapshot: the accessibility tree that Playwright MCP
// serves, with a `[ref=e12]` tag on each element and an `aria-ref=e12`
// selector engine to find it again. It is not in Playwright's public types.
type SnapshottingPage = Page & { _snapshotForAI(): Promise<{ full: string }> };

const KEY_NAMES: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  space: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pageup: "PageUp",
  page_up: "PageUp",
  pagedown: "PageDown",
  page_down: "PageDown",
  home: "Home",
  end: "End",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  super: "Meta",
};

/** "ctrl+shift+a" -> "Control+Shift+a", the chord syntax Playwright's keyboard takes. */
function toChord(text: string): string {
  return text
    .split("+")
    .map((part) => KEY_NAMES[part.toLowerCase()] ?? part)
    .join("+");
}

type Modifier = "Alt" | "Control" | "Meta" | "Shift";

function toModifiers(modifiers: string | null | undefined): Modifier[] | undefined {
  if (!modifiers) return undefined;
  return modifiers.split("+").map((part) => toChord(part) as Modifier);
}

/**
 * A browser toolset driver over a Playwright browser, such as one from
 * Cloudflare Browser Run. The SDK routes Claude's calls to the members below,
 * runs the URL policy first, and builds each `tool_result`.
 *
 * Members this class leaves out (zoom, drag, the raw mouse buttons, uploads,
 * console, network, and JavaScript) are sent to the API as disabled.
 */
export class PlaywrightBrowser extends BetaAbstractBrowserToolset20260801 {
  readonly #context: BrowserContext;
  readonly #tabs = new Map<string, Page>();
  readonly #tabIds = new WeakMap<Page, string>();
  #changes: StateChange[] = [];
  #active: string | undefined;
  #nextTab = 1;

  private constructor(
    context: BrowserContext,
    options: Omit<BetaBrowserToolsetOptions, "browserState">,
  ) {
    super({ ...options, browserState: () => this.#report() });
    this.#context = context;
    // Pages a site opens on its own, such as a target="_blank" link, become tabs.
    context.on("page", (page) => this.#adopt(page));
  }

  /**
   * Opens a context with one blank tab. `isAllowed` vets every main-frame
   * navigation, including links Claude clicks and redirects, which the SDK's
   * URL policy never sees.
   */
  static async open(
    browser: Browser,
    isAllowed: (url: string) => boolean,
    options: Omit<BetaBrowserToolsetOptions, "browserState"> = {},
  ): Promise<PlaywrightBrowser> {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
    const driver = new PlaywrightBrowser(context, options);
    await context.route("**/*", (route) => {
      const request = route.request();
      if (
        !request.isNavigationRequest() ||
        request.frame().parentFrame() ||
        isAllowed(request.url())
      ) {
        return route.continue();
      }
      driver.#changes.push({ type: "navigation_refused" });
      return route.abort("blockedbyclient");
    });
    await context.newPage();
    return driver;
  }

  #adopt(page: Page): void {
    const id = `tab-${this.#nextTab++}`;
    this.#tabs.set(id, page);
    this.#tabIds.set(page, id);
    this.#active = id;
    this.#changes.push({ type: "tab_opened", tab_id: id });
    page.on("dialog", (dialog) => {
      this.#changes.push({
        type: "dialog_dismissed",
        kind: dialog.type(),
        message: dialog.message(),
      });
      dialog.dismiss().catch(() => {});
    });
    page.on("close", () => {
      this.#tabs.delete(id);
      if (this.#active === id) this.#active = this.#tabs.keys().next().value;
    });
  }

  #page(tabId: string | null | undefined): Page {
    const id = tabId ?? this.#active;
    const page = id === undefined ? undefined : this.#tabs.get(id);
    if (!page) throw new ToolError(tabId ? `no tab ${tabId}` : "no tab is open");
    return page;
  }

  async #entry(id: string, page: Page): Promise<BetaBrowserStateTabEntry> {
    const title = await page.title().catch(() => "");
    return { tab_id: id, title, url: page.url(), active: id === this.#active };
  }

  async #report(): Promise<BetaBrowserState> {
    const tabs = await Promise.all([...this.#tabs].map(([id, page]) => this.#entry(id, page)));
    const state_changes = this.#changes;
    this.#changes = [];
    return { tabs, state_changes };
  }

  /** Clicks, hovers and the like take either an element ref or a viewport point. */
  async #pointAt(
    page: Page,
    target: BetaBrowserClickTarget,
    act: (x: number, y: number) => Promise<void>,
  ): Promise<void> {
    if (target.type === "coordinate") return act(target.x, target.y);
    const box = await this.#locate(page, target.ref).boundingBox();
    if (!box) throw new ToolError(`${target.ref} is not visible`);
    return act(box.x + box.width / 2, box.y + box.height / 2);
  }

  #locate(page: Page, ref: string) {
    return page.locator(`aria-ref=${ref.replace(/^ref_/, "")}`);
  }

  async #snapshot(page: Page): Promise<string[]> {
    const { full } = await (page as SnapshottingPage)._snapshotForAI();
    // Playwright tags elements `[ref=e12]`; the toolset's convention is `[ref_e12]`.
    return full.replaceAll(/\[ref=([^\]]+)\]/g, "[ref_$1]").split("\n");
  }

  protected override async navigate(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserNavigateInput,
  ): Promise<BetaBrowserNavigateResult> {
    const page = this.#page(input.tab_id);
    const response =
      input.url === "back"
        ? await page.goBack()
        : input.url === "forward"
          ? await page.goForward()
          : input.url === "reload"
            ? await page.reload()
            : // Same scheme rule as the URL policy, so the browser opens the URL it checked.
              await page.goto(
                /^[a-z][a-z0-9+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`,
              );
    return { url: page.url(), status: response?.status(), title: await page.title() };
  }

  protected override async screenshot(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserScreenshotInput,
  ): Promise<BetaScreenshotResult> {
    const png = await this.#page(input.tab_id).screenshot({ type: "png" });
    return { data: png.toString("base64"), mediaType: "image/png" };
  }

  protected override async left_click(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserLeftClickInput,
  ): Promise<void> {
    const page = this.#page(input.tab_id);
    const modifiers = toModifiers(input.modifiers);
    if (input.target.type === "ref") {
      await this.#locate(page, input.target.ref).click({ modifiers });
      return;
    }
    for (const key of modifiers ?? []) await page.keyboard.down(key);
    await page.mouse.click(input.target.x, input.target.y);
    for (const key of modifiers ?? []) await page.keyboard.up(key);
  }

  protected override async hover(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserHoverInput,
  ): Promise<void> {
    const page = this.#page(input.tab_id);
    await this.#pointAt(page, input.target, (x, y) => page.mouse.move(x, y));
  }

  protected override async scroll(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserScrollInput,
  ): Promise<void> {
    const page = this.#page(input.tab_id);
    const px = (input.scroll_amount ?? 3) * NOTCH_PX;
    const [dx, dy] = {
      up: [0, -px],
      down: [0, px],
      left: [-px, 0],
      right: [px, 0],
    }[input.scroll_direction];
    await page.mouse.move(input.target.x, input.target.y);
    await page.mouse.wheel(dx, dy);
  }

  protected override async scroll_to(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserScrollToInput,
  ): Promise<void> {
    await this.#locate(this.#page(input.tab_id), input.target.ref).scrollIntoViewIfNeeded();
  }

  protected override async type_(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserTypeInput,
  ): Promise<void> {
    await this.#page(input.tab_id).keyboard.type(input.text);
  }

  protected override async key(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserKeyInput,
  ): Promise<void> {
    const keyboard = this.#page(input.tab_id).keyboard;
    for (let i = 0; i < (input.repeat ?? 1); i++) {
      for (const chord of input.text.split(" ").filter(Boolean))
        await keyboard.press(toChord(chord));
    }
  }

  protected override async form_input(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserFormInputInput,
  ): Promise<void> {
    const element = this.#locate(this.#page(input.tab_id), input.target.ref);
    if (typeof input.value === "boolean") return element.setChecked(input.value);
    const tag = await element.evaluate((node) => node.tagName);
    if (tag === "SELECT") {
      await element.selectOption(String(input.value));
      return;
    }
    await element.fill(String(input.value));
  }

  /**
   * The accessibility tree, cut to `depth` levels below the root or below
   * `ref`. `filter` is not applied: Playwright's snapshot already omits hidden
   * elements, and it covers the whole page, not only the viewport.
   */
  protected override async read_page(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserReadPageInput,
  ): Promise<string> {
    let lines = await this.#snapshot(this.#page(input.tab_id));
    const indentOf = (line: string) => line.search(/\S/);

    if (input.ref) {
      const start = lines.findIndex((line) => line.includes(`[${input.ref}]`));
      if (start < 0) throw new ToolError(`${input.ref} is not on the page; read the page again`);
      const rootIndent = indentOf(lines[start]);
      const end = lines.findIndex((line, i) => i > start && indentOf(line) <= rootIndent);
      lines = lines.slice(start, end < 0 ? undefined : end);
    }

    const base = indentOf(lines[0] ?? "");
    const depth = input.depth ?? DEFAULT_DEPTH;
    const tree = lines.filter((line) => (indentOf(line) - base) / 2 < depth).join("\n");
    return tree.length > MAX_PAGE_CHARS
      ? `${tree.slice(0, MAX_PAGE_CHARS)}\n[truncated: read a subtree with ref, or a smaller depth]`
      : tree;
  }

  /** Elements whose snapshot line mentions every word of the query. */
  protected override async find(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserFindInput,
  ): Promise<string> {
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (await this.#snapshot(this.#page(input.tab_id)))
      .filter(
        (line) =>
          line.includes("[ref_") && words.every((word) => line.toLowerCase().includes(word)),
      )
      .slice(0, MAX_FIND_MATCHES)
      .map((line) => line.trim());
    return matches.length ? matches.join("\n") : `No element matches "${input.query}".`;
  }

  protected override async get_page_text(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserGetPageTextInput,
  ): Promise<string> {
    return this.#page(input.tab_id).locator("body").innerText();
  }

  protected override async wait(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserWaitInput,
  ): Promise<void> {
    await this.#page(input.tab_id).waitForTimeout(input.duration * 1000);
  }

  override async close(): Promise<void> {
    await super.close(); // first, so no call is still using the browser
    await this.#context.close();
  }
}
