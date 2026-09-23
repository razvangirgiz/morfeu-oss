import { APIConnectionError, APIUserAbortError } from "openai";

const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as { status?: number; statusCode?: number };
  return rec.status ?? rec.statusCode;
}

function codeOf(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function typeOf(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function headerOf(err: unknown, name: string): string | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") return null;
  const value = get.call(headers, name);
  return typeof value === "string" ? value : null;
}

function hasTransientNetworkCode(err: unknown): boolean {
  let current = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (TRANSIENT_NETWORK_CODES.has(codeOf(current) ?? "")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isRetryable(err: unknown): boolean {
  const permanentQuotaFailure =
    typeOf(err) === "insufficient_quota" ||
    ["insufficient_quota", "credit_balance_exhausted"].includes(codeOf(err) ?? "");
  if (permanentQuotaFailure || err instanceof APIUserAbortError) return false;
  if (err instanceof APIConnectionError || hasTransientNetworkCode(err)) return true;

  const serverDirective = headerOf(err, "x-should-retry");
  if (serverDirective === "true") return true;
  if (serverDirective === "false") return false;

  const status = statusOf(err);
  return status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500);
}

function retryDelayMs(err: unknown, attempt: number): number {
  const retryAfterMs = Number.parseFloat(headerOf(err, "retry-after-ms") ?? "");
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 60_000) {
    return retryAfterMs;
  }

  const retryAfter = headerOf(err, "retry-after");
  if (retryAfter !== null) {
    const seconds = Number.parseFloat(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay >= 0 && delay <= 60_000) return delay;
  }

  return Math.min(8000, 200 * 2 ** attempt);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(err, i)));
    }
  }
  throw last;
}
