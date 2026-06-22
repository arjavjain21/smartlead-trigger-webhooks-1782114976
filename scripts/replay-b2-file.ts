/**
 * scripts/replay-b2-file.ts
 *
 * Download a gzipped raw archive from B2 and re-run the workflow against it.
 * Useful for replaying an event from a different environment or re-processing after
 * a Supabase schema change.
 *
 * Usage:
 *   npx tsx scripts/replay-b2-file.ts email_sent/year=2026/month=06/day=22/hour=10/<hash>.json.gz
 *
 * Requires: B2_*, SUPABASE_*, SMARTLEAD_SECRET_KEY env vars (matching what was used originally).
 */

import "dotenv/config";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import {
  normalizeSmartleadEmailSent,
  PROCESSING_VERSION,
  type SmartleadRawPayload,
} from "../src/lib/smartlead-normalizer";
import {
  getSupabaseClient,
  insertEmailSentEvent,
  bumpDailyCounts,
} from "../src/lib/supabase";

function readEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function readEnvOpt(key: string): string | undefined {
  return process.env[key];
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("Usage: npx tsx scripts/replay-b2-file.ts <b2-key>");
    process.exit(2);
  }

  const client = new S3Client({
    endpoint: readEnv("B2_ENDPOINT"),
    region: readEnv("B2_REGION"),
    credentials: {
      accessKeyId: readEnv("B2_KEY_ID"),
      secretAccessKey: readEnv("B2_APPLICATION_KEY"),
    },
    forcePathStyle: true,
  });

  const res = await client.send(
    new GetObjectCommand({ Bucket: readEnv("B2_BUCKET_NAME"), Key: key })
  );
  if (!res.Body) throw new Error("Empty B2 object body");
  const buf = await streamToBuffer(res.Body as Readable);
  const json = gunzipSync(buf).toString("utf-8");
  const envelope = JSON.parse(json) as {
    received_at: string;
    event_hash: string;
    processing_version: string;
    raw_body: string;
    normalized: Record<string, unknown>;
  };

  console.log("Loaded envelope:");
  console.log("  event_hash:    ", envelope.event_hash);
  console.log("  received_at:   ", envelope.received_at);
  console.log("  processing:    ", envelope.processing_version);

  // Re-parse and re-normalize from raw_body.
  const raw = JSON.parse(envelope.raw_body) as SmartleadRawPayload;
  const normalized = normalizeSmartleadEmailSent(raw, {
    receivedAt: new Date(envelope.received_at),
    processingVersion: PROCESSING_VERSION,
  });

  const supabaseUrl = readEnvOpt("SUPABASE_URL");
  const supabaseKey = readEnvOpt("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !supabaseKey) {
    console.log("(Supabase not configured; skipping insert)");
    return;
  }

  const sb = getSupabaseClient({ url: supabaseUrl, secretKey: supabaseKey });
  const result = await insertEmailSentEvent(sb, normalized, readEnv("B2_BUCKET_NAME"), key);
  console.log("Supabase insert:", result.status, result.rowId ?? "");

  if (result.status === "inserted") {
    const eventDate = (normalized.event_timestamp ?? normalized.received_at).slice(0, 10);
    await bumpDailyCounts(sb, {
      eventDate,
      eventType: normalized.event_type,
      campaignId: normalized.campaign_id,
      campaignName: normalized.campaign_name,
      clientId: normalized.client_id,
    });
    console.log("Daily counts bumped for", eventDate);
  }
}

main().catch((err) => {
  console.error("replay failed:", err);
  process.exit(1);
});
