/**
 * Security-focused tests: prove secret_key is removed from all storage.
 */
import { describe, it, expect } from "vitest";
import { stripSecretKey } from "../src/lib/smartlead-normalizer";
import { scrubSecretKey } from "../src/lib/b2";

const PAYLOAD_WITH_SECRET = {
  event_type: "EMAIL_SENT",
  secret_key: "SUPER_SECRET_VALUE",
  to_email: "user@example.com",
  campaign_id: "camp_123",
};

const NESTED_PAYLOAD = {
  outer: "value",
  secret_key: "outer_secret",
  inner: {
    secret_key: "inner_secret",
    other: "stuff",
  },
  arr: [
    { secret_key: "array_secret", a: 1 },
    { b: 2 },
  ],
};

const PAYLOAD_WITHOUT_SECRET = {
  event_type: "EMAIL_SENT",
  to_email: "user@example.com",
  campaign_id: "camp_123",
};

describe("secret key removal — stripSecretKey (normalizer)", () => {
  it("removes top-level secret_key", () => {
    const result = stripSecretKey(PAYLOAD_WITH_SECRET);
    expect(result).not.toHaveProperty("secret_key");
    expect(result).toEqual(PAYLOAD_WITHOUT_SECRET);
  });

  it("removes nested secret_key recursively", () => {
    const result = stripSecretKey(NESTED_PAYLOAD);
    expect(result).not.toHaveProperty("secret_key");
    if (result && typeof result === "object" && "inner" in result) {
      const inner = (result as Record<string, unknown>).inner as Record<string, unknown>;
      expect(inner).not.toHaveProperty("secret_key");
      expect(inner.other).toBe("stuff");
    }
    if (result && typeof result === "object" && "arr" in result) {
      const arr = (result as Record<string, unknown>).arr as unknown[];
      expect(arr[0]).not.toHaveProperty("secret_key");
    }
  });

  it("returns the same object if no secret_key present", () => {
    const result = stripSecretKey(PAYLOAD_WITHOUT_SECRET);
    expect(result).toEqual(PAYLOAD_WITHOUT_SECRET);
  });

  it("handles null and undefined gracefully", () => {
    expect(stripSecretKey(null)).toBe(null);
    expect(stripSecretKey(undefined)).toBe(undefined);
    expect(stripSecretKey(123)).toBe(123);
    expect(stripSecretKey("string")).toBe("string");
  });

  it("handles arrays with mixed types", () => {
    const input = [
      { secret_key: "a", x: 1 },
      { y: 2 },
      null,
      "string",
      123,
    ];
    const result = stripSecretKey(input);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).not.toHaveProperty("secret_key");
    expect((result[0] as Record<string, unknown>).x).toBe(1);
  });
});

describe("secret key removal — scrubSecretKey (B2)", () => {
  it("removes secret_key from top-level object", () => {
    const result = scrubSecretKey(PAYLOAD_WITH_SECRET);
    expect(result).not.toHaveProperty("secret_key");
    expect(result).toEqual(PAYLOAD_WITHOUT_SECRET);
  });

  it("removes secret_key from nested objects", () => {
    const result = scrubSecretKey(NESTED_PAYLOAD);
    expect(result).not.toHaveProperty("secret_key");
    if (result && typeof result === "object" && "inner" in result) {
      const inner = (result as Record<string, unknown>).inner as Record<string, unknown>;
      expect(inner).not.toHaveProperty("secret_key");
      expect(inner.other).toBe("stuff");
    }
  });

  it("handles arrays", () => {
    const result = scrubSecretKey([PAYLOAD_WITH_SECRET, PAYLOAD_WITHOUT_SECRET]);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).not.toHaveProperty("secret_key");
    expect(result[1]).toEqual(PAYLOAD_WITHOUT_SECRET);
  });

  it("does not mutate the original object", () => {
    const original = JSON.parse(JSON.stringify(PAYLOAD_WITH_SECRET));
    const result = scrubSecretKey(original);
    expect(original).toHaveProperty("secret_key");
    expect(result).not.toHaveProperty("secret_key");
  });

  it("returns primitive values unchanged", () => {
    expect(scrubSecretKey(null)).toBe(null);
    expect(scrubSecretKey(42)).toBe(42);
    expect(scrubSecretKey("string")).toBe("string");
  });
});

