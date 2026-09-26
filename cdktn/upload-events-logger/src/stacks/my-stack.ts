import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetType, Fn, TerraformAsset, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { DataCloudflareAccounts } from "../../.gen/providers/cloudflare/data-cloudflare-accounts/index.js";
import { CloudflareProvider } from "../../.gen/providers/cloudflare/provider/index.js";
import { Queue } from "../../.gen/providers/cloudflare/queue/index.js";
import { QueueConsumer } from "../../.gen/providers/cloudflare/queue-consumer/index.js";
import { R2Bucket } from "../../.gen/providers/cloudflare/r2-bucket/index.js";
import { R2BucketEventNotification } from "../../.gen/providers/cloudflare/r2-bucket-event-notification/index.js";
import { WorkersScript } from "../../.gen/providers/cloudflare/workers-script/index.js";

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
    // Cloudflare R2
    //==============================================================================

    // Uploads land here; every PutObject is announced on the queue.
    const uploadBucket = new R2Bucket(this, "UploadBucket", {
      accountId: mainAccountId,
      name: "upload-bucket",
    });

    // The Worker writes one JSON file per consumed batch here.
    const logBucket = new R2Bucket(this, "LogBucket", {
      accountId: mainAccountId,
      name: "log-bucket",
    });

    //==============================================================================
    // Cloudflare Queues
    //==============================================================================

    const eventNotificationQueue = new Queue(this, "EventNotificationQueue", {
      accountId: mainAccountId,
      queueName: "upload-events",
    });

    new R2BucketEventNotification(this, "UploadBucketEventNotification", {
      accountId: mainAccountId,
      bucketName: uploadBucket.name,
      queueId: eventNotificationQueue.queueId,
      rules: [
        {
          actions: ["PutObject"],
          description: "Notifications from source bucket to queue",
        },
      ],
    });

    //==============================================================================
    // Cloudflare Workers
    //==============================================================================

    // Worker bundle built by `pnpm bundle`, copied into the synthesized stack.
    const workerBundle = new TerraformAsset(this, "EventNotificationWriterBundle", {
      path: join(projectRoot, "dist", "index.js"),
      type: AssetType.FILE,
    });

    const eventNotificationWriter = new WorkersScript(this, "EventNotificationWriter", {
      accountId: mainAccountId,
      scriptName: "event-logger",
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
          type: "r2_bucket",
          name: "LOG_BUCKET",
          bucketName: logBucket.name,
        },
      ],
    });

    new QueueConsumer(this, "EventNotificationQueueConsumer", {
      accountId: mainAccountId,
      queueId: eventNotificationQueue.queueId,
      type: "worker",
      scriptName: eventNotificationWriter.scriptName,
      settings: {
        batchSize: 100,
        maxWaitTimeMs: 5000,
      },
    });
  }
}
