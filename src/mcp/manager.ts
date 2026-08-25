import type { ToolDefinition, ToolInvocationResult, ToolContext, ProviderToolSpec } from "../types.js";
import { createLogger } from "../util/log.js";
import { AxiomError } from "../util/errors.js";
import type { JsonRpcId, JsonRpcMessage, JsonRpcResponse } from "./jsonrpc.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createNotification,
  createRequest,
  isResponse,
  RpcError
} from "./jsonrpc.js";
import { StdioTransport } from "./stdio.js";
import { HttpTransport } from "./http.js";

const log = createLogger("mcp");

export interface McpServerDescriptor {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpToolInfo {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ServerState {
  descriptor: McpServerDescriptor;
  transport: StdioTransport | HttpTransport | null;
  protocolVersion: string | null;
  tools: McpToolInfo[];
  connected: boolean;
  lastError?: string;
  connecting?: Promise<void>;
}

export function qualifiedToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function parseQualifiedToolName(qualified: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_]+(?:__[^_]+)*?)__(.+)$/.exec(qualified);
  if (!match) return undefined;
  const raw = qualified.slice("mcp__".length);
  const separator = raw.indexOf("__");
  if (separator === -1) return undefined;
  return { server: raw.slice(0, separator), tool: raw.slice(separator + 2) };
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly pendingResponses = new Map<JsonRpcId, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  register(descriptor: McpServerDescriptor): void {
    this.servers.set(descriptor.name, {
      descriptor,
      transport: null,
      protocolVersion: null,
      tools: [],
      connected: false
    });
  }

  remove(name: string): void {
    const state = this.servers.get(name);
    if (!state) return;
    void state.transport?.stop().catch(() => undefined);
    this.servers.delete(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    const state = this.servers.get(name);
    if (!state) return;
    if (!enabled && state.connected) {
      void this.disconnect(name);
    }
    (state.descriptor as { enabled?: boolean }).enabled = enabled;
  }

  isEnabled(name: string): boolean {
    const enabled = (this.servers.get(name)?.descriptor as { enabled?: boolean }).enabled;
    return enabled !== false;
  }

  names(): string[] {
    return [...this.servers.keys()];
  }

  status(): Array<{ name: string; type: string; connected: boolean; tools: number; error?: string }> {
    return [...this.servers.values()].map((state) => ({
      name: state.descriptor.name,
      type: state.descriptor.type,
      connected: state.connected,
      tools: state.tools.length,
      error: state.lastError
    }));
  }

  connectedToolCount(): number {
    let total = 0;
    for (const state of this.servers.values()) total += state.tools.length;
    return total;
  }

  async connect(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`unknown MCP server "${name}"`);
    if ((state.descriptor as { enabled?: boolean }).enabled === false) {
      throw new Error(`MCP server "${name}" is disabled`);
    }
    if (state.connected) return;
    if (state.connecting) return state.connecting;

    state.connecting = this.performConnect(state)
      .then(() => {
        state.connected = true;
        state.lastError = undefined;
        log.info(`connected ${name}: ${state.tools.length} tools`);
      })
      .catch((error) => {
        state.connected = false;
        state.lastError = error instanceof Error ? error.message : String(error);
        log.warn(`connect failed for ${name}: ${state.lastError}`);
        throw error;
      })
      .finally(() => {
        state.connecting = undefined;
      });

    return state.connecting;
  }

