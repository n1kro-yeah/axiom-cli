import type { ProviderToolSpec, PermissionMode, ToolDefinition } from "../types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { patchTool } from "./patch.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { bashTool } from "./bash.js";
import { fetchTool } from "./fetch.js";
import { todoWriteTool } from "./todo.js";
import { taskTool } from "./task.js";

export interface ExternalToolSource {
  readonly id: string;
  listTools(): ProviderToolSpec[];
  resolve(name: string): ToolDefinition | undefined;
}

export class ToolRegistry {
  private readonly builtins = new Map<string, ToolDefinition>();
  private readonly sources: ExternalToolSource[] = [];
  private disabledTools = new Set<string>();

  constructor() {
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    for (const tool of [
      readTool,
      writeTool,
      editTool,
      patchTool,
      globTool,
      grepTool,
      lsTool,
      bashTool,
      fetchTool,
      todoWriteTool,
      taskTool
    ]) {
      this.builtins.set(tool.name, tool);
    }
  }

  addSource(source: ExternalToolSource): void {
    this.sources.push(source);
  }

  registerTool(tool: ToolDefinition): void {
    if (!this.builtins.has(tool.name)) {
      this.builtins.set(tool.name, tool);
    }
  }

  removeSource(sourceId: string): void {
    const index = this.sources.findIndex((source) => source.id === sourceId);
    if (index !== -1) this.sources.splice(index, 1);
  }

  setDisabled(names: string[]): void {
    this.disabledTools = new Set(names);
  }

  resolve(name: string): ToolDefinition | undefined {
    if (this.disabledTools.has(name)) return undefined;
    const builtin = this.builtins.get(name);
    if (builtin) return builtin;
    for (const source of this.sources) {
      const resolved = source.resolve(name);
      if (resolved) return resolved;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  builtinNames(): string[] {
    return [...this.builtins.keys()];
  }

  visibleNames(includeHidden: boolean): string[] {
    const names: string[] = [];
    for (const [name, tool] of this.builtins) {
      if (!includeHidden && tool.hiddenFromModel) continue;
      if (this.disabledTools.has(name)) continue;
      names.push(name);
    }
    for (const source of this.sources) {
      for (const spec of source.listTools()) names.push(spec.name);
    }
    return [...new Set(names)];
  }

  specsForModel(options: { supportsTools: boolean; mode: PermissionMode }): ProviderToolSpec[] {
    if (!options.supportsTools) return [];

    const specs: ProviderToolSpec[] = [];
    for (const [, tool] of this.builtins) {
      if (tool.hiddenFromModel) continue;
      if (this.disabledTools.has(tool.name)) continue;
      specs.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>
      });
    }

    for (const source of this.sources) {
      for (const spec of source.listTools()) {
        if (specs.some((existing) => existing.name === spec.name)) continue;
        specs.push(spec);
      }
    }

    return specs;
  }

  describeForPrompt(): string {
    const lines: string[] = ["# Tools"];
    for (const [name, tool] of this.builtins) {
      const flags: string[] = [];
      if (tool.readOnly) flags.push("read-only");
      lines.push(`- ${name}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}: ${firstSentence(tool.description)}`);
    }
    for (const source of this.sources) {
      for (const spec of source.listTools()) {
        lines.push(`- ${spec.name} (external): ${firstSentence(spec.description)}`);
      }
    }
    return lines.join("\n");
  }
}

function firstSentence(text: string): string {
  const sentenceEnd = text.search(/[.!?](\s|$)/);
  if (sentenceEnd === -1) return text.slice(0, 120);
  return text.slice(0, sentenceEnd + 1);
}

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry();
}
