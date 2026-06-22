import { task, logger } from "@trigger.dev/sdk/v3";
import {
  normalizeSmartleadEmailSent,
  stripSecretKey,
  PROCESSING_VERSION,
  type SmartleadRawPayload,
  type NormalizedEmailSent,
} from "../lib/smartlead-normalizer";
import { uploadToB2, type B2Config } from "../lib/b2";
import {
  getSupabaseClient,
  insertEmailSentEvent,
  bumpDailyCounts,
  recordProcessingError,
  errorMeta,
  type SupabaseConfig,
} from "../lib/supabase";
import { ProcessingError, ERROR_STAGES } from "../lib/errors";

/**
 * Payload shape passed in by the HTTP receiver.
 *
 * SECURITY CONTRACT:
 * The receiver is the only layer that ever sees the original `secret_key`. By the
 * time a value reaches this input, the receiver has already verified it and stripped
 * it from `raw`. The task then:
 *   - re-strips `secret_key` defensively (in case `raw` somehow still has it)
 *   - serializes the raw body from the sanitized object (never from a possibly-tampered string)
 *   - scrubs `secret_key` from any value that crosses a storage boundary
 *
 * `receivedAt` is the ISO timestamp the receiver recorded.
 */
export interface SmartleadEmailSentInput {
  raw: Record<string, unknown>;
  receivedAt: string; // ISO
}

export type SmartleadEmailSentOutput =
  | {
      status: "inserted";
      event_hash: string;
      b2_bucket: string;
      b2_key: string;
      supabase_id: number;
    }
  | {
      status: "duplicate";
      event_hash: string;
      b2_bucket: string;
      b2_key: string;
    }
  | {
      status: "rejected";
      reason: string;
    };

