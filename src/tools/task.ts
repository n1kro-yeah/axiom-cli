import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";

const log = createLogger("task");

interface TaskInput {
  prompt?: string;
  description?: string;
  subagent_type?: string;
  agent?: string;
}

export const DEFAULT_SUBAGENT_PROFILES: Array<{
  name: string;
  description: string;
  readOnlyOnly?: boolean;
}> = [
  {
    name: "general",
    description:
      "General-purpose subagent for multi-step research and implementation tasks with access to all tools"
  },
  {
    name: "explore",
    description:
      "Read-only exploration specialist for fast codebase searches and architecture questions; returns findings without modifying anything",
    readOnlyOnly: true
  },
  {
    name: "reviewer",
    description:
      "Read-only code reviewer that inspects changes or files for bugs, security issues and quality problems",
    readOnlyOnly: true
  }
];

export const taskTool: ToolDefinition = {
  name: "task",
  label: "Task",
  description:
    "Launch a subagent in a separate context window to handle an independent subtask. Give it a detailed self-contained prompt: context, exact goal, constraints, and what to return. Subagent types: general (full tools), explore (read-only), reviewer (read-only). Use it instead of flooding your own context with large searches.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Full self-contained instructions for the subagent"
      },
      description: {
        type: "string",
        description: "One-line summary of the subtask shown to the user"
      },
      subagent_type: {
        type: "string",
        enum: ["general", "explore", "reviewer"],
        description: "Which profile to run"
      }
    },
    required: ["prompt", "description"]
  },
  readOnly: false,

  needsPermission(input): ReturnType<ToolDefinition["needsPermission"]> {
    const agent = String(input["subagent_type"] ?? input["agent"] ?? "general");
    if (agent === "explore" || agent === "reviewer") {
      return { required: false, risk: "low" };
    }
    return {
      required: true,
      risk: "medium",
      pattern: `task:${agent}`,
      title: "Spawn subagent",
      summary: [String(input["description"] ?? "(no description)"), `type: ${agent}`]
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const typed = input as TaskInput;

    const prompt = typed.prompt?.trim();
    const description = typed.description?.trim() || typed.prompt?.slice(0, 80) || "";
    if (!prompt) throw new AxiomError("task requires a prompt");

    const requestedAgent = (typed.subagent_type ?? typed.agent ?? "general").trim();
    const knownProfile = DEFAULT_SUBAGENT_PROFILES.find((profile) => profile.name === requestedAgent);
    if (!knownProfile) {
      return {
        content: `Unknown subagent type "${requestedAgent}". Available types: ${DEFAULT_SUBAGENT_PROFILES.map((profile) => profile.name).join(", ")}.`,
        isError: true
      };
    }

    log.info(`spawning ${knownProfile.name}: ${description.slice(0, 60)}`);
    context.reportProgress(context.sessionId, `[${knownProfile.name}] started: ${description}`);

    try {
      const result = await context.spawnSubagent(prompt, description, knownProfile.name);
      const truncated =
        result.length > 16000 ? `${result.slice(0, 16000)}…[truncated]` : result;
      return {
        content: truncated,
        isError: false,
        metadata: { subagent: knownProfile.name, chars: result.length }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Subagent failed: ${message}`, isError: true };
    }
  }
};

export function buildSubagentPromptGuidance(): string {
  return [
    "When delegating via the task tool:",
    "- Include all necessary context; the subagent cannot see your conversation.",
    "- Specify the exact deliverable format you expect back.",
    "- Prefer explore/reviewer types for read-only work to avoid permission prompts.",
    "- Do not nest more than one level of delegation."
  ].join("\n");
}
