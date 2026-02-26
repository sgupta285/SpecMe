export type ParsedApiError = {
  reason?: string;
  reasonMessage?: string;
  exactReason?: string;
  nextSteps?: string;
  error?: string;
  technicalDetails?: string;
  message?: string;
};

export type UiErrorContent = {
  reason: string;
  nextSteps: string;
  technicalDetails?: string;
};

const AUTH_OR_PERMISSION_REASONS = new Set([
  "auth_failed",
  "permission_denied",
  "repo_not_found",
  "remote_rejected",
  "origin_not_allowed",
  "network_error",
  "gemini_rate_limited",
  "gemini_model_not_found",
]);

export function shouldUseErrorDialog(reason?: string, rawText?: string) {
  const normalized = (reason || "").trim().toLowerCase();
  if (AUTH_OR_PERMISSION_REASONS.has(normalized)) return true;
  const raw = (rawText || "").toLowerCase();
  return (
    raw.includes("permission") ||
    raw.includes("authentication") ||
    raw.includes("token") ||
    raw.includes("forbidden") ||
    raw.includes("403")
  );
}

export function parseApiErrorText(raw: string): ParsedApiError {
  try {
    return JSON.parse(raw) as ParsedApiError;
  } catch {
    return { error: raw };
  }
}

export function buildUiError(parsed: ParsedApiError, fallbackReason: string, fallbackNextSteps: string): UiErrorContent {
  return {
    reason:
      parsed.exactReason ||
      parsed.reasonMessage ||
      parsed.error ||
      parsed.message ||
      fallbackReason,
    nextSteps: parsed.nextSteps || fallbackNextSteps,
    technicalDetails: parsed.technicalDetails,
  };
}