function readEnv(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

function loadB2Config(): B2Config {
  const endpoint = readEnv("B2_ENDPOINT");
  const region = readEnv("B2_REGION");
  const bucket = readEnv("B2_BUCKET_NAME");
  const keyId = readEnv("B2_KEY_ID");
  const applicationKey = readEnv("B2_APPLICATION_KEY");
  if (!endpoint || !region || !bucket || !keyId || !applicationKey) {
    throw new ProcessingError("validate_payload", "missing one of B2_* env vars");
  }
  return { endpoint, region, bucket, keyId, applicationKey };
}

function loadSupabaseConfig(): SupabaseConfig {
  const url = readEnv("SUPABASE_URL");
  const secretKey = readEnv("SUPABASE_SECRET_KEY");
  if (!url || !secretKey) {
    throw new ProcessingError("insert_supabase", "missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  }
  return { url, secretKey };
}

export const smartleadEmailSent = task({
  id: "smartlead-email-sent",
  // 60s is plenty — B2 + Supabase round trips should each be sub-second.
  maxDuration: 60,
  // Retries are safe because every step is idempotent: B2 overwrites by key,
  // Supabase insert is unique-keyed, and count bump is a single SQL upsert.
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (payload: SmartleadEmailSentInput) => {
    const { raw, receivedAt } = payload;
    const receivedAtDate = new Date(receivedAt);

    // ─── 1. Defensively strip secret_key from the payload.
    // The receiver already verified + stripped, but we re-strip here as defense in
    // depth. The normalized value flows downstream with zero secret_key anywhere.
    const sanitizedRaw = stripSecretKey(raw) as SmartleadRawPayload;

    // ─── 2. Normalize.
    let normalized: NormalizedEmailSent;
    try {
      normalized = normalizeSmartleadEmailSent(sanitizedRaw, {
        receivedAt: receivedAtDate,
        processingVersion: PROCESSING_VERSION,
      });
    } catch (err) {
      const meta = errorMeta(err);
      logger.error("normalize_payload failed", {
        stage: "normalize_payload",
        error: meta.message,
      });
      // Try to record the error in Supabase. We never include the payload itself
      // (could leak the secret) — only event_type + error message + stack.
      try {
        const sb = getSupabaseClient(loadSupabaseConfig());
        await recordProcessingError(sb, {
          eventHash: undefined,
          eventType: "EMAIL_SENT",
          stage: "normalize_payload",
          message: meta.message,
          stack: meta.stack,
          samplePayload: undefined, // explicitly NOT passing the raw payload
        });
      } catch {
        // ignore secondary failure
      }
      throw new ProcessingError("normalize_payload", meta.message, { cause: err });
    }

    const logSafe = {
      event_hash: normalized.event_hash,
      campaign_id: normalized.campaign_id,
      to_email: normalized.to_email,
      stage: undefined as string | undefined,
    };

    // ─── 3. Upload raw to B2.
    // Serialize the raw body from the *sanitized* object so the B2 archive is
    // byte-faithful to what SmartLead sent EXCEPT for the secret_key (which the
    // receiver already validated and which must never be persisted). The b2.ts
    // upload function also re-scrubs secret_key defensively.
    const sanitizedBody = JSON.stringify(sanitizedRaw);
    let b2Result;
    try {
      b2Result = await uploadToB2(loadB2Config(), {
        eventHash: normalized.event_hash,
        receivedAt: receivedAtDate,
        rawBody: sanitizedBody,
        normalized: { ...normalized },
        processingVersion: PROCESSING_VERSION,
      });
    } catch (err) {
      const meta = errorMeta(err);
      logger.error("upload_b2 failed", { ...logSafe, stage: "upload_b2", error: meta.message });
      // If B2 fails, do NOT proceed to Supabase. The raw archive is the source of
      // truth and we'd rather retry than have an event that's "in Supabase but not B2".
      try {
        const sb = getSupabaseClient(loadSupabaseConfig());
        await recordProcessingError(sb, {
          eventHash: normalized.event_hash,
          eventType: normalized.event_type,
          stage: "upload_b2",
          message: meta.message,
          stack: meta.stack,
          samplePayload: undefined,
        });
      } catch {
        // ignore
      }
      throw new ProcessingError("upload_b2", meta.message, {
        cause: err,
        eventHash: normalized.event_hash,
      });
    }

    logSafe.stage = "insert_supabase";

    // ─── 4. Insert normalized row into Supabase.
    const supabaseClient = getSupabaseClient(loadSupabaseConfig());
    let insertResult;
    try {
      insertResult = await insertEmailSentEvent(
        supabaseClient,
        normalized,
        b2Result.bucket,
        b2Result.key
      );
    } catch (err) {
      const meta = errorMeta(err);
      logger.error("insert_supabase failed", { ...logSafe, error: meta.message });
      try {
        await recordProcessingError(supabaseClient, {
          eventHash: normalized.event_hash,
          eventType: normalized.event_type,
          stage: "insert_supabase",
          message: meta.message,
          stack: meta.stack,
          samplePayload: undefined,
        });
      } catch {
        // ignore
      }
      throw new ProcessingError("insert_supabase", meta.message, {
        cause: err,
        eventHash: normalized.event_hash,
      });
    }

    if (insertResult.status === "duplicate") {
      logger.info("duplicate event_hash — skipping counts", logSafe);
      return {
        status: "duplicate",
        event_hash: normalized.event_hash,
        b2_bucket: b2Result.bucket,
        b2_key: b2Result.key,
      };
    }

    // ─── 5. Bump daily counts. Failure here is non-fatal.
    logSafe.stage = "update_counts";
    try {
      const eventDate = (normalized.event_timestamp ?? normalized.received_at).slice(0, 10);
      await bumpDailyCounts(supabaseClient, {
        eventDate,
        eventType: normalized.event_type,
        campaignId: normalized.campaign_id,
        campaignName: normalized.campaign_name,
        clientId: normalized.client_id,
      });
    } catch (err) {
      const meta = errorMeta(err);
      logger.warn("update_counts failed (non-fatal)", { ...logSafe, error: meta.message });
      try {
        await recordProcessingError(supabaseClient, {
          eventHash: normalized.event_hash,
          eventType: normalized.event_type,
          stage: "update_counts",
          message: meta.message,
          stack: meta.stack,
          samplePayload: undefined,
        });
      } catch {
        // ignore
      }
    }

    logger.info("smartlead-email-sent inserted", {
      event_hash: normalized.event_hash,
      campaign_id: normalized.campaign_id,
      to_email: normalized.to_email,
      supabase_id: insertResult.rowId,
      b2_key: b2Result.key,
    });

    return {
      status: "inserted",
      event_hash: normalized.event_hash,
      b2_bucket: b2Result.bucket,
      b2_key: b2Result.key,
      supabase_id: insertResult.rowId ?? -1,
    };
  },
});

// Re-export the error stages so other modules (tests, scripts) can iterate the same constants.
export { ERROR_STAGES };
