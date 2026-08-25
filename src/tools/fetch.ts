import type { ToolDefinition, ToolInvocationResult } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";
import { fetchWithTimeout } from "../util/sse.js";

const log = createLogger("fetch");

const MAX_FETCH_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 30000;

interface FetchInput {
  url?: string;
  format?: "markdown" | "text" | "html" | "json";
  timeout_ms?: number;
}

export const fetchTool: ToolDefinition = {
  name: "fetch",
  label: "Fetch",
  description:
    "Fetch a URL over HTTP(S) and return its content as markdown, plain text or raw html. Use for documentation pages, raw files and APIs. Binary content is rejected.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Absolute http(s) URL"
      },
      format: {
        type: "string",
        enum: ["markdown", "text", "html", "json"],
        description: "Desired output format"
      },
      timeout_ms: {
        type: "number",
        description: "Request timeout in milliseconds"
      }
    },
    required: ["url"]
  },
  readOnly: true,

  needsPermission(input): ReturnType<ToolDefinition["needsPermission"]> {
    const url = String(input["url"] ?? "");
    return {
      required: true,
      risk: "low",
      pattern: `fetch:${hostOf(url)}`,
      title: "Network request",
      summary: [url || "(no url)"]
    };
  },

  async execute(input: Record<string, unknown>): Promise<ToolInvocationResult> {
    const typed = input as FetchInput;
    const url = normalizeUrl(typed.url ?? "");
    if (!url) throw new AxiomError("fetch requires a valid absolute http(s) URL");

    const format = typed.format ?? guessFormat(url);
    const timeoutMs = clampTimeout(typed.timeout_ms ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          "user-agent": "Axiom/0.1 (+https://github.com/axiom-cli/axiom)",
          accept: "text/html,application/json,text/plain,*/*"
        },
        timeoutMs
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Fetch failed: ${message}`, isError: true };
    }

    if (!response.ok) {
      return {
        content: `HTTP ${response.status} ${response.statusText} from ${url}`,
        isError: true
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      return {
        content: `Response too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Fetch a more specific resource.`,
        isError: true
      };
    }

    const body = new TextDecoder("utf-8").decode(buffer);

    if (/application\/json/i.test(contentType) || format === "json") {
      return jsonResult(body, url);
    }

    if (/text\/html/i.test(contentType)) {
      if (format === "html") {
        return {
          content: truncate(body, MAX_FETCH_BYTES),
          isError: false,
          metadata: { contentType, bytes: buffer.byteLength }
        };
      }
      const readable = htmlToReadableText(body);
      return {
        content: truncate(readable, 24000),
        isError: false,
        metadata: { contentType, convertedFromHtml: true, bytes: buffer.byteLength }
      };
    }

    return {
      content: truncate(body, 24000),
      isError: false,
      metadata: { contentType, bytes: buffer.byteLength }
    };
  }
};

function normalizeUrl(raw: string): string | undefined {
  let candidate = raw.trim();
  if (candidate.length === 0) return undefined;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(normalizeUrl(url) ?? "").host;
  } catch {
    return "unknown-host";
  }
}

function guessFormat(url: string): "markdown" | "text" | "html" | "json" {
  const lower = url.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return "text";
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(2000, Math.min(Math.floor(value), 120000));
}

function jsonResult(body: string, url: string): ToolInvocationResult {
  try {
    const parsed = JSON.parse(body) as unknown;
    const pretty = JSON.stringify(parsed, null, 2);
    return {
      content: truncate(pretty.length > 24 ? pretty : body, 20000),
      isError: false,
      metadata: { source: url, kind: "json" }
    };
  } catch {
    return { content: truncate(body, 20000), isError: false, metadata: { source: url } };
  }
}

export function htmlToReadableText(html: string): string {
  let working = html;

  working = working.replace(/<!--[\s\S]*?-->/g, "");
  working = working.replace(/<script[\s\S]*?<\/script>/gi, "");
  working = working.replace(/<style[\s\S]*?<\/style>/gi, "");
  working = working.replace(/<(svg|canvas|iframe|noscript)[\s\S]*?<\/\1>/gi, "");

  working = working.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const depth = Number(level);
    return `\n\n${"#".repeat(Math.min(depth, 6))} ${stripTags(inner).trim()}\n`;
  });
  working = working.replace(/<li[^>]*>/gi, "\n- ");
  working = working.replace(/<\/(p|div|section|article|li|tr|blockquote|pre)>/gi, "\n");
  working = working.replace(/<br\s*\/?>/gi, "\n");
  working = working.replace(/<hr\s*\/?>/gi, "\n---\n");
  working = working.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = stripTags(inner).trim();
    if (label.length === 0) return "";
    if (/^https?:\/\//i.test(href)) return `${label} (${href})`;
    return label;
  });

  working = stripTags(working);
  working = decodeEntities(working);
  working = working.replace(/[ \t]+\n/g, "\n");
  working = working.replace(/\n{3,}/g, "\n\n");
  return working.trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™"
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function truncate(text: string, limitChars: number): string {
  const clean = text.trim();
  if (clean.length <= limitChars) return clean;
  return `${clean.slice(0, limitChars)}\n…[truncated ${(clean.length - limitChars)} chars]`;
}
