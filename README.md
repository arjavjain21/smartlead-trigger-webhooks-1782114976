# SmartLead EMAIL_SENT Webhook Capture

Idempotent capture of SmartLead `EMAIL_SENT` webhooks: raw archival to Backblaze B2, searchable index in Supabase, all orchestrated by Trigger.dev.

---

## 1. Architecture — who calls whom

```
┌─────────────┐                  ┌───────────────────┐                 ┌─────────────────┐
│  SmartLead  │  POST webhook    │  Hono receiver    │  tasks.trigger │  Trigger.dev    │
│  EMAIL_SENT ├─────────────────►│  (this repo)      ├────────────────►│  smartlead-     │
│             │  (JSON + secret) │  src/receiver/    │  (sanitized)   │  email-sent     │
└─────────────┘                  │  server.ts        │                 │  task           │
                                 └───────────────────┘                 └────────┬────────┘
                                          │                                    │
                                  1. verify secret_key                       │
                                  2. strip secret_key                        │
                                  3. trigger task                            │
                                  (NO storage here)                          │
                                                                              │
                                                            ┌─────────────────┴────────────┐
                                                            │                              │
                                                            ▼                              ▼
                                                  ┌──────────────────┐          ┌──────────────────┐
                                                  │  Backblaze B2    │          │  Supabase        │
                                                  │  raw gzipped     │          │  normalized row  │
                                                  │  JSON archive    │          │  + daily counts  │
                                                  └──────────────────┘          └──────────────────┘
```

**Does SmartLead call Trigger.dev directly?**

**No.** Trigger.dev v4 (SDK 4.4.6, the version installed in this project) does not expose a native public HTTP endpoint that external services can POST to. The SDK's `webhooks.constructEvent` helper is for verifying signatures on incoming webhooks, not for exposing URLs.

**Therefore, SmartLead calls the small Hono receiver** (in `src/receiver/server.ts`), which:
1. accepts the POST,
2. verifies the shared `secret_key` (constant-time compare),
3. strips `secret_key` from the payload immediately,
4. triggers the Trigger.dev task via the SDK with the sanitized payload,
5. returns 2xx fast.

The receiver does **not** write to B2, does **not** write to Supabase, does **not** log the secret, and does **not** keep any state.

---

## 2. The exact webhook URL SmartLead should use

```
POST https://<your-receiver-host>/smartlead/email-sent
Content-Type: application/json

{ "event_type": "EMAIL_SENT", "secret_key": "...", ... }
```

Pick any HTTPS host for the receiver — Railway, Render, Fly.io, Docker on a VPS, or any Node server you already run. Point SmartLead's webhook UI at that URL and paste the same `SMARTLEAD_SECRET_KEY` you set in the receiver's environment.

---

## 3. Where to find the webhook URL

You set it. There is no "Trigger.dev public URL" for arbitrary tasks in v4.4.6. You deploy the receiver wherever you like and SmartLead calls that URL.

---

## 4. What happens to the payload after receipt

| Stage | Where | What happens to secret_key |
|-------|-------|----------------------------|
| 1. POST received | Receiver (`src/receiver/server.ts`) | Secret is verified via constant-time compare. **Verified, not stored.** |
| 2. Secret stripped | Receiver | `stripSecretKey(payload)` removes `secret_key` recursively. The secret never crosses a function boundary past this line. |
| 3. Task triggered | Receiver → `tasks.trigger()` | The sanitized object is sent over the Trigger.dev API. The original `secret_key` is not in the request. |
| 4. Re-strip in task | `src/trigger/smartlead-email-sent.ts` | `stripSecretKey(raw)` runs again as defense in depth. |
| 5. Normalize | `src/lib/smartlead-normalizer.ts` | Operates on a sanitized `SmartleadRawPayload` (zod schema). |
| 6. B2 upload | `src/lib/b2.ts` | `scrubSecretKey(envelope)` is applied right before serialization. The B2 file's `raw_body` field is the sanitized JSON, not the original. |
| 7. Supabase insert | `src/lib/supabase.ts` | The `email_sent_events` row is built from a typed `NormalizedEmailSent` that has no `secret_key` field. |
| 8. Error logging | `webhook_processing_errors` | `sample_payload` is sanitized via `stripSecretKey` before insert. |
| 9. Logs | `logger.*` | Only `event_hash`, `campaign_id`, `to_email`, `stage`, and error messages are logged. Never the secret. |

The secret is consumed exactly once, in the receiver, and discarded.

