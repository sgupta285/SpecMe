const DEFAULT_API_BASES = ["http://127.0.0.1:4000", "http://localhost:4000"];

function normalizeBase(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function swapLocalhostHost(base: string): string[] {
  try {
    const url = new URL(base);
    if (url.hostname === "localhost") {
      const clone = new URL(url.toString());
      clone.hostname = "127.0.0.1";
      return [base, normalizeBase(clone.toString())];
    }
    if (url.hostname === "127.0.0.1") {
      const clone = new URL(url.toString());
      clone.hostname = "localhost";
      return [base, normalizeBase(clone.toString())];
    }
  } catch {
    return [base];
  }
  return [base];
}

export function getApiBases(): string[] {
  const configured = (import.meta.env.VITE_API_URL ?? "").toString().trim();
  const candidates = configured
    ? swapLocalhostHost(normalizeBase(configured))
    : [];

  for (const fallback of DEFAULT_API_BASES) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }

  return candidates;
}

export function getPrimaryApiBase(): string {
  return getApiBases()[0];
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const errors: string[] = [];

  for (const base of getApiBases()) {
    try {
      return await fetch(`${base}${normalizedPath}`, init);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${base} (${msg})`);
    }
  }

  throw new Error(
    `Could not reach backend server. Tried: ${errors.join(", ")}. ` +
      "Start the API server and ensure port 4000 is reachable."
  );
}
