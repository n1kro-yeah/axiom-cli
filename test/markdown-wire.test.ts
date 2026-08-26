import { describe, expect, it } from "vitest";
import { renderMarkdown, parseInlineSegments, stripMarkdown, countRenderedLines } from "../src/ui/markdown.js";
import {
  toAnthropicMessages,
  toOpenAiMessages,
  buildAnthropicSystem,
  estimateTokensFromText
} from "../src/providers/wire.js";
import {
  decodeJsonLines,
  encodeLfrpcFrame,
  decodeLfrpcFrame,
  createRequest
} from "../src/mcp/jsonrpc.js";

describe("renderMarkdown", () => {
  it("renders headings with styles", () => {
    const rendered = renderMarkdown("# Title\n\n## Section");
    expect(rendered.lines[0][0].style).toBe("heading1");
    expect(rendered.lines[0][0].text).toBe("Title");
    const h2 = rendered.lines.flatMap((line) => line).find((segment) => segment.style === "heading2");
    expect(h2?.text).toBe("Section");
  });

  it("wraps fenced code blocks with language markers", () => {
    const rendered = renderMarkdown("```ts\nconst x: number = 1;\n```");
    expect(rendered.codeBlocks).toBe(1);
    expect(rendered.lines[0][0].text).toContain("[ts]");
    expect(rendered.lines[1][0].style).toBe("code");
    expect(rendered.lines[2][0].text).toContain("------");
  });

  it("converts lists into bullet lines", () => {
    const rendered = renderMarkdown("- first\n- second\n1. third");
    const bullets = rendered.lines.filter((line) => line[0]?.style === "listMarker");
    expect(bullets.length).toBe(3);
    expect(bullets[0][1]?.text).toContain("first");
    expect(bullets[2][0]?.text).toContain("1.");
  });

  it("renders blockquotes with a marker", () => {
    const rendered = renderMarkdown("> quoted wisdom");
    expect(rendered.lines[0][0].text).toBe("> ");
    expect(rendered.lines[0][1]?.text).toContain("quoted");
  });

  it("renders tables as bordered rows and skips separators", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const rendered = renderMarkdown(table);
    expect(rendered.lines).toHaveLength(2);
    expect(rendered.lines[0].map((segment) => segment.text).join("")).toContain("| a | b |");
  });

  it("turns hr rules into dashes", () => {
    const rendered = renderMarkdown("---\n");
    expect(rendered.lines[0][0].style).toBe("hr");
  });
});

describe("parseInlineSegments", () => {
  it("detects bold, italic and code spans", () => {
    const segments = parseInlineSegments("plain **bold** *ital* `code` end");
    const styles = segments.map((segment) => segment.style);
    expect(styles).toContain("bold");
    expect(styles).toContain("italic");
    expect(styles).toContain("code");
  });

  it("extracts link labels", () => {
    const segments = parseInlineSegments("see [docs](https://example.com) now");
    expect(segments.some((segment) => segment.style === "link" && segment.text === "docs")).toBe(true);
  });

  it("returns plain text when no markers exist", () => {
    const segments = parseInlineSegments("nothing special");
    expect(segments).toEqual([{ text: "nothing special", style: "plain" }]);
  });
});

describe("stripMarkdown and countRenderedLines", () => {
  it("produces clean text without markup", () => {
    const stripped = stripMarkdown("**hi** `there`\n- item");
    expect(stripped).not.toContain("**");
    expect(stripped).not.toContain("`");
    expect(stripped).toContain("item");
  });

  it("counts rendered lines", () => {
    expect(countRenderedLines("a\n\nb")).toBe(3);
  });
});

