import { describe, expect, it } from "vitest";
import {
  bucketPageSize,
  canonicalKey,
  canonicalQuery,
  normalizeRepo,
} from "../src/worker/cache-key.js";

describe("canonicalQuery", () => {
  it("is independent of key order", () => {
    const a = canonicalQuery({ state: "closed", labels: ["bug"], assignee: "ada" });
    const b = canonicalQuery({ assignee: "ada", state: "closed", labels: ["bug"] });
    expect(a).toBe(b);
  });

  it("treats list values as sets", () => {
    const a = canonicalQuery({ labels: ["bug", "p1"] });
    const b = canonicalQuery({ labels: ["p1", "bug", "bug"] });
    expect(a).toBe(b);
  });

  it("collapses an explicit default onto the omitted form", () => {
    const defaults = { state: "open" };
    expect(canonicalQuery({ state: "open", page: 2 }, defaults)).toBe(
      canonicalQuery({ page: 2 }, defaults),
    );
  });

  it("keeps a non-default value", () => {
    expect(canonicalQuery({ state: "closed" }, { state: "open" })).toBe("state=closed");
  });

  it("drops cache-busting and tracking parameters", () => {
    expect(canonicalQuery({ q: "x", _: "1729", timestamp: "now", utm_source: "agent" })).toBe(
      "q=x",
    );
  });

  it("drops empty and nullish values", () => {
    expect(canonicalQuery({ a: "", b: null, c: undefined, d: "  ", e: "1" })).toBe("e=1");
  });
});

describe("bucketPageSize", () => {
  it("snaps nearby sizes onto one bucket", () => {
    expect(bucketPageSize(25)).toBe(bucketPageSize(30));
    expect(bucketPageSize(31)).toBe(50);
  });

  it("falls back to the upstream default for absent or invalid sizes", () => {
    expect(bucketPageSize(undefined)).toBe(30);
    expect(bucketPageSize(0)).toBe(30);
    expect(bucketPageSize(Number.NaN)).toBe(30);
  });

  it("clamps above the maximum", () => {
    expect(bucketPageSize(5000)).toBe(100);
  });
});

describe("normalizeRepo", () => {
  it("is case insensitive and strips a .git suffix", () => {
    expect(normalizeRepo("CloudFlare", "Cloudflare-OS.git")).toBe("cloudflare/cloudflare-os");
  });
});

describe("canonicalKey", () => {
  it("produces a valid upstream path with no query when nothing survives", () => {
    expect(canonicalKey("/repos/cloudflare/workerd", { _: "1" })).toBe("/repos/cloudflare/workerd");
  });

  it("normalizes duplicate and trailing slashes", () => {
    expect(canonicalKey("//repos//cloudflare/workerd/")).toBe("/repos/cloudflare/workerd");
  });
});