  async disconnect(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state?.transport) return;
    await state.transport.stop().catch(() => undefined);
    state.transport = null;
    state.connected = false;
    state.tools = [];
  }

  async connectAll(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const [name] of this.servers) {
      try {
        await this.connect(name);
        results.push({ name, ok: true });
      } catch (error) {
        results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  async shutdown(): Promise<void> {
    for (const [name] of this.servers) {
      await this.disconnect(name).catch(() => undefined);
    }
  }

  private async performConnect(state: ServerState): Promise<void> {
    const timeoutMs = state.descriptor.timeoutMs ?? 15000;

    const transport = await this.createTransport(state, timeoutMs);
    state.transport = transport;

    const initResult = await this.request(state, "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "axiom", version: "0.1.0" }
    }, timeoutMs);

    const negotiated = extractProtocolVersion(initResult.result);
    if (negotiated && !SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
      log.debug(`server negotiated unknown protocol ${negotiated}, continuing`);
    }
    state.protocolVersion = negotiated ?? LATEST_PROTOCOL_VERSION;

    transport.send(createNotification("notifications/initialized"));

    const toolsResult = await this.request(state, "tools/list", {}, timeoutMs);
    state.tools = extractTools(toolsResult.result, state.descriptor.name);
  }

  private async createTransport(state: ServerState, timeoutMs: number): Promise<StdioTransport | HttpTransport> {
    const events = {
      onMessage: (message: JsonRpcMessage) => {
        if (isResponse(message)) {
          const key = normalizeKey(message.id);
          for (const [candidateId, entry] of [...this.pendingResponses.entries()]) {
            if (normalizeKey(candidateId) === key) {
              clearTimeout(entry.timer);
              this.pendingResponses.delete(candidateId);
              if (message.error) {
                entry.reject(new RpcError(message.error.code, message.error.message, message.error.data));
              } else {
                entry.resolve(message);
              }
              return;
            }
          }
        }
      },
      onClose: (_code: number | null, reason: string) => {
        state.connected = false;
        state.tools = [];
        if (reason.length > 0) state.lastError = reason.slice(-400);
      },
      onError: (error: string) => {
        state.lastError = error;
      }
    };

    if (state.descriptor.type === "http") {
      const http = new HttpTransport({
        url: state.descriptor.url ?? "",
        headers: state.descriptor.headers,
        requestTimeoutMs: timeoutMs
      }, events);
      await http.start();
      return http;
    }

    const stdio = new StdioTransport({
      command: state.descriptor.command ?? "",
      args: state.descriptor.args ?? [],
      env: state.descriptor.env,
      startupTimeoutMs: timeoutMs
    }, events);
    await stdio.start();
    return stdio;
  }

  private request(
    state: ServerState,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<JsonRpcResponse> {
    if (!state.transport) throw new Error(`transport for "${state.descriptor.name}" is not running`);

    const requestMessage = createRequest(method, params);

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(requestMessage.id);
        reject(new RpcError(-32001, `${method} timed out after ${timeoutMs}ms`));
      }, Math.max(timeoutMs, 2000));

      this.pendingResponses.set(requestMessage.id, { resolve, reject, timer });

      try {
        state.transport?.send(requestMessage);
      } catch (error) {
        clearTimeout(timer);
        this.pendingResponses.delete(requestMessage.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const state = this.servers.get(serverName);
    if (!state) throw AxiomError.mcp(serverName, "not configured");
    if (!state.connected) await this.connect(serverName);

    const response = await this.request(state, "tools/call", {
      name: toolName,
      arguments: args
    }, timeoutMs);

    return response.result;
  }

  buildExternalSource(): {
    id: string;
    listTools: () => ProviderToolSpec[];
    resolve: (name: string) => ToolDefinition | undefined;
  } {
    const manager = this;

    return {
      id: "mcp",
      listTools(): ProviderToolSpec[] {
        const specs: ProviderToolSpec[] = [];
        for (const state of manager.servers.values()) {
          if (!(state.descriptor as { enabled?: boolean }).enabled) continue;
          if (!state.connected) continue;
          for (const tool of state.tools) {
            specs.push({
              name: qualifiedToolName(state.descriptor.name, tool.name),
              description: `[mcp:${state.descriptor.name}] ${tool.description}`.slice(0, 900),
              parameters: tool.inputSchema
            });
          }
        }
        return specs;
      },

      resolve(name: string): ToolDefinition | undefined {
        const parsed = parseQualifiedToolName(name);
        if (!parsed || !manager.servers.has(parsed.server)) return undefined;
        const state = manager.servers.get(parsed.server);
        if (!state?.tools.some((tool) => tool.name === parsed.tool)) return undefined;

        return {
          name,
          label: `MCP ${parsed.server}/${parsed.tool}`,
          description: state.tools.find((tool) => tool.name === parsed.tool)?.description ?? "",
          parameters: normalizeSchema(state.tools.find((tool) => tool.name === parsed.tool)?.inputSchema),
          readOnly: false,
          needsPermission(input, mode) {
            if (mode === "bypass") return { required: false, risk: "low" };
            return {
              required: true,
              risk: "medium",
              pattern: `${name}`,
              title: `MCP tool ${parsed.server}/${parsed.tool}`,
              summary: [JSON.stringify(input).slice(0, 300)]
            };
          },
          async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolInvocationResult> {
            try {
              const timeoutMs = state.descriptor.timeoutMs ?? 60000;
              const result = await manager.callTool(parsed.server, parsed.tool, input, timeoutMs);
              const text = renderMcpToolResult(result);
              context.reportProgress(context.sessionId, `[${parsed.server}/${parsed.tool}] completed`);
              return {
                content: text,
                isError: false,
                metadata: { mcpServer: parsed.server, mcpTool: parsed.tool }
              };
            } catch (error) {
              return {
                content: `MCP call failed: ${error instanceof Error ? error.message : String(error)}`,
                isError: true
              };
            }
          }
        };
      }
    };
  }

  async refreshTools(name: string): Promise<number> {
    const state = this.servers.get(name);
    if (!state?.connected || !state.transport) throw AxiomError.mcp(name, "not connected");
    const result = await this.request(state, "tools/list", {}, state.descriptor.timeoutMs ?? 15000);
    state.tools = extractTools(result.result, name);
    return state.tools.length;
  }
}

function normalizeKey(id: JsonRpcId): string {
  return typeof id === "string" ? id : `#${id}`;
}

function normalizeSchema(schema: Record<string, unknown> | undefined): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const base: { type: "object"; properties: Record<string, unknown>; required?: string[] } = {
    type: "object",
    properties:
      schema["properties"] !== null && typeof schema["properties"] === "object"
        ? (schema["properties"] as Record<string, unknown>)
        : {}
  };
  if (Array.isArray(schema["required"])) {
    base.required = schema["required"].map((entry) => String(entry));
  }
  return base;
}

