import { describe, expect, it } from "vitest";
import {
  isFetchablePath,
  kindForPath,
  planFile,
  planIssue,
  planIssues,
  planRepo,
  tagsForPath,
} from "../src/worker/resources.js";

describe("plans", () => {
  it("gives semantically identical calls one cache key", () => {
    const a = planIssues({ owner: "Cloudflare", repo: "workerd", state: "open", perPage: 30 });
    const b = planIssues({ owner: "cloudflare", repo: "WorkerD", perPage: 25 });
    expect(a.key).toBe(b.key);
  });

  it("separates calls that differ semantically", () => {
    const open = planIssues({ owner: "a", repo: "b" });
    const closed = planIssues({ owner: "a", repo: "b", state: "closed" });
    expect(open.key).not.toBe(closed.key);
  });

  it("keeps file paths case sensitive and strips a leading slash", () => {
    expect(planFile("a", "b", "/src/Index.ts").key).toBe("/repos/a/b/contents/src/Index.ts");
  });

  it("produces keys that are valid upstream paths", () => {
    for (const plan of [
      planRepo("a", "b"),
      planIssue("a", "b", 7),
      planIssues({ owner: "a", repo: "b", state: "closed" }),
      planFile("a", "b", "README.md", "main"),
    ]) {
      expect(isFetchablePath(plan.key.split("?")[0] as string)).toBe(true);
    }
  });
});

describe("tags", () => {
  it("agree between the plan and the path they are recovered from", () => {
    const plan = planIssue("a", "b", 7);
    expect(tagsForPath("/repos/a/b/issues/7").sort()).toEqual([...plan.tags].sort());
  });

  it("let an issue write invalidate the lists that contain it", () => {
    const issueTags = planIssue("a", "b", 7).tags;
    const listTags = planIssues({ owner: "a", repo: "b" }).tags;
    expect(issueTags).toEqual(expect.arrayContaining(listTags));
  });
});

describe("upstream path allowlist", () => {
  it("accepts catalogued paths", () => {
    expect(isFetchablePath("/repos/a/b/issues/12")).toBe(true);
    expect(isFetchablePath("/search/issues")).toBe(true);
  });

  it("rejects anything else the credential must not reach", () => {
    for (const path of ["/user", "/users/ada/keys", "/repos/a/b/actions/secrets", "/"]) {
      expect(isFetchablePath(path)).toBe(false);
    }
  });
});

describe("kindForPath", () => {
  it("distinguishes a single issue from a list", () => {
    expect(kindForPath("/repos/a/b/issues")).toBe("issues");
    expect(kindForPath("/repos/a/b/issues/1")).toBe("issue");
  });
});
