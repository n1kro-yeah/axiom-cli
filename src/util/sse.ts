import { AxiomError } from "./errors.js";
import { createLogger } from "./log.js";

const log = createLogger("sse");

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
  retry?: number;
}

export type SseHandler = (event: SseEvent) => void | Promise<void>;

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchWithTimeout(url: string, options: FetchJsonOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayExternal = () => controller.abort();
  options.signal?.addEventListener("abort", relayExternal, { once: true });

  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw AxiomError.aborted("Request");
    throw AxiomError.network(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayExternal);
  }
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw AxiomError.provider(
      `HTTP ${response.status} ${response.statusText}: ${truncateText(text, 600)}`,
      response.status,
      response.status === 429 || response.status >= 500
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new AxiomError(`Malformed JSON response from ${url}: ${truncateText(text, 300)}`, {
      code: "provider_error",
      cause: error
    });
  }
}

export function truncateText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  handler: SseHandler,
  externalSignal?: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let sawAnyData = false;

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  externalSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (externalSignal?.aborted) throw AxiomError.aborted("Stream");
      const chunk = await reader.read();
      if (chunk.done) break;
      sawAnyData = true;
      buffer += decoder.decode(chunk.value, { stream: true });

      let boundary = findEventBoundary(buffer);
      while (boundary !== null) {
        const rawEvent = buffer.slice(0, boundary.endIndex);
        buffer = buffer.slice(boundary.endIndex + boundary.separatorLength);
        const parsed = parseRawSseBlock(rawEvent);
        if (parsed) await handler(parsed);
        boundary = findEventBoundary(buffer);
      }
    }

    if (buffer.trim().length > 0) {
      const parsed = parseRawSseBlock(buffer);
      if (parsed) await handler(parsed);
    }

    if (!sawAnyData) {
      log.warn("stream closed without delivering any events");
    }
  } catch (error) {
    if (externalSignal?.aborted) throw AxiomError.aborted("Stream");
    throw error;
  } finally {
    externalSignal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
    }
  }
}

interface Boundary {
  endIndex: number;
  separatorLength: number;
}

function findEventBoundary(buffer: string): Boundary | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const lfOnly = buffer.indexOf("\n\r\n");

  let best: Boundary | null = null;
  if (lfIndex !== -1) best = { endIndex: lfIndex, separatorLength: 2 };
  if (crlfIndex !== -1 && (best === null || crlfIndex + 2 < best.endIndex)) {
    best = { endIndex: crlfIndex, separatorLength: 4 };
  }
  if (lfOnly !== -1 && (best === null || lfOnly < best.endIndex)) {
    best = { endIndex: lfOnly, separatorLength: 3 };
  }
  return best;
}

export function parseRawSseBlock(rawBlock: string): SseEvent | null {
  const normalized = rawBlock.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.trim().length === 0) return null;
  if (normalized.startsWith(":")) return null;

  const dataLines: string[] = [];
  let eventName: string | undefined;
  let eventId: string | undefined;
  let retry: number | undefined;

  for (const line of normalized.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        eventName = value;
        break;
      case "id":
        eventId = value;
        break;
      case "retry": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  if (dataLines.length === 0) return null;
  const event: SseEvent = { data: dataLines.join("\n") };
  if (eventName !== undefined) event.event = eventName;
  if (eventId !== undefined) event.id = eventId;
  if (retry !== undefined) event.retry = retry;
  return event;
}

export function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function readStreamAsText(body: ReadableStream<Uint8Array>, limitBytes = 5_000_000): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
    if (total >= limitBytes) {
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text;
}

export function buildUrl(base: string, path: string, query?: Record<string, string>): string {
  let root = base.endsWith("/") ? base.slice(0, -1) : base;
  let suffix = path.startsWith("/") ? path : `/${path}`;
  if (!/^https?:\/\//.test(root)) root = `https://${root}`;
  const url = new URL(`${root}${suffix}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private settled = false;
  private failure: unknown;
  private waiters: Array<{ resolve: () => void }> = [];

  push(item: T): void {
    if (this.settled) return;
    this.items.push(item);
    this.wake();
  }

  end(error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.failure = error;
    this.wake();
  }

  get finished(): boolean {
    return this.settled && this.items.length === 0;
  }

  private wake(): void {
    const pending = [...this.waiters];
    this.waiters.length = 0;
    for (const waiter of pending) waiter.resolve();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          const item = this.items.shift();
          return Promise.resolve({ value: item as T, done: false });
        }
        if (this.settled) {
          if (this.failure !== undefined) return Promise.reject(this.failure);
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push({
            resolve: () => {
              if (this.items.length > 0) {
                const item = this.items.shift();
                resolve({ value: item as T, done: false });
              } else if (this.settled) {
                if (this.failure !== undefined) {
                  resolve({ value: undefined as unknown as T, done: true });
                  return;
                }
                resolve({ value: undefined as unknown as T, done: true });
              }
            }
          });
        });
      }
    };
  }
}

export function bridgeSseToQueue(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  mapEvent: (event: SseEvent) => void | StreamEventLike
): { queue: AsyncQueue<StreamEventLike>; completion: Promise<void> } {
  const queue = new AsyncQueue<StreamEventLike>();
  const completion = consumeSseStream(body, (event) => {
    const mapped = mapEvent(event);
    if (mapped) queue.push(mapped);
  }, signal)
    .then(() => queue.end())
    .catch((error) => queue.end(error));

  return { queue, completion };
}

export interface StreamEventLike {
  kind: string;
  [key: string]: unknown;
}

