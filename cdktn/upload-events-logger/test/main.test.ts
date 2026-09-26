import { App, Testing } from "cdktn";
import { describe, expect, it } from "vitest";
import { MyStack } from "../src/stacks/my-stack.js";

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

  it("creates the upload and log buckets", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_r2_bucket", {
        name: "upload-bucket",
      }),
    ).toBe(true);
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_r2_bucket", {
        name: "log-bucket",
      }),
    ).toBe(true);
  });

  it("announces uploads on the queue", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_queue", {
        queue_name: "upload-events",
      }),
    ).toBe(true);
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_r2_bucket_event_notification", {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
        bucket_name: "${cloudflare_r2_bucket.UploadBucket.name}",
        rules: [
          {
            actions: ["PutObject"],
            description: "Notifications from source bucket to queue",
          },
        ],
      }),
    ).toBe(true);
  });

  it("uploads the bundled Worker as an ES module", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script", {
        script_name: "event-logger",
        main_module: "index.js",
        compatibility_flags: ["new_module_registry"],
        observability: { enabled: true },
      }),
    ).toBe(true);

    const script =
      JSON.parse(synthesized).resource.cloudflare_workers_script.EventNotificationWriter;
    expect(script.content_file).toMatch(/^assets\/EventNotificationWriterBundle\/.+\/index\.js$/);
    expect(script.content_sha256).toBe(`\${filesha256("${script.content_file}")}`);
  });

  it("binds the log bucket the Worker writes to", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script", {
        bindings: [
          {
            type: "r2_bucket",
            name: "LOG_BUCKET",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
            bucket_name: "${cloudflare_r2_bucket.LogBucket.name}",
          },
        ],
      }),
    ).toBe(true);
  });

  it("subscribes the Worker to the queue in batches", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_queue_consumer", {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
        script_name: "${cloudflare_workers_script.EventNotificationWriter.script_name}",
        settings: {
          batch_size: 100,
          max_wait_time_ms: 5000,
        },
      }),
    ).toBe(true);
  });
});
