import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App, Testing } from "cdktn";
import { describe, expect, it } from "vitest";
import { MyStack } from "../src/stacks/my-stack.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Strips `//` line comments that are not inside a string, then parses. */
function readJsonc<T>(path: string): T {
  const source = readFileSync(path, "utf8");
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += char;
  }
  return JSON.parse(out) as T;
}

describe("MyStack", () => {
  // `runValidations` makes synth fail on construct-level validation errors.
  const synthesized = Testing.synth(new MyStack(new App(), "test"), true);

  it("configures the Cloudflare provider and resolves the account", () => {
    expect(Testing.toHaveProvider(synthesized, "cloudflare")).toBe(true);
    expect(
      Testing.toHaveDataSourceWithProperties(synthesized, "cloudflare_accounts", {
        direction: "asc",
        max_items: 1,
      }),
    ).toBe(true);
  });

  it("uploads the bundled Worker as an ES module", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script", {
        script_name: "cached-gatekeeper",
        main_module: "index.js",
        compatibility_date: "2026-09-18",
        compatibility_flags: ["new_module_registry"],
      }),
    ).toBe(true);

    const script = JSON.parse(synthesized).resource.cloudflare_workers_script.Gatekeeper;
    expect(script.content_file).toMatch(/^assets\/GatekeeperBundle\/.+\/index\.js$/);
    expect(script.content_sha256).toBe(`\${filesha256("${script.content_file}")}`);
  });

  it("caches only the credentialed entrypoint", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script", {
        cache_options: { enabled: false },
        exports: {
          default: { type: "worker", cache: { enabled: false } },
          Upstream: { type: "worker", cache: { enabled: true } },
        },
      }),
    ).toBe(true);
  });

  it("keeps the wrangler bundle config in step with the deployed cache config", () => {
    // The two are separate sources of truth. Wrangler builds the bundle and
    // drives `pnpm dev`, Terraform deploys it, so a drift here means local
    // behaviour and deployed behaviour disagree about what is cached.
    const config = readJsonc<{
      cache: { enabled: boolean };
      exports: Record<string, { type: string; cache: { enabled: boolean } }>;
      compatibility_date: string;
      compatibility_flags: string[];
    }>(join(projectRoot, "wrangler.jsonc"));
    const script = JSON.parse(synthesized).resource.cloudflare_workers_script.Gatekeeper;

    expect(config.cache).toEqual(script.cache_options);
    expect(config.exports).toEqual(script.exports);
    expect(config.compatibility_date).toBe(script.compatibility_date);
    expect(config.compatibility_flags).toEqual(script.compatibility_flags);
  });

  it("passes both credentials as secret bindings, never as plain text", () => {
    const script = JSON.parse(synthesized).resource.cloudflare_workers_script.Gatekeeper;
    expect(script.bindings.map((binding: { name: string }) => binding.name).sort()).toEqual([
      "GATEKEEPER_POLICY",
      "GITHUB_TOKEN",
    ]);
    for (const binding of script.bindings) {
      expect(binding.type).toBe("secret_text");
    }
  });

  it("exposes the Worker on workers.dev, where Workers Cache still applies", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script_subdomain", {
        enabled: true,
        previews_enabled: true,
      }),
    ).toBe(true);
  });
});
