import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { resolveWithinRoot } from "./common.js";
import { SEVERITY_LABELS } from "../lsp/client.js";
import { inferLanguageId } from "../lsp/client.js";

export interface DiagnosticsBackend {
  ensureForLanguage(languageId: string): Promise<unknown>;
  notifyOpen(filePath: string, text: string): Promise<void>;
  getDiagnosticsFor(uriOrPath: string): Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
    source?: string;
    message: string;
  }>;
  allDiagnostics(): Array<{ uri: string; items: Array<{ severity?: number; message: string; range: { start: { line: number } } }> }>;
  statusLines(): string[];
}

export function createDiagnosticsTool(backend: () => DiagnosticsBackend | undefined): ToolDefinition {
  return {
    name: "lsp_diagnostics",
    label: "Diagnostics",
    description:
      "Get language-server diagnostics (compiler errors, type errors, warnings) for a file. Opens the document if needed and waits briefly for analysis. Use after edits to verify changes compile. Pass no path to list diagnostics across the project.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File to check; omit for project-wide summary"
        },
        wait_ms: {
          type: "number",
          description: "How long to wait for diagnostics to arrive (default 2000)"
        }
      },
      required: []
    },
    readOnly: true,

    needsPermission(): { required: boolean; risk: "low" } {
      return { required: false, risk: "low" };
    },

    async execute(
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolInvocationResult> {
      const provider = backend();
      if (!provider) {
        return {
          content: "LSP is unavailable in this session (no language servers detected or disabled).",
          isError: false
        };
      }

      const rawPath = typeof input["file_path"] === "string" ? input["file_path"].trim() : "";

      if (rawPath.length === 0) {
        const snapshots = provider.allDiagnostics();
        if (snapshots.length === 0) {
          return {
            content: `No diagnostics collected yet. Open a file with read or pass file_path.\n${provider.statusLines().join("\n")}`,
            isError: false
          };
        }
        const lines = snapshots.slice(0, 30).map((snapshot) => {
          const shortUri = snapshot.uri.split("/").pop() ?? snapshot.uri;
          const errors = snapshot.items.filter((item) => item.severity === 1).length;
          const warnings = snapshot.items.filter((item) => item.severity === 2).length;
          return `${shortUri}: ${errors} error(s), ${warnings} warning(s)`;
        });
        return { content: lines.join("\n"), isError: false };
      }

      const resolved = resolveWithinRoot(context.cwd, rawPath);
      const languageId = inferLanguageId(resolved.absolute);

      if (languageId === "plaintext") {
        return { content: `${resolved.relative}: unknown language; no LSP available`, isError: false };
      }

      await provider.ensureForLanguage(languageId);

      let text = "";
      try {
        text = await readFile(resolved.absolute, "utf8");
      } catch {
        throw new AxiomError(`Cannot read ${resolved.relative}`);
      }

      await provider.notifyOpen(resolved.absolute, text);

      const waitMs = typeof input["wait_ms"] === "number" ? Math.min(Math.max(input["wait_ms"], 300), 8000) : 2000;
      await sleep(waitMs);

      const diagnostics = provider.getDiagnosticsFor(resolved.relative);
      if (diagnostics.length === 0) {
        return {
          content: `${resolved.relative}: clean — no diagnostics`,
          isError: false,
          metadata: { count: 0 }
        };
      }

      const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 9) - (b.severity ?? 9));
      const lines = sorted.slice(0, 40).map((item) => {
        const line1Based = item.range.start.line + 1;
        const label = SEVERITY_LABELS[item.severity ?? 3] ?? "info";
        const source = item.source ? `[${item.source}] ` : "";
        return `L${line1Based} ${label}: ${source}${item.message.replace(/\s+/g, " ").slice(0, 240)}`;
      });

      const errorCount = sorted.filter((item) => item.severity === 1).length;

      return {
        content: `${resolved.relative}: ${diagnostics.length} diagnostic(s)\n${lines.join("\n")}`,
        isError: false,
        metadata: {
          count: diagnostics.length,
          errors: errorCount,
          warnings: sorted.filter((item) => item.severity === 2).length
        }
      };
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDiagnosticsSummary(
  filePath: string,
  items: Array<{ severity?: number; message: string }>
): string {
  if (items.length === 0) return `${filePath}: clean`;
  const errors = items.filter((item) => item.severity === 1);
  const head = errors.length > 0 ? `${errors[0]?.message.slice(0, 120)}` : items[0]?.message.slice(0, 120) ?? "";
  void join;
  return `${filePath}: ${items.length} diagnostic(s); first: ${head}`;
}
