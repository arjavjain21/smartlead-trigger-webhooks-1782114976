import { createHash } from "node:crypto";

/**
 * Deterministic, stable JSON canonicalization.
 * We sort keys recursively so two structurally identical payloads produce identical bytes,
 * regardless of original key order. This is what makes event_hash reliable for dedupe.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + canonicalize(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Best-effort stable hash of the raw webhook body even before we've validated it.
 * Useful when we want to dedupe before normalization.
 */
export function sha256OfBuffer(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}
