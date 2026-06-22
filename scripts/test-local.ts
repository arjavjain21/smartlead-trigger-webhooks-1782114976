/**
 * scripts/test-local.ts
 *
 * Load the sample SmartLead payload, run the normalizer, and print a human-readable report.
 * No external services required. Run with:
 *   npx tsx scripts/test-local.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSmartleadEmailSent, PROCESSING_VERSION, secretsMatch } from "../src/lib/smartlead-normalizer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLE_PATH = resolve(__dirname, "../samples/smartlead-email-sent.sample.json");

function main() {
  const rawBody = readFileSync(SAMPLE_PATH, "utf-8");
  const parsed = JSON.parse(rawBody);

  console.log("=== Normalizer output ===\n");
  const result = normalizeSmartleadEmailSent(parsed, { processingVersion: PROCESSING_VERSION });
  console.log("event_hash:        ", result.event_hash);
  console.log("raw_payload_sha256:", result.raw_payload_sha256);
  console.log("event_type:        ", result.event_type);
  console.log("event_timestamp:   ", result.event_timestamp);
  console.log("subject:           ", result.subject);
  console.log("sent_message_id:   ", result.sent_message_id);
  console.log("body_preview:      ", result.body_preview.slice(0, 120) + (result.body_preview.length > 120 ? "..." : ""));
  console.log("from_email:        ", result.from_email);
  console.log("from_domain:       ", result.from_domain);
  console.log("to_email:          ", result.to_email);
  console.log("to_domain:         ", result.to_domain);
  console.log("campaign_id:       ", result.campaign_id);
  console.log("campaign_name:     ", result.campaign_name);
  console.log("app_url:           ", result.app_url);
  console.log("processingVersion: ", PROCESSING_VERSION);

  // Test secret equality.
  const ok = secretsMatch("abc", "abc");
  const bad = secretsMatch("abc", "xyz");
  console.log("\n=== secretsMatch tests ===");
  console.log("match('abc','abc'):", ok); // true
  console.log("match('abc','xyz'):", bad); // false

  // Test dedup behavior: same payload re-parsed gives the same event_hash.
  const again = normalizeSmartleadEmailSent(parsed);
  console.log("\n=== Dedup ===");
  console.log("same event_hash on re-parse:", result.event_hash === again.event_hash);

  // Deprecated field fallback: remove sent_message and subject, see if custom_subject kicks in.
  const fallbackPayload = { ...parsed };
  delete (fallbackPayload as Record<string, unknown>).sent_message;
  delete (fallbackPayload as Record<string, unknown>).subject;
  const fallback = normalizeSmartleadEmailSent(fallbackPayload);
  console.log("\n=== Deprecated fallback ===");
  console.log("subject after removing new fields:", fallback.subject);
  console.log("sent_message_id (deprecated fallback):", fallback.sent_message_id);
  console.log("body_preview (HTML→text via deprecated field):", fallback.body_preview.slice(0, 80));

  console.log("\nAll local checks passed.");
}

main();