describe("toAnthropicMessages", () => {
  it("maps assistant tool calls into tool_use blocks", () => {
    const messages = [
      { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "run it" }], timestamp: 1 },
      {
        id: "a1",
        role: "assistant" as const,
        parts: [
          { type: "thinking" as const, thinking: "hmm", signature: "sig" },
          { type: "tool_call" as const, id: "c1", name: "bash", input: { command: "ls" }, rawArgs: "{}" }
        ],
        timestamp: 2,
        stopReason: "tool_use" as const
      },
      {
        id: "u2",
        role: "user" as const,
        parts: [{ type: "tool_result" as const, toolCallId: "c1", name: "bash", content: "out", isError: false }],
        timestamp: 3
      }
    ];

    const wire = toAnthropicMessages(messages as never);
    expect(wire).toHaveLength(3);
    expect(wire[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "hmm", signature: "sig" }),
        expect.objectContaining({ type: "tool_use", id: "c1", name: "bash" })
      ])
    );
    expect((wire[2].content as Array<{ type: string }>)[0].type).toBe("tool_result");
  });

  it("merges consecutive user turns", () => {
    const wire = toAnthropicMessages([
      { id: "1", role: "user", parts: [{ type: "text", text: "one" }], timestamp: 1 },
      { id: "2", role: "user", parts: [{ type: "tool_result", toolCallId: "c", name: "t", content: "", isError: false }], timestamp: 2 }
    ] as never);
    expect(wire.filter((message) => message.role === "user")).toHaveLength(1);
  });
});

describe("buildAnthropicSystem cache_control", () => {
  it("marks only the final cached block as ephemeral", () => {
    const blocks = buildAnthropicSystem(
      [
        { text: "identity", cache: true },
        { text: "rules", cache: true },
        { text: "env", cache: false }
      ],
      true
    );
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[2].cache_control).toBeUndefined();
  });

  it("omits cache control entirely when disabled", () => {
    const blocks = buildAnthropicSystem([{ text: "x", cache: true }], false);
    expect(blocks[0].cache_control).toBeUndefined();
  });
});

describe("toOpenAiMessages", () => {
  it("splits tool results into role:tool messages", () => {
    const wire = toOpenAiMessages("sys prompt", [
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool_call", id: "call_9", name: "grep", input: {}, rawArgs: "" }],
        timestamp: 1
      },
      {
        id: "b",
        role: "user",
        parts: [{ type: "tool_result", toolCallId: "call_9", name: "grep", content: "found", isError: false }],
        timestamp: 2
      }
    ] as never);

    expect(wire[0]).toMatchObject({ role: "system", content: "sys prompt" });
    expect(wire[1].tool_calls?.[0]).toMatchObject({ id: "call_9", function: { name: "grep" } });
    expect(wire[2]).toMatchObject({ role: "tool", tool_call_id: "call_9" });
  });

  it("serializes images as data urls for vision models", () => {
    const wire = toOpenAiMessages("", [
      {
        id: "u",
        role: "user",
        parts: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: "QUJD" }
        ],
        timestamp: 1
      }
    ] as never);

    const content = wire[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[1]?.image_url?.url).toBe("data:image/png;base64,QUJD");
  });
});

describe("estimateTokensFromText", () => {
  it("estimates ascii at roughly 4 chars per token", () => {
    expect(estimateTokensFromText("abcd".repeat(100))).toBe(100);
  });

  it("charges non-ascii more heavily", () => {
    expect(estimateTokensFromText("привет")).toBeGreaterThan(estimateTokensFromText("privet"));
  });
});

describe("JSON-RPC framing helpers", () => {
  it("decodes newline-delimited batches", () => {
    const request = JSON.stringify(createRequest("tools/list"));
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "ping" });
    const decoded = decodeJsonLines(`${request}\n${notification}\n{"broken":`);
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.rest.trim()).toBe('{"broken":');
  });

  it("frames LSP-style Content-Length payloads", () => {
    const frame = encodeLfrpcFrame(createRequest("initialize", {}));
    const decoded = decodeLfrpcFrame(frame + frame);
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.rest).toBe("");
  });

  it("keeps partial frames in the rest buffer", () => {
    const full = encodeLfrpcFrame({ jsonrpc: "2.0", id: 7, method: "x", params: {} });
    const half = Math.floor(full.length / 2);
    const decoded = decodeLfrpcFrame(full.slice(0, half));
    expect(decoded.messages).toHaveLength(0);
  });
});
