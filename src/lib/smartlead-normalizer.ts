import { z } from "zod";
import { canonicalize, sha256Hex } from "./hash";
import { buildBodyPreview, extractDomain } from "./html";

/**
 * SmartLead EMAIL_SENT payload schema.
 *
 * We model the well-known fields explicitly and intentionally allow unknown extras
 * because SmartLead can add fields at any time. The "raw" capture (full object)
 * is what we send to B2; this schema only governs the fields we extract into
 * Supabase and use to compute event_hash.
 */
export const smartleadEmailSentSchema = z
  .object({
    event_type: z.string().nullable().optional(),
    // SmartLead may include the type in either `event_type` or `event` (some integrations use both).
    event: z.string().nullable().optional(),
    time_sent: z.union([z.string(), z.number()]).nullable().optional(),
    event_timestamp: z.union([z.string(), z.number()]).nullable().optional(),

    secret_key: z.string().nullable().optional(),

    // Identifier fields — any of these may be present.
    webhook_id: z.string().nullable().optional(),
    webhook_name: z.string().nullable().optional(),
    stats_id: z.string().nullable().optional(),
    sl_email_lead_id: z.string().nullable().optional(),
    sl_email_lead_map_id: z.string().nullable().optional(),

    // Client + campaign.
    client_id: z.union([z.string(), z.number()]).nullable().optional(),
    campaign_id: z.union([z.string(), z.number()]).nullable().optional(),
    campaign_name: z.string().nullable().optional(),
    campaign_status: z.string().nullable().optional(),
    sequence_number: z.union([z.number(), z.string()]).nullable().optional(),

    // Sender / recipient.
    from_email: z.string().nullable().optional(),
    to_email: z.string().nullable().optional(),
    to_name: z.string().nullable().optional(),

    // Content.
    subject: z.string().nullable().optional(),
    custom_subject: z.string().nullable().optional(),

    sent_message: z
      .object({
        message_id: z.string().optional(),
        html: z.string().optional(),
        text: z.string().optional(),
      })
      .partial()
      .nullable()
      .optional(),

    // Deprecated content fields — only used as fallback.
    sent_message_body: z.string().nullable().optional(),
    custom_email_message: z.string().nullable().optional(),

    // Misc.
    message_id: z.string().optional(), // deprecated, prefer sent_message.message_id
    app_url: z.string().nullable().optional(),
    ui_master_inbox_link: z.string().nullable().optional(),
  })
  .passthrough();

export type SmartleadRawPayload = z.infer<typeof smartleadEmailSentSchema> & Record<string, unknown>;

/** A normalized, flat row that mirrors email_sent_events. */
export interface NormalizedEmailSent {
  event_type: "EMAIL_SENT";
  event_hash: string;
  raw_payload_sha256: string;
  event_timestamp: string | null; // ISO
  received_at: string; // ISO
  client_id: string | null;
  webhook_id: string | null;
  webhook_name: string | null;
  stats_id: string | null;
  sl_email_lead_id: string | null;
  sl_email_lead_map_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_status: string | null;
  sequence_number: number | null;
  from_email: string | null;
  from_domain: string | null;
  to_email: string | null;
  to_domain: string | null;
  to_name: string | null;
  subject: string | null;
  sent_message_id: string | null;
  body_preview: string;
  app_url: string | null;
}

export interface NormalizerOptions {
  receivedAt?: Date;
  processingVersion?: string;
}

export const PROCESSING_VERSION = "1.0.0";

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickTimestampIso(raw: SmartleadRawPayload): string | null {
  // Newer field wins.
  const candidates: unknown[] = [raw.event_timestamp, raw.time_sent];
  for (const c of candidates) {
    if (c === null || c === undefined || c === "") continue;
    if (typeof c === "number") {
      // Accept seconds or milliseconds.
      const ms = c < 1e12 ? c * 1000 : c;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString();
    } else if (typeof c === "string") {
      const trimmed = c.trim();
      if (!trimmed) continue;
      // Try numeric string first (e.g. "1700000000").
      if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        const ms = n < 1e12 ? n * 1000 : n;
        const d = new Date(ms);
        if (!isNaN(d.getTime())) return d.toISOString();
      } else {
        const d = new Date(trimmed);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }
  }
  return null;
}

function pickSubject(raw: SmartleadRawPayload): string | null {
  // New field first; deprecated fallback.
  return asString(raw.subject) ?? asString(raw.custom_subject);
}

function pickHtmlAndText(raw: SmartleadRawPayload): { html: string | null; text: string | null } {
  const html =
    asString(raw.sent_message?.html) ??
    asString(raw.sent_message_body) ??
    asString(raw.custom_email_message);
  const text = asString(raw.sent_message?.text);
  return { html, text };
}

function pickSentMessageId(raw: SmartleadRawPayload): string | null {
  return (
    asString(raw.sent_message?.message_id) ??
    asString(raw.message_id) // deprecated fallback
  );
}

