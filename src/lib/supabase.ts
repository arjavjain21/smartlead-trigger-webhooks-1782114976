import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedEmailSent } from "./smartlead-normalizer";
import { stripSecretKey } from "./smartlead-normalizer";
import { toErrorMessage, toErrorStack } from "./errors";

let _client: SupabaseClient | null = null;

export interface SupabaseConfig {
  url: string;
  secretKey: string;
}

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getSupabaseClient(config: SupabaseConfig): SupabaseClient {
  if (!_client) {
    _client = createSupabaseClient(config);
  }
  return _client;
}

/**
 * Insert a normalized EMAIL_SENT row. The unique constraint on event_hash
 * makes this idempotent: a duplicate webhook is a no-op.
 *
 * Returns:
 *   - status: "inserted" | "duplicate"
 *   - rowId: Supabase row id when inserted
 */
export interface InsertEventResult {
  status: "inserted" | "duplicate";
  rowId?: number;
}

export async function insertEmailSentEvent(
  client: SupabaseClient,
  row: NormalizedEmailSent,
  b2Bucket: string,
  b2Key: string
): Promise<InsertEventResult> {
  const insertPayload = {
    event_hash: row.event_hash,
    event_type: row.event_type,
    event_timestamp: row.event_timestamp,
    received_at: row.received_at,
    client_id: row.client_id,
    webhook_id: row.webhook_id,
    webhook_name: row.webhook_name,
    stats_id: row.stats_id,
    sl_email_lead_id: row.sl_email_lead_id,
    sl_email_lead_map_id: row.sl_email_lead_map_id,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    campaign_status: row.campaign_status,
    sequence_number: row.sequence_number,
    from_email: row.from_email,
    from_domain: row.from_domain,
    to_email: row.to_email,
    to_domain: row.to_domain,
    to_name: row.to_name,
    subject: row.subject,
    sent_message_id: row.sent_message_id,
    body_preview: row.body_preview,
    app_url: row.app_url,
    b2_bucket: b2Bucket,
    b2_key: b2Key,
    raw_payload_sha256: row.raw_payload_sha256,
  };

  const { data, error } = await client
    .from("email_sent_events")
    .insert(insertPayload)
    .select("id")
    .single();

  if (!error) {
    return { status: "inserted", rowId: data?.id };
  }

  // Supabase error code 23505 = unique_violation. We treat any duplicate-key error as duplicate.
  const code = (error as { code?: string }).code;
  if (code === "23505") {
    return { status: "duplicate" };
  }
  throw error;
}

/**
 * Increment the daily counts. Implemented as a Postgres upsert RPC so we don't have
 * to do read-modify-write from the application (which would be racy).
 */
export async function bumpDailyCounts(
  client: SupabaseClient,
  args: {
    eventDate: string; // YYYY-MM-DD
    eventType: string;
    campaignId: string | null;
    campaignName: string | null;
    clientId: string | null;
  }
): Promise<void> {
  const { error: dailyErr } = await client.rpc("bump_daily_counts", {
    p_event_date: args.eventDate,
    p_event_type: args.eventType,
    p_increment: 1,
  });
  if (dailyErr) throw dailyErr;

  if (args.campaignId) {
    const { error: campErr } = await client.rpc("bump_campaign_daily_counts", {
      p_event_date: args.eventDate,
      p_event_type: args.eventType,
      p_campaign_id: args.campaignId,
      p_campaign_name: args.campaignName,
      p_client_id: args.clientId,
      p_increment: 1,
    });
    if (campErr) throw campErr;
  }
}

export async function recordProcessingError(
  client: SupabaseClient,
  args: {
    eventHash?: string | null;
    eventType?: string | null;
    stage: string;
    message: string;
    stack?: string | null;
    samplePayload?: unknown;
  }
): Promise<void> {
  // Defense in depth: never store a payload that might contain secret_key.
  const safePayload = args.samplePayload === undefined ? undefined : stripSecretKey(args.samplePayload);

  const { error } = await client.from("webhook_processing_errors").insert({
    event_hash: args.eventHash ?? null,
    event_type: args.eventType ?? null,
    error_stage: args.stage,
    error_message: args.message,
    error_stack: args.stack ?? null,
    sample_payload: safePayload ?? null,
  });
  if (error) {
    // Don't throw — recording the error is best-effort so we never mask the original failure.
    // We do still log it so a misconfigured Supabase table is visible.
    // eslint-disable-next-line no-console
    console.error("Failed to record processing error to Supabase", { message: error.message });
  }
}

/** Convenience wrapper to keep error message + stack formatting consistent. */
export function errorMeta(err: unknown) {
  return { message: toErrorMessage(err), stack: toErrorStack(err) };
}
