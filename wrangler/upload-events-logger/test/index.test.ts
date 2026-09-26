import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

function messageFor(key: string) {
  return {
    account: "test-account",
    bucket: "upload-bucket",
    eventTime: "2026-08-20T00:00:00.000Z",
    action: "PutObject",
    object: { key, size: 12, eTag: `etag-for-${key}` },
  };
}

function batchOf(bodies: unknown[]) {
  return {
    queue: "upload-events",
    messages: bodies.map((body, i) => ({
      id: `msg-${i}`,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack() {},
      retry() {},
    })),
    ackAll() {},
    retryAll() {},
  };
}

async function readOnlyObject() {
  const listed = await env.LOG_BUCKET.list();
  expect(listed.objects).toHaveLength(1);

  const key = listed.objects[0].key;
  const written = await env.LOG_BUCKET.get(key);
  if (!written) throw new Error(`${key} was listed but could not be read`);

  return { key, written };
}

describe("queue consumer", () => {
  // The Worker runtime keeps R2 state across tests in this pool, so each test
  // starts from an empty bucket rather than assuming ordering.
  beforeEach(async () => {
    const listed = await env.LOG_BUCKET.list();
    await Promise.all(listed.objects.map((o) => env.LOG_BUCKET.delete(o.key)));
  });

  it("writes the whole batch to R2 as a single JSON file", async () => {
    const bodies = [messageFor("a.txt"), messageFor("b.txt")];

    await worker.queue(batchOf(bodies) as never, env);

    const { written } = await readOnlyObject();
    const parsed = JSON.parse(await written.text());

    expect(parsed).toHaveLength(2);
    expect(parsed.map((m: { body: { object: { key: string } } }) => m.body.object.key)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("names the file after the batch timestamp and marks it as JSON", async () => {
    await worker.queue(batchOf([messageFor("c.txt")]) as never, env);

    const { key, written } = await readOnlyObject();

    expect(key).toMatch(/^upload-logs-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
    expect(written.httpMetadata?.contentType).toBe("application/json");
  });
});
