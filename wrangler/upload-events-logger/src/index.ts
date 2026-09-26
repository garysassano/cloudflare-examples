export default {
  async queue(batch, env): Promise<void> {
    const batchId = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `upload-logs-${batchId}.json`;

    // Serialize the entire batch of messages to JSON
    const fileContent = new TextEncoder().encode(JSON.stringify(batch.messages));

    // Write the batch of messages to R2
    await env.LOG_BUCKET.put(fileName, fileContent, {
      httpMetadata: {
        contentType: "application/json",
      },
    });
  },
} satisfies ExportedHandler<Env>;
