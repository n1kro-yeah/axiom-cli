import type { TodoItem, ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { createToolCallId } from "../types.js";

const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);

interface TodoWriteInput {
  merge?: boolean;
  todos?: Array<{
    id?: string;
    content?: string;
    status?: string;
    priority?: string;
  }>;
}

export function normalizeTodoItems(
  raw: NonNullable<TodoWriteInput["todos"]>,
  previous: TodoItem[],
  merge: boolean
): TodoItem[] {
  const base = merge ? [...previous] : [];
  const byId = new Map(base.map((item) => [item.id, item]));
  const out: TodoItem[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;

    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    if (content.length === 0) continue;

    const status =
      typeof entry.status === "string" && VALID_STATUSES.has(entry.status)
        ? (entry.status as TodoItem["status"])
        : "pending";
    const priority =
      typeof entry.priority === "string" && VALID_PRIORITIES.has(entry.priority)
        ? (entry.priority as TodoItem["priority"])
        : "medium";

    let id = typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id.trim() : "";
    if (id && byId.has(id)) {
      const existing = byId.get(id);
      out.push({
        id,
        content,
        status,
        priority: priority !== "medium" ? priority : existing?.priority ?? priority
      });
      byId.delete(id);
      continue;
    }
    if (!id) id = `todo_${createToolCallId().slice(5, 14)}`;

    out.push({ id, content, status, priority });
    byId.delete(id);
  }

  return out;
}

export function validateTodoInvariants(items: TodoItem[]): string[] {
  const problems: string[] = [];
  const inProgress = items.filter((item) => item.status === "in_progress");

  if (inProgress.length > 1) {
    problems.push(`${inProgress.length} items are in_progress; keep exactly one`);
  }
  if (items.length > 30) {
    problems.push(`todo list is too large (${items.length}); consolidate into fewer tasks`);
  }

  const duplicates = findDuplicateContents(items);
  if (duplicates.length > 0) {
    problems.push(`duplicate contents detected: ${duplicates.slice(0, 3).join("; ")}`);
  }

  return problems;
}

function findDuplicateContents(items: TodoItem[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of items) {
    const key = item.content.toLowerCase();
    if (seen.has(key)) duplicates.push(item.content);
    seen.add(key);
  }
  return [...new Set(duplicates)];
}

export function renderTodoList(items: TodoItem[]): string {
  if (items.length === 0) return "(todo list is empty)";
  const icons: Record<TodoItem["status"], string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
    cancelled: "[-]"
  };
  return items
    .map((item) => `${icons[item.status]} ${item.priority === "high" ? "!" : " "} ${item.content}`)
    .join("\n");
}

export const todoWriteTool: ToolDefinition = {
  name: "todo_write",
  label: "Todo",
  description:
    "Maintain the session task list. Provide the full list each call. Keep exactly one item in_progress while executing work; mark completed immediately when done; cancel stale items instead of deleting them.",
  parameters: {
    type: "object",
    properties: {
      merge: {
        type: "boolean",
        description: "Merge with the existing list instead of replacing it"
      },
      todos: {
        type: "array",
        description: "The task list",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id to update an existing item" },
            content: { type: "string", description: "Imperative task description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "Current state"
            },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Relative importance"
            }
          },
          required: ["content"]
        }
      }
    },
    required: ["todos"]
  },
  readOnly: false,

  needsPermission(): { required: boolean; risk: "low" } {
    return { required: false, risk: "low" };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const typed = input as TodoWriteInput;
    const rawTodos = typed.todos;
    if (!Array.isArray(rawTodos)) {
      throw new AxiomError("todos must be an array");
    }
    if (rawTodos.length === 0) {
      context.setTodoList([]);
      return { content: "Todo list cleared", isError: false, metadata: { open: 0 } };
    }

    const merged = normalizeTodoItems(rawTodos, context.getTodoList(), typed.merge === true);
    const problems = validateTodoInvariants(merged);

    context.setTodoList(merged);

    const open = merged.filter((item) => item.status === "pending" || item.status === "in_progress").length;
    const warning = problems.length > 0 ? `\n\nWarnings:\n${problems.map((p) => `- ${p}`).join("\n")}` : "";

    return {
      content: `Todo list updated (${open} open):\n${renderTodoList(merged)}${warning}`,
      isError: false,
      metadata: {
        open,
        total: merged.length,
        warnings: problems.length > 0 ? problems : undefined
      }
    };
  }
};