function pickAppUrl(raw: SmartleadRawPayload): string | null {
  return asString(raw.app_url) ?? asString(raw.ui_master_inbox_link);
}

function pickEventType(raw: SmartleadRawPayload): string {
  return asString(raw.event_type) ?? asString(raw.event) ?? "EMAIL_SENT";
}

/**
 * Single canonical place that strips `secret_key` from any payload value.
 * Use this everywhere a value might cross the storage boundary (B2, Supabase,
 * webhook_processing_errors, logs). The receiver is the ONLY place that ever
 * compares the original secret; nothing downstream is allowed to see it.
 */
export function stripSecretKey<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripSecretKey(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "secret_key") continue;
    out[k] = stripSecretKey(v);
  }
  return out as T;
}

/**
 * Compute a stable event_hash. Order of preference:
 *   1. sent_message.message_id (with campaign_id + to_email) — strongest identifier SmartLead provides
 *   2. stats_id
 *   3. SHA256 of canonical JSON of the entire payload
 */
export function computeEventHash(raw: SmartleadRawPayload): string {
  const messageId = pickSentMessageId(raw);
  const campaignId = asString(raw.campaign_id);
  const toEmail = asString(raw.to_email);

  if (messageId) {
    // message_id is globally unique per SmartLead, but include campaign + recipient defensively.
    return sha256Hex(`msg|${messageId}|${campaignId ?? ""}|${toEmail ?? ""}`);
  }
  const statsId = asString(raw.stats_id);
  if (statsId) {
    return sha256Hex(`stats|${statsId}`);
  }
  return sha256Hex(`payload|${canonicalize(raw)}`);
}

/**
 * Pure normalizer. No I/O. Throws ProcessingError(validate_payload) on bad input.
 */
export function normalizeSmartleadEmailSent(
  rawInput: unknown,
  options: NormalizerOptions = {}
): NormalizedEmailSent {
  const parsed = smartleadEmailSentSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new Error("validate_payload: input did not match expected shape: " + parsed.error.message);
  }
  const raw = parsed.data as SmartleadRawPayload;

  const receivedAt = options.receivedAt ?? new Date();
  const processingVersion = options.processingVersion ?? PROCESSING_VERSION;

  const eventHash = computeEventHash(raw);

  // Use the canonical form for the raw sha so identical-but-reordered payloads hash the same.
  const rawPayloadSha = sha256Hex(canonicalize(raw));

  const eventType = pickEventType(raw);
  if (eventType !== "EMAIL_SENT") {
    // We only handle EMAIL_SENT in v1.
    throw new Error("validate_payload: event_type is not EMAIL_SENT: " + eventType);
  }

  const { html, text } = pickHtmlAndText(raw);
  const bodyPreview = buildBodyPreview({ text, html }, 500);

  const fromEmail = asString(raw.from_email);
  const toEmail = asString(raw.to_email);

  return {
    event_type: "EMAIL_SENT",
    event_hash: eventHash,
    raw_payload_sha256: rawPayloadSha,
    event_timestamp: pickTimestampIso(raw),
    received_at: receivedAt.toISOString(),
    client_id: asString(raw.client_id),
    webhook_id: asString(raw.webhook_id),
    webhook_name: asString(raw.webhook_name),
    stats_id: asString(raw.stats_id),
    sl_email_lead_id: asString(raw.sl_email_lead_id),
    sl_email_lead_map_id: asString(raw.sl_email_lead_map_id),
    campaign_id: asString(raw.campaign_id),
    campaign_name: asString(raw.campaign_name),
    campaign_status: asString(raw.campaign_status),
    sequence_number: asNumber(raw.sequence_number),
    from_email: fromEmail,
    from_domain: extractDomain(fromEmail),
    to_email: toEmail,
    to_domain: extractDomain(toEmail),
    to_name: asString(raw.to_name),
    subject: pickSubject(raw),
    sent_message_id: pickSentMessageId(raw),
    body_preview: bodyPreview,
    app_url: pickAppUrl(raw),
  };
}

/**
 * Constant-time comparison for the secret key. Avoids timing-attack signature leakage.
 */
export function secretsMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the SmartLead secret. We accept a payload that is missing the secret
 * as "invalid" — SmartLead always includes it for v1 EMAIL_SENT.
 */
export function verifySmartleadSecret(
  payload: unknown,
  expectedSecret: string | undefined
): { ok: true } | { ok: false; reason: string } {
  if (!expectedSecret) {
    return { ok: false, reason: "server secret not configured" };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "payload is not an object" };
  }
  const got = (payload as { secret_key?: unknown }).secret_key;
  if (typeof got !== "string" || got.length === 0) {
    return { ok: false, reason: "payload.secret_key missing" };
  }
  if (!secretsMatch(got, expectedSecret)) {
    return { ok: false, reason: "secret_key mismatch" };
  }
  return { ok: true };
}
