import { describe, expect, it } from "vitest";
import type { Scope } from "../src/worker/policy.js";
import {
  AuthorizationError,
  assertAllowed,
  assertWritable,
  isAllowed,
  parsePolicy,
  resolveScope,
  scopeDigest,
} from "../src/worker/policy.js";

const readOnly: Scope = { subject: "agent", allow: ["cloudflare/*", "acme/widgets"] };

describe("glob matching", () => {
  it("matches within a single segment only", () => {
    expect(isAllowed(readOnly, "cloudflare/workerd")).toBe(true);
    expect(isAllowed(readOnly, "cloudflare/some/nested")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isAllowed(readOnly, "CloudFlare/Workerd")).toBe(true);
  });

  it("rejects a repository outside the scope", () => {
    expect(isAllowed(readOnly, "acme/secrets")).toBe(false);
    expect(() => assertAllowed(readOnly, "acme/secrets")).toThrow(AuthorizationError);
  });

  it("does not let a dot in the pattern act as a wildcard", () => {
    expect(isAllowed({ subject: "s", allow: ["acme/wid.ets"] }, "acme/widgets")).toBe(false);
  });
});

describe("write scope", () => {
  it("is not implied by read access", () => {
    expect(() => assertWritable(readOnly, "cloudflare/workerd")).toThrow(AuthorizationError);
  });

  it("still requires read access", () => {
    const scope: Scope = { subject: "s", allow: [], write: ["acme/widgets"] };
    expect(() => assertWritable(scope, "acme/widgets")).toThrow(/may not read/);
  });

  it("allows a repository present in both lists", () => {
    const scope: Scope = { subject: "s", allow: ["acme/*"], write: ["acme/widgets"] };
    expect(() => assertWritable(scope, "acme/widgets")).not.toThrow();
  });
});

describe("scopeDigest", () => {
  it("is identical for equivalent scopes written differently", async () => {
    const a = await scopeDigest({ subject: "ada", allow: ["b/*", "a/*", "A/*"] });
    const b = await scopeDigest({ subject: "grace", allow: ["a/*", "b/*"] });
    expect(a).toBe(b);
  });

  it("differs when the permitted set differs", async () => {
    const a = await scopeDigest({ subject: "x", allow: ["a/*"] });
    const b = await scopeDigest({ subject: "x", allow: ["a/*", "b/*"] });
    expect(a).not.toBe(b);
  });
});

describe("resolveScope", () => {
  const policy = parsePolicy('{"k":{"subject":"s","allow":["a/*"]}}');

  it("rejects a missing credential with 401", () => {
    expect(() => resolveScope(policy, null)).toThrow(
      expect.objectContaining({ status: 401 }) as Error,
    );
  });

  it("rejects an unknown credential with 401", () => {
    expect(() => resolveScope(policy, "nope")).toThrow(
      expect.objectContaining({ status: 401 }) as Error,
    );
  });

  it("tolerates malformed policy JSON", () => {
    expect(parsePolicy("{not json")).toEqual({});
    expect(parsePolicy(undefined)).toEqual({});
  });
});
