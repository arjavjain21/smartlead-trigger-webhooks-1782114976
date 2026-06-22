/**
 * scripts/test-supabase-insert.ts
 *
 * Load sample, normalize, insert into Supabase. Prints the row id and event_hash.
 * Run with:
 *   npx tsx scripts/test-supabase-insert.ts
 *
 * Requires env: SUPABASE_URL, SUPABASE_SECRET_KEY.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSmartleadEmailSent, PROCESSING_VERSION } from "../src/lib/smartlead-normalizer";
import { getSupabaseClient, insertEmailSentEvent, bumpDailyCounts } from "../src/lib/supabase";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function main() {
  const samplePath = resolve(__dirname, "../samples/smartlead-email-sent.sample.json");
  const rawBody = readFileSync(samplePath, "utf-8");
  const parsed = JSON.parse(rawBody);

  const normalized = normalizeSmartleadEmailSent(parsed, {
    receivedAt: new Date(),
    processingVersion: PROCESSING_VERSION,
  });

  const client = getSupabaseClient({
    url: readEnv("SUPABASE_URL"),
    secretKey: readEnv("SUPABASE_SECRET_KEY"),
  });

  // B2 bucket/key are required NOT NULL columns in email_sent_events.
  // We use a stub here because this script only exercises the Supabase side.
  const result = await insertEmailSentEvent(
    client,
    normalized,
    process.env.B2_BUCKET_NAME ?? "TEST_BUCKET",
    `test/${normalized.event_hash}.json.gz`
  );

  console.log("Supabase insert result:");
  console.log("  status:    ", result.status);
  console.log("  event_hash:", normalized.event_hash);
  if (result.rowId !== undefined) {
    console.log("  row_id:    ", result.rowId);
  }

  if (result.status === "inserted") {
    const eventDate = (normalized.event_timestamp ?? normalized.received_at).slice(0, 10);
    await bumpDailyCounts(client, {
      eventDate,
      eventType: normalized.event_type,
      campaignId: normalized.campaign_id,
      campaignName: normalized.campaign_name,
      clientId: normalized.client_id,
    });
    console.log("  daily counts: bumped for", eventDate);
  }
}

main().catch((err) => {
  console.error("Supabase insert failed:", err);
  process.exit(1);
});
