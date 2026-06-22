/**
 * Strip HTML tags to produce a plain-text preview.
 * Intentionally simple — this is for a 500-char preview, not for fidelity.
 * We don't trust the input to be valid HTML; we just want something readable.
 */
export function stripHtmlToText(html: string): string {
  if (!html) return "";
  // Remove <style> and <script> blocks entirely (including their content).
  let out = html.replace(/<\s*(style|script)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  // Replace block-level closing tags with newlines so text doesn't run together.
  out = out.replace(/<\s*\/(p|div|br|li|h[1-6]|tr|td|th)\s*>/gi, "\n");
  // Strip all remaining tags.
  out = out.replace(/<[^>]+>/g, " ");
  // Decode the most common entities.
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
  // Collapse whitespace.
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * Build a body_preview with a hard 500-character cap.
 * Uses plain text first, else falls back to stripped HTML.
 */
export function buildBodyPreview(args: { text?: string | null; html?: string | null }, max = 500): string {
  const text = (args.text ?? "").trim();
  const html = (args.html ?? "").trim();
  let candidate = "";
  if (text) {
    candidate = text;
  } else if (html) {
    candidate = stripHtmlToText(html);
  }
  if (candidate.length <= max) return candidate;
  return candidate.slice(0, max);
}

/**
 * Best-effort domain extraction. Returns lowercase domain or null if input is malformed.
 * We intentionally don't try to be RFC 5321 perfect — SmartLead emails we trust enough to
 * receive are well-formed enough for a simple split.
 */
export function extractDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) return null;
  return domain;
}
