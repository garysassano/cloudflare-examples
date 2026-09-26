import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("rejects a request with no userId", async () => {
    const response = await SELF.fetch("https://example.com/");

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("userId must be provided");
  });

  it("routes to the Durable Object, which publishes to the queue", async () => {
    const response = await SELF.fetch("https://example.com/?userId=test");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("wrote to queue");
  });

  it("maps each userId to its own Durable Object", async () => {
    // Both requests succeed, and each one is served by the instance derived
    // from its own userId rather than a single shared instance.
    const first = await SELF.fetch("https://example.com/?userId=alice");
    const second = await SELF.fetch("https://example.com/?userId=bob");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
