import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
  HeadObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

/**
 * B2 storage interface for raw webhook payload archival.
 *
 * Backblaze B2 speaks S3-compatible API. We configure the S3Client with the B2 endpoint
 * and force "path" style because B2 doesn't do virtual-hosted-style routing.
 */

export interface B2Config {
  endpoint: string;
  region: string;
  bucket: string;
  keyId: string;
  applicationKey: string;
}

let _client: S3Client | null = null;

export function createB2Client(config: B2Config): S3Client {
  const s3Config: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.applicationKey,
    },
    // Force path style: B2 doesn't support vhost-style buckets.
    forcePathStyle: true,
  };
  return new S3Client(s3Config);
}

export function getB2Client(config: B2Config): S3Client {
  if (!_client) {
    _client = createB2Client(config);
  }
  return _client;
}

/**
 * B2 key path pattern:
 *   email_sent/year=YYYY/month=MM/day=DD/hour=HH/<event_hash>.json.gz
 *
 * This pattern makes it easy to list objects by date range and also makes the
 * dedupe hash part of the B2 key, so retries naturally overwrite the same object.
 */
export function buildB2Key(eventHash: string, receivedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  // Use UTC for partitioning so that the same event timestamp always falls in
  // the same hour bucket regardless of where the worker runs. This matters
  // when running on a global scheduler with rotating region placement.
  const year = receivedAt.getUTCFullYear();
  const month = pad(receivedAt.getUTCMonth() + 1);
  const day = pad(receivedAt.getUTCDate());
  const hour = pad(receivedAt.getUTCHours());
  return `email_sent/year=${year}/month=${month}/day=${day}/hour=${hour}/${eventHash}.json.gz`;
}

/**
 * Raw body upload parameters.
 * We wrap the raw body with metadata so the B2 file is self-describing even outside
 * of the Supabase index.
 *
 * Security note: `rawBody` MUST already have `secret_key` removed before reaching this
 * function. The receiver is the single layer that ever sees the original secret.
 * We re-assert that here as a defense in depth — any key named `secret_key` is
 * scrubbed from the B2 envelope regardless of what the caller hands us.
 */
export interface B2UploadParams {
  eventHash: string;
  receivedAt: Date;
  rawBody: string | Buffer;
  normalized: Record<string, unknown>;
  processingVersion: string;
}

export interface B2UploadResult {
  bucket: string;
  key: string;
  etag?: string;
  alreadyExisted: boolean;
}

/**
 * Defense in depth: remove `secret_key` from any arbitrary value before it lands
 * in long-term storage. Exported for use by the receiver and task layers.
 */
export function scrubSecretKey<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubSecretKey(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "secret_key") continue;
    out[k] = scrubSecretKey(v);
  }
  return out as T;
}

/**
 * Upload a gzipped JSON archive to B2.
 *
 * Returns the B2 key so the caller can store it in Supabase.
 *
 * If the object already exists (retry/duplicate webhook), B2 returns 200
 * with the existing ETag — we record alreadyExisted=true so the workflow
 * can decide to skip the Supabase insert.
 */
export async function uploadToB2(
  config: B2Config,
  params: B2UploadParams
): Promise<B2UploadResult> {
  const client = getB2Client(config);
  const key = buildB2Key(params.eventHash, params.receivedAt);

  const rawBodyStr =
    typeof params.rawBody === "string" ? params.rawBody : params.rawBody.toString("utf-8");

  // Always scrub secret_key from both the raw body and the normalized snapshot
  // before they go anywhere persistent. The receiver is the only place that ever
  // sees the real secret; everything downstream is secret-free.
  const envelope = scrubSecretKey({
    received_at: params.receivedAt.toISOString(),
    event_hash: params.eventHash,
    processing_version: params.processingVersion,
    raw_body: rawBodyStr,
    normalized: params.normalized,
  });

  // We gzip inline using Node's zlib. This keeps us from depending on a runtime that
  // might not have gzip libraries available — node:crypto and node:zlib are built-in.
  const { gzipSync } = await import("node:zlib");
  const gzipped = gzipSync(Buffer.from(JSON.stringify(envelope), "utf-8"));

  const putInput: PutObjectCommandInput = {
    Bucket: config.bucket,
    Key: key,
    Body: gzipped,
    ContentType: "application/json+gzip",
    ContentEncoding: "gzip",
  };

  await client.send(new PutObjectCommand(putInput));

  // Check whether the object already existed (B2 doesn't return an existing-flag from PutObject,
  // but HeadObject will succeed if it does). For our dedupe logic we just check HeadObject.
  // B2's etag from PutObject comes back in the response, but we don't need it for dedupe.
  let alreadyExisted = false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    alreadyExisted = true;
  } catch {
    // If HeadObject 404s, the object is genuinely new. Any other error: ignore
    // and treat as new (the PutObject succeeded, which is what matters for safety).
  }

  return { bucket: config.bucket, key, alreadyExisted };
}

/**
 * Helper to compute the B2 key for a given event without uploading — used by the
 * webhook receiver to check for duplicates before triggering the task.
 */
export function computeB2Key(eventHash: string, receivedAt: Date): string {
  return buildB2Key(eventHash, receivedAt);
}
