import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetType, Fn, TerraformAsset, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { DataCloudflareAccounts } from "../../.gen/providers/cloudflare/data-cloudflare-accounts/index.js";
import { CloudflareProvider } from "../../.gen/providers/cloudflare/provider/index.js";
import { WorkersScript } from "../../.gen/providers/cloudflare/workers-script/index.js";
import { WorkersScriptSubdomain } from "../../.gen/providers/cloudflare/workers-script-subdomain/index.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
    // Cloudflare Workers
    //==============================================================================

    // Worker bundle built by `pnpm bundle`, copied into the synthesized stack.
    const workerBundle = new TerraformAsset(this, "ScreenshotWorkerBundle", {
      path: join(projectRoot, "dist", "index.js"),
      type: AssetType.FILE,
    });

    const screenshotWorker = new WorkersScript(this, "ScreenshotWorker", {
      accountId: mainAccountId,
      scriptName: "screenshot-worker",
      contentFile: workerBundle.path,
      contentSha256: Fn.filesha256(workerBundle.path),
      mainModule: "index.js",
      compatibilityDate: "2026-09-18",
      compatibilityFlags: ["new_module_registry"],
      observability: {
        enabled: true,
      },
      bindings: [
        {
          type: "browser",
          name: "BROWSER",
        },
      ],
    });

    new WorkersScriptSubdomain(this, "ScreenshotWorkerSubdomain", {
      accountId: mainAccountId,
      scriptName: screenshotWorker.scriptName,
      enabled: true,
      previewsEnabled: true,
    });
  }
}
