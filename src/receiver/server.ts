/**
 * Minimal SmartLead → Trigger.dev HTTP receiver.
 *
 * Purpose:
 *   Trigger.dev v4 (SDK 4.4.6, the version installed in this project) does NOT
 *   expose a native public HTTP endpoint for arbitrary external webhooks. The
 *   `webhooks.constructEvent` helper in the SDK verifies signatures but does not
 *   expose a URL SmartLead can POST to. Therefore we need a tiny HTTP server in
 *   front to:
 *
 *     1. accept SmartLead's POST,
 *     2. verify the shared `secret_key` (constant-time compare),
 *     3. strip `secret_key` from the payload immediately,
 *     4. hand the sanitized payload to the Trigger.dev task via `tasks.trigger()`,
 *     5. return 2xx fast so SmartLead doesn't retry.
 *
 *   That's it. NO B2, NO Supabase, NO heavy processing, NO storage. The Trigger.dev
 *   task is the only place that ever touches B2 and Supabase.
 *
 * Why we need this at all (Trigger.dev architecture):
 *   The Trigger.dev workflow runner is a private compute platform. It only executes
 *   code we deployed. There is no publicly addressable URL for an arbitrary task —
 *   we have to call `tasks.trigger()` ourselves from a publicly reachable service.
 *   This file is that service.
 *
 * Deployment:
 *   Run on any Node 20+ host (Railway, Render, Fly.io, Docker, etc). It binds to
 *   `0.0.0.0:8787` by default. It needs:
 *     - SMARTLEAD_SECRET_KEY   (the secret SmartLead sends in payload.secret_key)
 *     - TRIGGER_SECRET_KEY     (Trigger.dev project secret key for tasks.trigger)
 *
 *   The public URL SmartLead should call is:
 *     POST https://<your-host>/smartlead/email-sent
 *     Content-Type: application/json
 *     Body: SmartLead's JSON webhook payload
 */

import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import { tasks } from "@trigger.dev/sdk/v3";
import { verifySmartleadSecret, stripSecretKey } from "../lib/smartlead-normalizer";

const PORT = Number(process.env.RECEIVER_PORT ?? 8787);
const BIND = process.env.RECEIVER_BIND ?? "0.0.0.0";
const TASK_ID = process.env.TASK_ID ?? "smartlead-email-sent";

function readSecret(): string | null {
  const v = process.env.SMARTLEAD_SECRET_KEY;
  return v && v.length > 0 ? v : null;
}

const app = new Hono();

app.use("*", honoLogger());

// Health endpoint — never touches SmartLead payloads.
app.get("/health", (c) => c.json({ ok: true, task: TASK_ID }));

/**
 * SmartLead webhook ingestion endpoint.
 * Validates the secret, strips it, and triggers the Trigger.dev task with the
 * sanitized payload. No storage, no I/O beyond the SDK call.
 */
app.post("/smartlead/email-sent", async (c) => {
  // 1. Read the raw body as text.
  const rawBody = await c.req.text();

  // 2. Parse JSON — fail fast if malformed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: "malformed_json" }, 400);
  }

  if (!parsed || typeof parsed !== "object") {
    return c.json({ ok: false, error: "payload_not_object" }, 400);
  }

  // 3. Verify the secret. SmartLead sends it as payload.secret_key.
  const expected = readSecret();
  if (!expected) {
    return c.json({ ok: false, error: "server_secret_not_configured" }, 500);
  }
  const check = verifySmartleadSecret(parsed, expected);
  if (!check.ok) {
    // Never echo the secret in the response — just the reason.
    return c.json({ ok: false, error: "secret_check_failed", reason: check.reason }, 401);
  }

  // 4. Strip secret_key from the payload immediately.
  // This is the ONLY place that ever had the real secret. Everything downstream
  // (Trigger.dev task, B2, Supabase) receives a secret-free object.
  const sanitized = stripSecretKey(parsed) as Record<string, unknown>;

  // 5. Trigger the Trigger.dev task. We do NOT pass the original raw body to the
  // task — only the sanitized parsed object. The task will re-serialize it.
  // We do NOT pass secret_key, rawBody string, or anything else that could
  // include the secret. `receivedAt` is the only metadata.
  const receivedAt = new Date().toISOString();
  try {
    const handle = await tasks.trigger(TASK_ID, {
      raw: sanitized,
      receivedAt,
    });
    return c.json({
      ok: true,
      status: "triggered",
      task_id: TASK_ID,
      run_id: handle?.id ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: "trigger_failed", message }, 502);
  }
});

// Catch-all 404.
app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));

// Generic error handler so we always return JSON.
app.onError((err, c) => {
  // eslint-disable-next-line no-console
  console.error("receiver error", err);
  return c.json({ ok: false, error: "internal_error", message: err.message }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: BIND }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`smartlead receiver listening on http://${info.address}:${info.port}`);
});
