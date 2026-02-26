export function extractJsonErrorPosition(message: string): number | null {
  const match = message.match(/position\s+(\d+)/i);
  if (!match) return null;
  const pos = Number(match[1]);
  return Number.isFinite(pos) ? pos : null;
}

function buildJsonSnippet(raw: string, position: number | null): string {
  if (position === null || position < 0) return "";
  const start = Math.max(0, position - 80);
  const end = Math.min(raw.length, position + 80);
  const snippet = raw.slice(start, end);
  return snippet ? `\nAround position ${position}:\n${snippet}` : "";
}

export function parseJsonText<T = unknown>(raw: string, contextLabel = "JSON"): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    const position = extractJsonErrorPosition(details);
    const positionText = position !== null ? ` at position ${position}` : "";
    throw new Error(`Invalid ${contextLabel}${positionText}: ${details}${buildJsonSnippet(raw, position)}`);
  }
}

export function stringifyPrettyJson(value: unknown, contextLabel = "JSON"): string {
  const pretty = JSON.stringify(value, null, 2);
  if (!pretty || typeof pretty !== "string") {
    throw new Error(`${contextLabel} serialization returned empty output.`);
  }
  parseJsonText(pretty, `${contextLabel} serialization validation`);
  return pretty;
}
