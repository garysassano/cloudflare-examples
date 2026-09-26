import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetType, Fn, TerraformAsset, TerraformStack, TerraformVariable } from "cdktn";
import type { Construct } from "constructs";
import { DataCloudflareAccounts } from "../../.gen/providers/cloudflare/data-cloudflare-accounts/index.js";
import { CloudflareProvider } from "../../.gen/providers/cloudflare/provider/index.js";
import { WorkersScript } from "../../.gen/providers/cloudflare/workers-script/index.js";
import { WorkersScriptSubdomain } from "../../.gen/providers/cloudflare/workers-script-subdomain/index.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Starting policy. Two credentials with the same read scope share cached
 * entries, which is the design. `writer-key` additionally carries write access
 * to one repository, because reading a backlog should not imply being able to
 * comment on it.
 */
const DEMO_POLICY = {
  "demo-key": {
    subject: "demo",
    allow: ["cloudflare/*"],
  },
  "writer-key": {
    subject: "writer",
    allow: ["cloudflare/*"],
    write: ["cloudflare/cloudflare-os"],
  },
  "narrow-key": {
    subject: "narrow",
    allow: ["cloudflare/workerd"],
  },
};

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    //==============================================================================
    // Cloudflare Configuration
    //==============================================================================

    new CloudflareProvider(this, "CloudflareProvider");

    const cfAccounts = new DataCloudflareAccounts(this, "CloudflareAccounts", {
      direction: "asc",
      maxItems: 1,
    });

    const mainAccountId = cfAccounts.result.get(0).id;

    //==============================================================================
    // Inputs
    //==============================================================================

    // Optional. An empty token is a supported mode: the gatekeeper falls back to
    // the anonymous GitHub API (60 requests/hour), which makes what the cache is
    // doing impossible to miss.
    const githubToken = new TerraformVariable(this, "GithubToken", {
      type: "string",
      default: "",
      sensitive: true,
      description: "GitHub token the Upstream entrypoint uses. Never exposed to callers.",
    });

    // Maps a caller credential to the repositories that credential may read and
    // write. A digest of the read set, not the caller's identity, is what
    // partitions the cache.
    const gatekeeperPolicy = new TerraformVariable(this, "GatekeeperPolicy", {
      type: "string",
      default: JSON.stringify(DEMO_POLICY),
      sensitive: true,
      description: "JSON policy table mapping caller credentials to scopes.",
    });

    //==============================================================================
    // Cloudflare Workers
    //==============================================================================

    // Worker bundle built by `pnpm bundle`, copied into the synthesized stack.
    const workerBundle = new TerraformAsset(this, "GatekeeperBundle", {
      path: join(projectRoot, "dist", "index.js"),
      type: AssetType.FILE,
    });

    const gatekeeper = new WorkersScript(this, "Gatekeeper", {
      accountId: mainAccountId,
      scriptName: "cached-gatekeeper",
      contentFile: workerBundle.path,
      contentSha256: Fn.filesha256(workerBundle.path),
      mainModule: "index.js",
      compatibilityDate: "2026-09-18",
      compatibilityFlags: ["new_module_registry"],
      // Traces feed the Agents view in the dashboard, which is worth having on
      // a Worker whose whole job is serving agents.
      observability: {
        enabled: true,
        traces: { enabled: true },
      },

      // The whole point of the project. Caching is off for the Worker as a
      // whole, so the default entrypoint, which authorizes every call, always
      // runs. It is on for `Upstream`, the entrypoint that holds the GitHub
      // credential, so a cache hit never reaches GitHub at all.
      cacheOptions: { enabled: false },
      exports: {
        default: { type: "worker", cache: { enabled: false } },
        Upstream: { type: "worker", cache: { enabled: true } },
      },

      bindings: [
        {
          type: "secret_text",
          name: "GITHUB_TOKEN",
          text: githubToken.stringValue,
        },
        {
          type: "secret_text",
          name: "GATEKEEPER_POLICY",
          text: gatekeeperPolicy.stringValue,
        },
      ],
    });

    // Workers Cache belongs to the Worker rather than to a zone, so it behaves
    // identically here as it would behind a custom domain.
    new WorkersScriptSubdomain(this, "GatekeeperSubdomain", {
      accountId: mainAccountId,
      scriptName: gatekeeper.scriptName,
      enabled: true,
      previewsEnabled: true,
    });
  }
}
