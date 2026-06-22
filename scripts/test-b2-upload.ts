/**
 * scripts/test-b2-upload.ts
 *
 * Load sample, normalize, gzip, upload to Backblaze B2. Prints the resulting B2 key.
 * Run with:
 *   npx tsx scripts/test-b2-upload.ts
 *
 * Requires env: B2_ENDPOINT, B2_REGION, B2_BUCKET_NAME, B2_KEY_ID, B2_APPLICATION_KEY.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSmartleadEmailSent, PROCESSING_VERSION } from "../src/lib/smartlead-normalizer";
import { uploadToB2, type B2Config } from "../src/lib/b2";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readEnv(key: string, optional = false): string | undefined {
  const v = process.env[key];
  if (!v && !optional) throw new Error(`Missing env var: ${key}`);
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

  const b2: B2Config = {
    endpoint: readEnv("B2_ENDPOINT")!,
    region: readEnv("B2_REGION")!,
    bucket: readEnv("B2_BUCKET_NAME")!,
    keyId: readEnv("B2_KEY_ID")!,
    applicationKey: readEnv("B2_APPLICATION_KEY")!,
  };

  const result = await uploadToB2(b2, {
    eventHash: normalized.event_hash,
    receivedAt: new Date(normalized.received_at),
    rawBody,
    normalized: { ...normalized },
    processingVersion: PROCESSING_VERSION,
  });

  console.log("B2 upload result:");
  console.log("  bucket:         ", result.bucket);
  console.log("  key:            ", result.key);
  console.log("  alreadyExisted: ", result.alreadyExisted);
  console.log("  event_hash:     ", normalized.event_hash);
}

main().catch((err) => {
  console.error("B2 upload failed:", err);
  process.exit(1);
});
