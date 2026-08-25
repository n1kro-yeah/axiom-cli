export const LATEST_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverErrorRangeStart: -32000,
  serverErrorRangeEnd: -32099
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

let idCounter = 0;

export function nextRequestId(): number {
  idCounter += 1;
  return idCounter;
}

export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  const request: JsonRpcRequest = { jsonrpc: "2.0", id: nextRequestId(), method };
  if (params !== undefined) request.params = params;
  return request;
}

export function createNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
  if (params !== undefined) notification.params = params;
  return notification;
}

export function createErrorResponses(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data }
  };
  return response;
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && !("result" in message) && !("error" in message) && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message) && ("result" in message || "error" in message);
}

export function serializeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

export interface DecodedLineResult {
  messages: JsonRpcMessage[];
  rest: string;
}

export function decodeJsonLines(buffer: string): DecodedLineResult {
  const messages: JsonRpcMessage[] = [];
  let workingBuffer = buffer;
  let boundaryIndex = workingBuffer.indexOf("\n");

  while (boundaryIndex !== -1) {
    const line = workingBuffer.slice(0, boundaryIndex).trim();
    workingBuffer = workingBuffer.slice(boundaryIndex + 1);

    if (line.length > 0 && !line.startsWith("#")) {
      try {
        const parsed = JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[];
        if (Array.isArray(parsed)) {
          for (const entry of parsed) messages.push(entry);
        } else if (parsed && typeof parsed === "object") {
          messages.push(parsed);
        }
      } catch {
      }
    }

    boundaryIndex = workingBuffer.indexOf("\n");
  }

  return { messages, rest: workingBuffer };
}

export function decodeLfrpcFrame(buffer: string): { messages: JsonRpcMessage[]; rest: string } {
  const messages: JsonRpcMessage[] = [];
  let working = buffer;

  for (;;) {
    const headerEnd = working.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const headerSection = working.slice(0, headerEnd);
    const contentLengthMatch = /content-length\s*:\s*(\d+)/i.exec(headerSection);
    if (!contentLengthMatch) {
      working = working.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (working.length < bodyStart + contentLength) break;

    const body = working.slice(bodyStart, bodyStart + contentLength);
    working = working.slice(bodyStart + contentLength);

    try {
      const parsed = JSON.parse(body) as JsonRpcMessage;
      messages.push(parsed);
    } catch {
    }
  }

  return { messages, rest: working };
}

export function encodeLfrpcFrame(message: JsonRpcMessage): string {
  const body = serializeMessage(message);
  const byteLength = Buffer.byteLength(body, "utf8");
  return `Content-Length: ${byteLength}\r\n\r\n${body}`;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}
