// Shared error stages so logs and the webhook_processing_errors table stay consistent.
// Keeping these as string literal unions lets us exhaustively handle them elsewhere.
export const ERROR_STAGES = [
  "validate_payload",
  "normalize_payload",
  "upload_b2",
  "insert_supabase",
  "update_counts",
] as const;

export type ErrorStage = (typeof ERROR_STAGES)[number];

export class ProcessingError extends Error {
  readonly stage: ErrorStage;
  readonly cause?: unknown;
  readonly eventHash?: string;

  constructor(stage: ErrorStage, message: string, options?: { cause?: unknown; eventHash?: string }) {
    super(message);
    this.name = "ProcessingError";
    this.stage = stage;
    this.cause = options?.cause;
    this.eventHash = options?.eventHash;
  }
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function toErrorStack(err: unknown): string | null {
  if (err instanceof Error && err.stack) return err.stack;
  return null;
}