---

## 5. Where data is stored

| Store | What | Why | Key path / table |
|-------|------|-----|------------------|
| **Backblaze B2** | The full sanitized raw webhook body (gzip JSON envelope) | Source of truth, replayable, holds everything SmartLead sent EXCEPT `secret_key` | `email_sent/year=YYYY/month=MM/day=DD/hour=HH/<event_hash>.json.gz` |
| **Supabase `email_sent_events`** | One row per event, normalized, no full body | Searchable index for dashboards | `event_hash` UNIQUE |
| **Supabase `webhook_processing_errors`** | One row per failure with stage + message | Operator review when retries are exhausted | `created_at DESC` index |
| **Supabase `daily_counts`** | `(event_date, event_type) → count` | Dashboard counters | PK `(event_date, event_type)` |
| **Supabase `campaign_daily_counts`** | `(event_date, campaign_id, event_type) → count` | Campaign-level dashboard counters | PK `(event_date, campaign_id, event_type)` |
| **Trigger.dev** | Workflow state (retries, run history) | Workflow runner; not a permanent store | n/a |

---

## 6. What is NOT stored

- **`secret_key`** is NEVER stored in B2, Supabase, or any error log. The receiver is the only place that ever sees the real secret, and it discards the value immediately after verification.
- **Full HTML body** is not stored in Supabase — only a 500-char `body_preview` (plain text where available, else stripped HTML).
- **Full raw JSON** is not stored in Supabase — only the B2 location pointer and a SHA-256 hash.
- The receiver itself is stateless: it has no database, no file storage, no memory of past requests.

---

## Required Environment Variables

### Trigger.dev production env (set in the Trigger.dev dashboard)
| Variable | Purpose |
|----------|---------|
| `B2_ENDPOINT` | B2 S3-compatible endpoint (e.g. `https://s3.us-west-004.backblazeb2.com`) |
| `B2_REGION` | B2 region (e.g. `us-west-004`) |
| `B2_BUCKET_NAME` | B2 bucket name |
| `B2_KEY_ID` | B2 application key ID |
| `B2_APPLICATION_KEY` | B2 application key secret |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase `service_role` key (NOT anon key) |

### Receiver env (set on whatever host runs `src/receiver/server.ts`)
| Variable | Purpose | Default |
|----------|---------|---------|
| `SMARTLEAD_SECRET_KEY` | The shared secret SmartLead sends in `payload.secret_key` | — |
| `TRIGGER_SECRET_KEY` | Trigger.dev project secret key for `tasks.trigger()` calls | — |
| `RECEIVER_PORT` | HTTP port the receiver listens on | `8787` |
| `RECEIVER_BIND` | Bind address | `0.0.0.0` |
| `TASK_ID` | Trigger.dev task ID to trigger | `smartlead-email-sent` |

---

## Quick start

```bash
# 1. Install
npm install

# 2. Apply Supabase schema (paste supabase/schema.sql into Supabase SQL editor)

# 3. Run unit tests (no external services needed)
npm run test

# 4. Run local normalizer smoke test
npm run test:sample

# 5. Test B2 upload
B2_ENDPOINT=... B2_REGION=... B2_BUCKET_NAME=... B2_KEY_ID=... B2_APPLICATION_KEY=... npm run test:b2

# 6. Test Supabase insert
SUPABASE_URL=... SUPABASE_SECRET_KEY=... B2_BUCKET_NAME=... npm run test:supabase

# 7. Start the HTTP receiver locally
SMARTLEAD_SECRET_KEY=xxx TRIGGER_SECRET_KEY=tr_dev_xxx npm run receiver

# 8. Deploy the Trigger.dev task
npm run deploy:prod

# 9. Deploy the receiver to a public HTTPS host (Railway/Render/Fly/Docker)

# 10. Configure SmartLead to POST to https://<receiver-host>/smartlead/email-sent
#     with the same SMARTLEAD_SECRET_KEY

# 11. Replay a B2 object if needed
B2_* SUPABASE_* npm run replay -- email_sent/year=2026/month=06/day=22/hour=10/<hash>.json.gz
```

---

## File tree

