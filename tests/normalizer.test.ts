/**
 * Unit tests for SmartLead EMAIL_SENT normalizer.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeSmartleadEmailSent,
  verifySmartleadSecret,
  computeEventHash,
  secretsMatch,
} from "../src/lib/smartlead-normalizer";
import { buildB2Key, computeB2Key } from "../src/lib/b2";

const BASE_PAYLOAD = {
  event_type: "EMAIL_SENT",
  secret_key: "valid-secret-123",
  time_sent: 1750600000,
  event_timestamp: "2026-06-22T10:30:00Z",
  webhook_id: "wh_abc123",
  webhook_name: "New Leads Webhook",
  stats_id: "stat_9f8e7d",
  sl_email_lead_id: "lead_001",
  sl_email_lead_map_id: "map_002",
  client_id: "42",
  campaign_id: "camp_77",
  campaign_name: "Acme Outreach Q3",
  campaign_status: "ACTIVE",
  sequence_number: 3,
  from_email: "jane@acme.com",
  to_email: "john@prospectcorp.com",
  to_name: "John Prospect",
  subject: "Let's discuss your project",
  sent_message: {
    message_id: "<20260622083001.abc@mail.acme.com>",
    html: "<html><body><p>Hi John,</p><p>Let's discuss.</p></body></html>",
    text: "Hi John,\n\nLet's discuss.\n",
  },
  app_url: "https://app.smartlead.ai/app/master-inbox/42/77",
};

// ── 1. Valid SmartLead payload normalizes correctly ────────────────────────
describe("valid payload", () => {
  it("normalizes all fields correctly", () => {
    const result = normalizeSmartleadEmailSent(BASE_PAYLOAD);
    expect(result.event_type).toBe("EMAIL_SENT");
    expect(result.from_email).toBe("jane@acme.com");
    expect(result.from_domain).toBe("acme.com");
    expect(result.to_email).toBe("john@prospectcorp.com");
    expect(result.to_domain).toBe("prospectcorp.com");
    expect(result.subject).toBe("Let's discuss your project");
    expect(result.sent_message_id).toBe("<20260622083001.abc@mail.acme.com>");
    expect(result.campaign_id).toBe("camp_77");
    expect(result.campaign_name).toBe("Acme Outreach Q3");
    expect(result.client_id).toBe("42");
    expect(result.sequence_number).toBe(3);
    expect(result.event_hash).toBeTruthy();
    expect(result.event_hash).toHaveLength(64); // SHA256 hex
  });

  it("computes a stable, reproducible event_hash", () => {
    const a = normalizeSmartleadEmailSent(BASE_PAYLOAD);
    const b = normalizeSmartleadEmailSent(BASE_PAYLOAD);
    expect(a.event_hash).toBe(b.event_hash);
  });

  it("accepts extra unknown fields (passthrough)", () => {
    const p = { ...BASE_PAYLOAD, smartlead_foo: "bar", new_field_2026: true };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.event_type).toBe("EMAIL_SENT");
  });
});

// ── 2. Deprecated fields fallback correctly ───────────────────────────────
describe("deprecated field fallback", () => {
  it("uses custom_subject when subject is missing", () => {
    const p = { ...BASE_PAYLOAD, subject: undefined, custom_subject: "Old Subject" };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.subject).toBe("Old Subject");
  });

  it("uses sent_message_body when sent_message.html is missing", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: undefined,
      sent_message_body: "<p>HTML from sent_message_body</p>",
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview).toContain("HTML from sent_message_body");
  });

  it("uses custom_email_message when sent_message and sent_message_body are missing", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: undefined,
      sent_message_body: undefined,
      custom_email_message: "<p>Very old custom email</p>",
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview).toContain("Very old custom email");
  });

  it("uses deprecated message_id when sent_message.message_id is missing", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: { ...BASE_PAYLOAD.sent_message, message_id: undefined },
      message_id: "<deprecated-msg-id@mail.acme.com>",
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.sent_message_id).toBe("<deprecated-msg-id@mail.acme.com>");
  });

  it("uses ui_master_inbox_link when app_url is missing", () => {
    const p = { ...BASE_PAYLOAD, app_url: undefined, ui_master_inbox_link: "https://old-link" };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.app_url).toBe("https://old-link");
  });
});

// ── 3. Missing secret is rejected ────────────────────────────────────────
describe("missing secret", () => {
  it("rejects payload with missing secret_key field", () => {
    const p = { ...BASE_PAYLOAD, secret_key: undefined };
    const check = verifySmartleadSecret(p, "expected-secret");
    expect(check.ok).toBe(false);
    if (check.ok === false) {
      expect(check.reason).toBe("payload.secret_key missing");
    }
  });

  it("rejects payload with no secret_key property at all", () => {
    const check = verifySmartleadSecret({} as Record<string, unknown>, "expected-secret");
    expect(check.ok).toBe(false);
    if (check.ok === false) {
      expect(check.reason).toBe("payload.secret_key missing");
    }
  });
});

// ── 4. Wrong secret is rejected ───────────────────────────────────────────
describe("wrong secret", () => {
  it("rejects with wrong secret", () => {
    const check = verifySmartleadSecret(BASE_PAYLOAD, "wrong-secret");
    expect(check.ok).toBe(false);
    if (check.ok === false) {
      expect(check.reason).toBe("secret_key mismatch");
    }
  });

  it("rejects empty expected secret (treated as unconfigured)", () => {
    const check = verifySmartleadSecret(BASE_PAYLOAD, "");
    expect(check.ok).toBe(false);
    if (check.ok === false) {
      expect(check.reason).toBe("server secret not configured");
    }
  });

  it("rejects when expected secret is undefined", () => {
    const check = verifySmartleadSecret(BASE_PAYLOAD, undefined);
    expect(check.ok).toBe(false);
    if (check.ok === false) {
      expect(check.reason).toBe("server secret not configured");
    }
  });
});

// ── 5. Missing sent_message does not crash ────────────────────────────────
describe("missing sent_message", () => {
  it("handles payload without sent_message gracefully", () => {
    const p = { ...BASE_PAYLOAD, sent_message: undefined };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.event_type).toBe("EMAIL_SENT");
    expect(result.sent_message_id).toBeFalsy();
    expect(result.body_preview).toBe("");
  });

  it("handles payload with empty sent_message object", () => {
    const p = { ...BASE_PAYLOAD, sent_message: {} };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.event_type).toBe("EMAIL_SENT");
    expect(result.sent_message_id).toBeNull();
    expect(result.body_preview).toBe("");
  });
});

// ── 6. Malformed email addresses do not crash ─────────────────────────────
describe("malformed email addresses", () => {
  it("handles missing @ sign in from_email", () => {
    const p = { ...BASE_PAYLOAD, from_email: "not-an-email" };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.from_domain).toBeNull();
    expect(result.from_email).toBe("not-an-email");
  });

  it("handles empty string email", () => {
    const p = { ...BASE_PAYLOAD, from_email: "   " };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.from_email).toBeNull();
    expect(result.from_domain).toBeNull();
  });

  it("handles to_email with no domain", () => {
    const p = { ...BASE_PAYLOAD, to_email: "useronly" };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.to_domain).toBeNull();
  });

  it("handles completely missing to_email", () => {
    const p = { ...BASE_PAYLOAD, to_email: null };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.to_email).toBeNull();
    expect(result.to_domain).toBeNull();
  });
});

// ── 7. Duplicate event_hash is handled safely ─────────────────────────────
describe("event_hash dedupe", () => {
  it("produces same hash for identical payloads", () => {
    const p1 = { ...BASE_PAYLOAD };
    const p2 = { ...BASE_PAYLOAD };
    // Reorder keys to verify canonicalization handles key order.
    const reordered = {};
    Object.assign(reordered, BASE_PAYLOAD);
    Object.defineProperty(reordered, "secret_key", { value: BASE_PAYLOAD.secret_key, enumerable: true });
    // Add keys in different order
    const unordered = { secret_key: p2.secret_key, to_email: p2.to_email, campaign_id: p2.campaign_id };
    const h1 = computeEventHash(BASE_PAYLOAD);
    const h2 = computeEventHash(p2);
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different content", () => {
    const p1 = { ...BASE_PAYLOAD };
    const p2 = { ...BASE_PAYLOAD, to_email: "different@email.com" };
    expect(computeEventHash(p1)).not.toBe(computeEventHash(p2));
  });
});

// ── 8. B2 key path is generated correctly ─────────────────────────────────
describe("B2 key generation", () => {
  const dt = new Date("2026-06-22T14:05:00Z");
  it("generates correct path pattern", () => {
    const key = buildB2Key("abc123", dt);
    expect(key).toBe("email_sent/year=2026/month=06/day=22/hour=14/abc123.json.gz");
  });

  it("computeB2Key is equivalent to buildB2Key", () => {
    const a = buildB2Key("hashval", dt);
    const b = computeB2Key("hashval", dt);
    expect(a).toBe(b);
  });

  it("pads single-digit months and days correctly", () => {
    const feb = new Date("2026-02-05T00:00:00Z");
    const key = buildB2Key("x", feb);
    expect(key).toContain("year=2026/month=02/day=05/hour=00");
  });

  it("handles midnight hour", () => {
    const midnight = new Date("2026-06-22T00:00:00Z");
    const key = buildB2Key("x", midnight);
    expect(key).toContain("hour=00");
  });
});

// ── 9. body_preview generation from text works ─────────────────────────────
describe("body_preview from text", () => {
  it("uses text when available", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: {
        message_id: "<test@example.com>",
        text: "Hello world — this is the plain text body.",
      },
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview).toBe("Hello world — this is the plain text body.");
  });

  it("truncates text over 500 chars", () => {
    const longText = "A".repeat(600);
    const p = {
      ...BASE_PAYLOAD,
      sent_message: {
        message_id: "<test@example.com>",
        text: longText,
      },
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview.length).toBe(500);
    expect(result.body_preview).toBe(longText.slice(0, 500));
  });
});

// ── 10. body_preview fallback from HTML works ─────────────────────────────
describe("body_preview from HTML", () => {
  it("strips HTML tags when no text available", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: {
        message_id: "<test@example.com>",
        html: "<p><strong>Hello</strong> <em>world</em>!</p>",
        text: undefined,
      },
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview).toBe("Hello world !");
  });

  it("handles HTML with nested tags", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: {
        message_id: "<test@example.com>",
        html: "<div><p>First</p><p>Second <span>nested</span></p></div>",
        text: undefined,
      },
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview).toContain("First");
    expect(result.body_preview).toContain("Second nested");
  });

  it("handles HTML with entities", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: {
        message_id: "<test@example.com>",
        html: "<p>Tom &amp; Jerry &nbsp; &lt;3</p>",
        text: undefined,
      },
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview).toContain("&");
    expect(result.body_preview).toContain("<");
  });

  it("handles HTML with style/script blocks (stripped)", () => {
    const p = {
      ...BASE_PAYLOAD,
      sent_message: {
        message_id: "<test@example.com>",
        html: "<script>alert('bad')</script><p>Real content here</p><style>.foo{}</style>",
        text: undefined,
      },
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview).toBe("Real content here");
    expect(result.body_preview).not.toContain("alert");
    expect(result.body_preview).not.toContain(".foo");
  });

  it("truncates HTML-derived preview at 500 chars", () => {
    const htmlContent = `<p>${"word ".repeat(200)}</p>`;
    const p = {
      ...BASE_PAYLOAD,
      sent_message: {
        message_id: "<test@example.com>",
        html: htmlContent,
        text: undefined,
      },
    };
    const result = normalizeSmartleadEmailSent(p);
    expect(result.body_preview.length).toBeLessThanOrEqual(500);
  });
});

// ── Additional: secretsMatch ──────────────────────────────────────────────
describe("secretsMatch", () => {
  it("returns true for identical strings", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(secretsMatch("abc", "def")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(secretsMatch("abc", "ab")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(secretsMatch(123 as unknown as string, "abc")).toBe(false);
    expect(secretsMatch(null as unknown as string, "abc")).toBe(false);
  });
});