function extractProtocolVersion(result: unknown): string | null {
  if (result !== null && typeof result === "object" && "protocolVersion" in result) {
    const version = (result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof version === "string") return version;
  }
  return null;
}

interface RawToolDescription {
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function extractTools(result: unknown, serverName: string): McpToolInfo[] {
  if (result === null || typeof result !== "object") return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];

  const extracted: McpToolInfo[] = [];
  for (const entry of tools) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as RawToolDescription;
    if (typeof candidate.name !== "string" || candidate.name.length === 0) continue;
    extracted.push({
      serverName,
      name: candidate.name,
      description: typeof candidate.description === "string" ? candidate.description : "",
      inputSchema: candidate.inputSchema ?? { type: "object", properties: {} }
    });
  }
  return extracted;
}

export function renderMcpToolResult(result: unknown): string {
  if (result === null || result === undefined) return "(empty result)";

  if (typeof result === "string") return result;

  if (typeof result !== "object") return String(result);

  const record = result as Record<string, unknown>;

  if (Array.isArray(record["content"])) {
    const blocks: string[] = [];
    for (const block of record["content"]) {
      if (block === null || typeof block !== "object") continue;
      const entry = block as Record<string, unknown>;
      if (entry["type"] === "text" && typeof entry["text"] === "string") {
        blocks.push(entry["text"]);
      } else if (entry["type"] === "resource" && entry["resource"] !== null && typeof entry["resource"] === "object") {
        const resource = entry["resource"] as Record<string, unknown>;
        blocks.push(`[resource ${(resource["uri"] ?? "").toString()}]\n${String(resource["text"] ?? "")}`);
      } else {
        blocks.push(JSON.stringify(block));
      }
    }
    if (record["isError"] === true) {
      return `ERROR: ${blocks.join("\n\n")}`;
    }
    return blocks.join("\n\n").slice(0, 50000) || "(empty content)";
  }

  try {
    return JSON.stringify(record, null, 2).slice(0, 30000);
  } catch {
    return String(record);
  }
}