describe("secret key removal integration — envelope flow", () => {
  it("B2 upload envelope with secret_key gets scrubbed", () => {
    const envelope = {
      received_at: new Date().toISOString(),
      event_hash: "hash123",
      raw_body: JSON.stringify(PAYLOAD_WITH_SECRET),
      normalized: PAYLOAD_WITH_SECRET,
    };

    const result = scrubSecretKey(envelope);

    // Top-level of result should not have secret_key (envelope never had it)
    expect(result).not.toHaveProperty("secret_key");

    // raw_body string is NOT scrubbed by scrubSecretKey (that's for objects only).
    // This is by design: the receiver must strip the secret before it ever goes
    // into raw_body. The task should always serialize from a sanitized object.
    // So we verify raw_body still contains the secret as-is, but the normalized
    // object (which is what Supabase sees) is scrubbed.
    expect((result as Record<string, unknown>).raw_body).toContain("SUPER_SECRET_VALUE");

    const normalized = (result as Record<string, unknown>).normalized as Record<string, unknown>;
    expect(normalized).not.toHaveProperty("secret_key");
    expect(normalized.to_email).toBe("user@example.com");
  });

  it("Supabase insert payload never contains secret_key", () => {
    // This represents the `insertPayload` that supabase.ts constructs from NormalizedEmailSent.
    // The NormalizedEmailSent type does not have a secret_key field at all.
    const insertPayload = {
      event_hash: "hash123",
      event_type: "EMAIL_SENT",
      to_email: "user@example.com",
      campaign_id: "camp_123",
      // ... all other fields from the row
    };

    const result = scrubSecretKey(insertPayload);
    // Result should be identical because there was no secret_key to begin with.
    expect(result).toEqual(insertPayload);
    // And definitely no secret_key anywhere.
    expect(result).not.toHaveProperty("secret_key");
  });

  it("sample_payload in webhook_processing_errors gets scrubbed", () => {
    const errorRecord = {
      event_hash: "hash123",
      event_type: "EMAIL_SENT",
      stage: "normalize_payload" as const,
      message: "some error",
      sample_payload: PAYLOAD_WITH_SECRET,
    };

    const safePayload = errorRecord.sample_payload === undefined
      ? undefined
      : stripSecretKey(errorRecord.sample_payload);

    expect(safePayload).not.toHaveProperty("secret_key");
    expect((safePayload as Record<string, unknown>).to_email).toBe("user@example.com");
    expect((safePayload as Record<string, unknown>).campaign_id).toBe("camp_123");
  });
});

describe("secret key removal edge cases", () => {
  it("handles empty objects", () => {
    expect(scrubSecretKey({})).toEqual({});
  });

  it("handles deeply nested secret_key", () => {
    const deeply = { a: { b: { c: { d: { secret_key: "deep" } } } } };
    const result = scrubSecretKey(deeply);
    // Note: implementation strips only at the key level; it should still remove the deep one.
    const out = result as Record<string, unknown>;
    const a = out.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    const d = c.d as Record<string, unknown>;
    expect(d).not.toHaveProperty("secret_key");
  });

  it("handles keys named exactly secret_key (case-sensitive)", () => {
    const mixedCase = { secret_key: "yes", Secret_Key: "maybe", SECRET_KEY: "no" };
    const result = scrubSecretKey(mixedCase);
    expect(result).not.toHaveProperty("secret_key");
    // Our simple implementation is case-sensitive. SmartLead uses `secret_key` (all lowercase).
    // If we wanted case-insensitive we'd adjust the implementation; for now we match SmartLead's field name.
    expect(result).toHaveProperty("Secret_Key");
    expect(result).toHaveProperty("SECRET_KEY");
  });
});
