import { describe, expect, it } from "vitest";
import { TranscriptComponent } from "../src/ui/pi/transcript-component.js";
import { StatusComponent } from "../src/ui/pi/status-component.js";
import { LogoComponent } from "../src/ui/pi/logo-component.js";
import { makeAnsiTheme } from "../src/ui/pi/ansi.js";
import { applyAgentEvents, bubblesFromMessages } from "../src/ui/transcript.js";
import type { AgentEvent } from "../src/types.js";
import { createMessageId } from "../src/types.js";
import { Editor, VStack, type TUI } from "@earendil-works/pi-tui";

const ansi = makeAnsiTheme("violet");
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function renderLines(component: { render(width: number): string[] }): string[] {
  return component.render(100).map(strip);
}

describe("pi transcript component", () => {
  it("renders user, assistant and tool bubbles as visible text", () => {
    const component = new TranscriptComponent(ansi);
    const events: AgentEvent[] = [
      {
        type: "user_message_added",
        message: { id: createMessageId(), role: "user", parts: [{ type: "text", text: "fix the bug" }], timestamp: 1 }
      },
      { type: "assistant_started", messageId: "a1" },
      { type: "text_delta", messageId: "a1", delta: "Working on it" },
      { type: "tool_started", callId: "c1", name: "bash", input: { command: "npm test" } },
      { type: "tool_finished", callId: "c1", result: { content: "ok", isError: false } },
      { type: "text_delta", messageId: "a1", delta: " done" }
    ];

    component.setBubbles(applyAgentEvents([], events));
    const lines = renderLines(component).join("\n");

    expect(lines).toContain("fix the bug");
    expect(lines).toContain("Working on it done");
    expect(lines).toContain("npm test");
  });

  it("marks failed tools with x and denied with !", () => {
    const component = new TranscriptComponent(ansi);
    const events: AgentEvent[] = [
      { type: "tool_started", callId: "c1", name: "bash", input: { command: "boom" } },
      { type: "tool_finished", callId: "c1", result: { content: "user denied permission", isError: true } },
      { type: "tool_started", callId: "c2", name: "read", input: { file_path: "x.ts" } },
      { type: "tool_finished", callId: "c2", result: { content: "File not found", isError: true } }
    ];

    component.setBubbles(applyAgentEvents([], events));
    const lines = renderLines(component).join("\n");

    expect(lines).toContain("! bash");
    expect(lines).toContain("x read");
  });

  it("renders diff rows for edit metadata", () => {
    const component = new TranscriptComponent(ansi);
    const events: AgentEvent[] = [
      { type: "tool_started", callId: "c1", name: "edit", input: { file_path: "a.ts" } },
      {
        type: "tool_finished",
        callId: "c1",
        result: {
          content: "Edited a.ts",
          isError: false,
          metadata: {
            additions: 1,
            deletions: 1,
            diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new"
          }
        }
      }
    ];

    component.setBubbles(applyAgentEvents([], events));
    const lines = renderLines(component).join("\n");

    expect(lines).toContain("+1");
    expect(lines).toContain("-1");
    expect(lines).toContain("+ new");
    expect(lines).toContain("- old");
  });

  it("restores bubbles from persisted messages", () => {
    const messages = [
      { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "hello" }], timestamp: 1 },
      {
        id: "a1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "hi there" }],
        timestamp: 2,
        stopReason: "end_turn" as const
      }
    ];

    const component = new TranscriptComponent(ansi);
    component.setBubbles(bubblesFromMessages(messages));
    const lines = renderLines(component).join("\n");

    expect(lines).toContain("hello");
    expect(lines).toContain("hi there");
  });
});

describe("pi status component", () => {
  it("renders model, context meter and usage without exotic glyphs", () => {
    const status = new StatusComponent(ansi);
    status.update({
      modelRef: "anthropic/claude-sonnet-4-5",
      effort: "high",
      thinking: true,
      mode: "normal",
      inputTokens: 84000,
      outputTokens: 1200,
      cacheReadTokens: 0,
      costUsd: 0.012,
      contextWindow: 200000,
      turnMs: 12000,
      sessionMs: 300000,
      bypass: false,
      busy: true,
      mcpConnected: 2,
      queueDepth: 0,
      cwd: "C:\\cli"
    });

    const lines = renderLines(status).join("\n");
    expect(lines).toContain("claude-sonnet-4-5");
    expect(lines).toContain("[#####.......]");
    expect(lines).toContain("84k/200k");
    expect(lines).toContain("working 12s");
    expect(lines).toContain("mcp:2");
    expect(lines).not.toMatch(/[█░▐▌↑↓]/);
  });

  it("shows bypass badge in bypass mode", () => {
    const status = new StatusComponent(ansi);
    status.update({
      modelRef: "m",
      effort: "low",
      thinking: false,
      mode: "bypass",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      contextWindow: 128000,
      turnMs: null,
      sessionMs: 1000,
      bypass: true,
      busy: false,
      mcpConnected: 0,
      queueDepth: 0,
      cwd: "."
    });

    const lines = renderLines(status).join("\n");
    expect(lines).toContain("BYPASS");
    expect(lines).toContain("bypass mode");
  });
});

describe("pi logo component", () => {
  it("renders wordmark, subtitle and workspace path in ascii", () => {
    const logo = new LogoComponent(ansi, "0.1.0", "agentic coding assistant", "C:\\cli", 120);
    const lines = renderLines(logo).join("\n");

    expect(lines).toContain("axiom");
    expect(lines).toContain("v0.1.0");
    expect(lines).toContain("C:\\cli");
    for (const char of lines) {
      expect(char.charCodeAt(0)).toBeLessThan(0x2500);
    }
  });
});

describe("pi editor inside dock layout", () => {
  function makeFakeTui(): TUI {
    return {
      terminal: { rows: 30, columns: 100 },
      mode: "alt"
    } as unknown as TUI;
  }

  it("renders the editor without touching an uninitialized tui", () => {
    const editor = new Editor(makeFakeTui(), {
      borderColor: (text) => text,
      selectList: {
        selectedPrefix: (text) => text,
        selectedText: (text) => text,
        description: (text) => text,
        scrollInfo: (text) => text,
        noMatch: (text) => text
      }
    }, { paddingX: 1 });

    editor.focused = true;
    const lines = editor.render(100);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("renders the dock vstack (pending + status + editor) end to end", () => {
    const editor = new Editor(makeFakeTui(), {
      borderColor: (text) => text,
      selectList: {
        selectedPrefix: (text) => text,
        selectedText: (text) => text,
        description: (text) => text,
        scrollInfo: (text) => text,
        noMatch: (text) => text
      }
    }, { paddingX: 1 });

    const status = new StatusComponent(ansi);
    status.update({
      modelRef: "anthropic/claude-sonnet-4-5",
      effort: "medium",
      thinking: true,
      mode: "normal",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      costUsd: 0,
      contextWindow: 200000,
      turnMs: null,
      sessionMs: 5000,
      bypass: false,
      busy: false,
      mcpConnected: 0,
      queueDepth: 0,
      cwd: "."
    });

    const dock = new VStack([
      { component: status, shrink: 1, minSize: 1 },
      { component: editor, shrink: 1, minSize: 3 }
    ]);

    const lines = dock.render(100);
    expect(lines.length).toBeGreaterThan(3);
    expect(renderLines(dock).join("\n")).toContain("claude-sonnet-4-5");
  });
});
