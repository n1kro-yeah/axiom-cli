import type { JsonRpcId, JsonRpcMessage } from "./jsonrpc.js";
import { serializeMessage } from "./jsonrpc.js";
import { createLogger } from "../util/log.js";
import { fetchWithTimeout, parseRawSseBlock } from "../util/sse.js";

const log = createLogger("mcp-http");

export interface HttpTransportEvents {
  onMessage: (message: JsonRpcMessage) => void;
  onClose: (code: number | null, reason: string) => void;
  onError: (error: string) => void;
}

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  requestTimeoutMs: number;
}

interface PendingEntry {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HttpTransport {
  private sessionId: string | null = null;
  private terminated = false;
  private readonly pending = new Map<JsonRpcId, PendingEntry>();
  private readonly events: TransportLikeEvents;
  private readonly options: HttpTransportOptions;

  constructor(options: HttpTransportOptions, events: TransportLikeEvents) {
    this.options = options;
    this.events = events;
  }

  get running(): boolean {
    return !this.terminated;
  }

  get lastStderr(): string {
    return "";
  }

  async start(): Promise<void> {
    const probe = await this.postRaw({
      jsonrpc: "2.0",
      id: "axiom_probe",
      method: "ping",
      params: {}
    }, true);

    if (!probe.ok && probe.status !== 405 && probe.status !== 404 && probe.status >= 400) {
      throw new Error(`MCP endpoint probe failed with HTTP ${probe.status}`);
    }
    log.debug(`endpoint reachable (${probe.status})`);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.terminated) throw new Error("HTTP transport closed");
    if (!("id" in message)) {
      await this.postNotification(message);
      return;
    }

    const response = await this.postRaw(message, false);
    if (!response.ok) {
      const detail = `HTTP ${response.status} from MCP endpoint`;
      rejectPending(this.pending, ("id" in message ? message.id : null), new Error(detail));
      throw new Error(detail);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = await response.text();

    if (contentType.includes("text/event-stream")) {
      let sawResponse = false;
      for (const block of bodyText.split("\n\n")) {
        const event = parseRawSseBlock(block);
        if (!event || event.data.length === 0) continue;
        try {
          const parsed = JSON.parse(event.data) as JsonRpcMessage;
          if ("id" in parsed && String(parsed.id) === String((message as { id?: unknown }).id ?? "")) {
            sawResponse = true;
            deliverToPending(this.pending, parsed, this.events);
          } else {
            this.events.onMessage(parsed);
          }
        } catch {
          log.warn("unparseable SSE payload from MCP server");
        }
      }
      if (!sawResponse) {
        rejectPending(this.pending, (message as { id?: unknown }).id as JsonRpcId, new Error("stream ended without response"));
      }
      return;
    }

    if (bodyText.trim().length === 0) {
      rejectPending(this.pending, (message as { id?: unknown }).id as JsonRpcId, new Error("empty response body"));
      return;
    }

    try {
      const parsed = JSON.parse(bodyText) as JsonRpcMessage;
      deliverToPending(this.pending, parsed, this.events);
    } catch {
      rejectPending(this.pending, (message as { id?: unknown }).id as JsonRpcId, new Error("malformed JSON response"));
    }
  }

  private async postNotification(message: JsonRpcMessage): Promise<void> {
    const response = await this.postRaw(message, false);
    if (!response.ok && response.status !== 202) {
      log.warn(`notification POST failed with ${response.status}`);
    } else {
      void response.text().catch(() => "");
    }
  }

  private async postRaw(message: JsonRpcMessage, captureSession: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.options.headers ?? {})
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    return fetchWithTimeout(this.options.url, {
      method: "POST",
      headers,
      body: serializeMessage(message),
      timeoutMs: Math.max(this.options.requestTimeoutMs, 8000),
      signal: undefined
    }).then((response) => {
      const sessionHeader = response.headers.get("mcp-session-id");
      if (captureSession && sessionHeader) this.sessionId = sessionHeader;
      return response;
    });
  }

  async stop(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    for (const [, entry] of [...this.pending.entries()]) {
      clearTimeout(entry.timer);
      entry.reject(new Error("transport stopped"));
    }
    this.pending.clear();
  }
}

type TransportLikeEvents = HttpTransportEvents;

function deliverToPending(
  pending: Map<JsonRpcId, PendingEntry>,
  message: JsonRpcMessage,
  events: TransportLikeEvents
): void {
  const id = "id" in message ? (message.id as JsonRpcId) : undefined;
  if (id === undefined) {
    events.onMessage(message);
    return;
  }

  const key = normalizeKey(id);
  const entry = findPending(pending, key);
  if (entry) {
    clearTimeout(entry.timer);
    entry.resolve(message);
  } else {
    events.onMessage(message);
  }
}

function rejectPending(pending: Map<JsonRpcId, PendingEntry>, id: JsonRpcId | null, error: Error): void {
  if (id === null) return;
  const key = normalizeKey(id);
  const found = findPending(pending, key);
  if (found) {
    clearTimeout(found.timer);
    found.reject(error);
  }
}

function findPending(pending: Map<JsonRpcId, PendingEntry>, key: string): PendingEntry | undefined {
  for (const [candidateId, entry] of pending.entries()) {
    if (normalizeKey(candidateId) === key) {
      pending.delete(candidateId);
      return entry;
    }
  }
  return undefined;
}

function normalizeKey(id: JsonRpcId): string {
  return typeof id === "string" ? id : `#${id}`;
}
