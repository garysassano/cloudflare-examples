/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "sst-file-upload-api",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "cloudflare",
    };
  },

  async run() {
    const bucket = new sst.cloudflare.Bucket("MyBucket");

    const api = new sst.cloudflare.Worker("Api", {
      handler: "index.ts",
      compatibility: { date: "2026-09-18", flags: ["new_module_registry"] },
      url: true,
      link: [bucket],
    });

    return {
      url: api.url,
    };
  },
});