```
smartlead-trigger-webhooks/
├── src/
│   ├── trigger/
│   │   ├── example.ts                    (pre-existing, untouched)
│   │   └── smartlead-email-sent.ts       Trigger.dev task (idempotent workflow)
│   ├── lib/
│   │   ├── smartlead-normalizer.ts       Zod schema, normalization, dedupe hash, secret verify, stripSecretKey
│   │   ├── b2.ts                         AWS SDK v3 B2 upload, scrubSecretKey, UTC key path
│   │   ├── supabase.ts                   Supabase insert, daily count bumps, error recording
│   │   ├── hash.ts                       Stable canonical JSON + SHA256
│   │   ├── html.ts                       HTML→text stripping, body_preview, domain extraction
│   │   └── errors.ts                     ProcessingError, stage constants
│   └── receiver/
│       └── server.ts                     Minimal Hono HTTP receiver (validate + strip + trigger only)
├── supabase/
│   └── schema.sql                        4 tables + 2 RPC upserts + all indexes
├── samples/
│   └── smartlead-email-sent.sample.json
├── scripts/
│   ├── test-local.ts                     Normalizer smoke test
│   ├── test-b2-upload.ts                 B2 upload script
│   ├── test-supabase-insert.ts           Supabase insert script
│   └── replay-b2-file.ts                 B2 replay script
├── tests/
│   ├── normalizer.test.ts                36 normalizer tests
│   └── secret-safety.test.ts             16 secret-removal tests
├── trigger.config.ts
├── vitest.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

---

## Normalization rules

| Field | New (preferred) | Deprecated fallback |
|-------|-----------------|---------------------|
| Timestamp | `event_timestamp` | `time_sent` |
| Subject | `subject` | `custom_subject` |
| Message ID | `sent_message.message_id` | `message_id` |
| HTML body | `sent_message.html` | `sent_message_body`, `custom_email_message` |
| Text body | `sent_message.text` | _(none)_ |
| App URL | `app_url` | `ui_master_inbox_link` |

Derived: `from_domain` / `to_domain` (extracted from email), `body_preview` (text first, else stripped HTML, max 500 chars).

---

## Dedupe

`event_hash` is computed in this order:
1. `sent_message.message_id` + `campaign_id` + `to_email` → SHA256
2. `stats_id` → SHA256
3. Canonicalized full JSON payload → SHA256

The B2 key includes `event_hash` so retries naturally overwrite the same B2 object. Supabase has a UNIQUE constraint on `event_hash` so duplicate inserts become no-ops. The daily/campaign counts use atomic Postgres `INSERT ... ON CONFLICT ... DO UPDATE` so concurrent retries don't double-count.

---

## Retry safety

Every step is idempotent:
- B2: same `event_hash` key overwrites the same object.
- Supabase: UNIQUE constraint on `event_hash` means re-insert is safe.
- Counts: atomic upsert RPCs.

If B2 upload fails, the task throws and Trigger.dev retries — Supabase is never updated. If Supabase insert fails after B2 succeeds, the failure is recorded in `webhook_processing_errors` for operator review.

---

## Security

- `secret_key` is verified against `SMARTLEAD_SECRET_KEY` using constant-time comparison.
- `secret_key` is stripped from the payload in the receiver immediately after verification.
- The task and lib layers re-strip `secret_key` defensively — `stripSecretKey` (in normalizer) and `scrubSecretKey` (in b2.ts) recursively remove any `secret_key` field from any object before serialization.
- `secret_key` is never logged, never stored in B2, never stored in Supabase, never included in `webhook_processing_errors.sample_payload`.
- Supabase uses `service_role` (server-side only) and B2 keys are never exposed to any frontend.

The 16 tests in `tests/secret-safety.test.ts` prove the secret is removed at every storage boundary.

---

## Known limitations

- v1 stores one raw B2 object per webhook. B2 upload operations are cheap so this is fine at moderate volume; a future batching/compaction module can collapse objects by day.
- Supabase is the searchable index, not the raw warehouse. Full payloads live only in B2.
- Long-term analytics may eventually require ClickHouse consuming from B2.
- No dashboard UI, no Slack forwarding, no OVH storage, no MinIO in v1.

---

## Assumptions

- SmartLead sends `Content-Type: application/json` POSTs with `secret_key` at the top level.
- SmartLead's `EMAIL_SENT` payload includes at least one of `sent_message`, `sent_message_body`, or `custom_email_message`.
- B2 credentials have write access to the configured bucket.
- Supabase uses the `service_role` key.
- Email addresses are well-formed enough for simple domain extraction.
- `processing_version` is `1.0.0` — bump if the normalizer's output shape changes.
- Trigger.dev task retries (3 attempts, 1s–10s exponential) are safe for the idempotent pipeline.
