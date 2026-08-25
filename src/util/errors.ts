export type AxiomErrorCode =
  | "provider_error"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_overloaded"
  | "network_error"
  | "timeout"
  | "aborted"
  | "config_invalid"
  | "config_missing"
  | "permission_denied"
  | "tool_failed"
  | "session_corrupt"
  | "mcp_failure"
  | "lsp_failure"
  | "internal";

export interface AxiomErrorOptions {
  code?: AxiomErrorCode;
  cause?: unknown;
  retryable?: boolean;
  status?: number;
  details?: Record<string, unknown>;
}

export class AxiomError extends Error {
  readonly code: AxiomErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: AxiomErrorOptions = {}) {
    super(message);
    this.name = "AxiomError";
    this.code = options.code ?? "internal";
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  static provider(message: string, status?: number, retryable = false): AxiomError {
    return new AxiomError(message, { code: "provider_error", retryable, status });
  }

  static auth(provider: string, message: string): AxiomError {
    return new AxiomError(`[${provider}] ${message}`, { code: "provider_auth", retryable: false });
  }

  static rateLimit(provider: string, retryAfterMs?: number): AxiomError {
    return new AxiomError(
      `[${provider}] Rate limit reached.${retryAfterMs ? ` Retry after ${Math.ceil(retryAfterMs / 1000)}s.` : ""}`,
      { code: "provider_rate_limit", retryable: true, status: 429 }
    );
  }

  static overloaded(provider: string): AxiomError {
    return new AxiomError(`[${provider}] Model is overloaded, try again shortly.`, {
      code: "provider_overloaded",
      retryable: true,
      status: 529
    });
  }

  static network(cause: unknown): AxiomError {
    return new AxiomError(`Network failure: ${describeCause(cause)}`, {
      code: "network_error",
      retryable: true,
      cause
    });
  }

  static timeout(operation: string, ms: number): AxiomError {
    return new AxiomError(`${operation} timed out after ${ms}ms`, { code: "timeout", retryable: true });
  }

  static aborted(operation = "Operation"): AxiomError {
    const error = new AxiomError(`${operation} was aborted`, { code: "aborted", retryable: false });
    return error;
  }

  static config(message: string): AxiomError {
    return new AxiomError(message, { code: "config_invalid", retryable: false });
  }

  static configMissing(message: string): AxiomError {
    return new AxiomError(message, { code: "config_missing", retryable: false });
  }

  static permissionDenied(tool: string): AxiomError {
    return new AxiomError(`Permission denied for tool "${tool}"`, { code: "permission_denied" });
  }

  static toolFailed(tool: string, message: string): AxiomError {
    return new AxiomError(`Tool "${tool}" failed: ${message}`, { code: "tool_failed" });
  }

  static sessionCorrupt(path: string, cause?: unknown): AxiomError {
    return new AxiomError(`Session file at ${path} is corrupted`, {
      code: "session_corrupt",
      cause
    });
  }

  static mcp(server: string, message: string): AxiomError {
    return new AxiomError(`MCP server "${server}": ${message}`, { code: "mcp_failure" });
  }

  static lsp(server: string, message: string): AxiomError {
    return new AxiomError(`LSP server "${server}": ${message}`, { code: "lsp_failure" });
  }
}

export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(describeCause(error));
}

export function toAxiomError(error: unknown, fallbackCode: AxiomErrorCode = "internal"): AxiomError {
  if (error instanceof AxiomError) return error;
  const normalized = normalizeError(error);
  const abortNames = ["AbortError", "DOMException"];
  if (abortNames.includes(normalized.name)) return AxiomError.aborted();
  const message = normalized.message.toLowerCase();
  if (message.includes("econnrefused") || message.includes("enotfound") || message.includes("econnreset")) {
    return AxiomError.network(normalized);
  }
  if (message.includes("aborted") || message.includes("abort")) {
    return AxiomError.aborted();
  }
  return new AxiomError(normalized.message, { code: fallbackCode, cause: normalized });
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  respectRetryAfter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 800,
  maxDelayMs: 16000,
  jitterRatio: 0.25,
  respectRetryAfter: true
};

export function computeBackoff(attempt: number, policy: RetryPolicy, retryAfterHeader?: string | null): number {
  if (policy.respectRetryAfter && retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60000);
    }
    const date = Date.parse(retryAfterHeader);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 250), 60000);
    }
  }
  const exponential = policy.baseDelayMs * Math.pow(2, Math.max(attempt - 1, 0));
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitterSpan = capped * policy.jitterRatio;
  return Math.round(capped - jitterSpan / 2 + Math.random() * jitterSpan);
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof AxiomError) return error.retryable;
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    const message = error.message.toLowerCase();
    return (
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("socket hang up") ||
      message.includes("fetch failed")
    );
  }
  return false;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: { policy?: Partial<RetryPolicy>; label?: string; signal?: AbortSignal; onRetry?: (attempt: number, delayMs: number, error: unknown) => void } = {}
): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw AxiomError.aborted(options.label ?? "Operation");
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof AxiomError && error.code === "aborted") throw error;
      if (attempt >= policy.maxAttempts || !isRetryable(error)) break;
      const delay = computeBackoff(attempt, policy, extractRetryAfter(error));
      options.onRetry?.(attempt, delay, error);
      await sleep(delay, options.signal);
    }
  }

  throw toAxiomError(lastError);
}

function extractRetryAfter(error: unknown): string | null {
  if (error instanceof AxiomError && typeof error.status === "number" && error.status === 429) {
    const detail = error.details?.["retryAfter"];
    if (typeof detail === "string") return detail;
    if (typeof detail === "number") return String(detail);
  }
  return null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(AxiomError.aborted());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(AxiomError.aborted());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  outerSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const relay = () => controller.abort();
  outerSignal?.addEventListener("abort", relay, { once: true });

  try {
    return await promiseFactory(controller.signal);
  } catch (error) {
    if (timedOut) throw AxiomError.timeout(label, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", relay);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof AxiomError) return error.message;
  return describeCause(error);
}

export function formatErrorChain(error: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  const current = normalizeError(error);
  const lines = [`${current.name}: ${current.message}`];
  const cause = (current as { cause?: unknown }).cause;
  if (cause) lines.push(...formatErrorChain(cause, depth + 1));
  return lines;
}
