import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../../agent/loop.js";
import type {
  AgentEvent,
  AgentRuntimeStatus,
  AttachmentRef,
  ChatMessage,
  PermissionRequest,
  TodoItem,
  Usage
} from "../../types.js";
import { emptyUsage } from "../../types.js";

export interface AgentBusState {
  completed: ChatMessage[];
  streaming: ChatMessage | null;
  status: AgentRuntimeStatus;
  queueDepth: number;
  queuePreview: string[];
  pendingPermission: PermissionRequest | null;
  runningToolIds: Set<string>;
  progressByCall: Map<string, string[]>;
  todos: TodoItem[];
  usage: Usage;
  costUSD: number;
  latestNotice: { level: "info" | "warn" | "error"; text: string } | null;
}

export interface UseAgentBusResult extends AgentBusState {
  addAttachment: (chip: { path: string; kind: "image" | "text" }) => void;
  clearAttachments: () => void;
  attachments: AttachmentRef[];
  inputHistory: string[];
  rememberInput: (value: string) => void;
}

const SYNC_THROTTLE_MS = 34;

export function useAgentBus(agent: Agent): UseAgentBusResult {
  const [completed, setCompleted] = useState<ChatMessage[]>(() =>
    agent.messages.filter((message) => message.role === "user" || message.stopReason !== undefined)
  );
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [status, setStatus] = useState<AgentRuntimeStatus>(agent.status);
  const [queueDepth, setQueueDepth] = useState(0);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [runningToolIds, setRunningToolIds] = useState<Set<string>>(new Set());
  const [progressByCall, setProgressByCall] = useState<Map<string, string[]>>(new Map());
  const [todos, setTodos] = useState<TodoItem[]>(agent.todos);
  const [usage, setUsage] = useState<Usage>(() => agent.usage ?? emptyUsage());
  const [costUSD, setCostUSD] = useState(0);
  const [latestNotice, setLatestNotice] = useState<AgentBusState["latestNotice"]>(null);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const historyRef = useRef<string[]>([]);

  const syncScheduledRef = useRef(false);

  const scheduleStreamSync = useCallback(() => {
    if (syncScheduledRef.current) return;
    syncScheduledRef.current = true;
    setTimeout(() => {
      syncScheduledRef.current = false;
      const last = agent.messages[agent.messages.length - 1];
      if (last && last.role === "assistant") {
        setStreaming(structuredClone(last));
      }
    }, SYNC_THROTTLE_MS);
  }, [agent]);

  useEffect(() => {
    const handle = (event: AgentEvent): void => {
      switch (event.type) {
        case "status_changed":
          setStatus(event.status);
          if (event.status === "idle") {
            setRunningToolIds(new Set());
            setTimeout(() => setPendingPermission(null), 0);
          }
          break;

        case "assistant_started":
          setStreaming({ id: event.messageId, role: "assistant", parts: [], timestamp: Date.now() });
          break;

        case "text_delta":
        case "thinking_delta":
        case "part_added":
        case "part_updated":
          scheduleStreamSync();
          break;

        case "assistant_finished": {
          setStreaming(null);
          setCompleted((current) => [...current, structuredClone(event.message)]);
          break;
        }

        case "user_message_added":
          setCompleted((current) => [...current, structuredClone(event.message)]);
          break;

        case "permission_requested":
          setPendingPermission(event.request);
          break;

        case "permission_resolved":
          setPendingPermission(null);
          break;

        case "tool_started":
          setRunningToolIds((current) => new Set([...current, event.callId]));
          setProgressByCall((current) => {
            const next = new Map(current);
            next.set(event.callId, []);
            return next;
          });
          break;

        case "tool_progress":
          setProgressByCall((current) => {
            const next = new Map(current);
            const existing = next.get(event.callId) ?? [];
            next.set(event.callId, [...existing.slice(-18), event.line]);
            return next;
          });
          break;

        case "tool_finished":
          setRunningToolIds((current) => {
            const next = new Set(current);
            next.delete(event.callId);
            return next;
          });
          break;

        case "queue_updated":
          setQueueDepth(event.depth);
          break;

        case "todo_updated":
          setTodos([...event.items]);
          break;

        case "usage_updated":
          setUsage(event.usage);
          setCostUSD(event.costUSD);
          break;

        case "notice":
          setLatestNotice({ level: event.level, text: event.text });
          break;

        default:
          break;
      }
    };

    const off = agent.on(handle);
    return () => {
      off();
    };
  }, [agent, scheduleStreamSync]);

  const addAttachment = useCallback((chip: { path: string; kind: "image" | "text" }) => {
    setAttachments((current) => {
      if (current.some((existing) => existing.path === chip.path)) return current;
      return [
        ...current,
        {
          kind: chip.kind === "image" ? ("image" as const) : ("text" as const),
          path: chip.path,
          sizeBytes: 0
        }
      ];
    });
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  const rememberInput = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const next = [...historyRef.current.filter((entry) => entry !== trimmed), trimmed].slice(-300);
    historyRef.current = next;
    setInputHistory(next);
  }, []);

  const queuePreview = useMemo(() => [], []);

  return {
    completed,
    streaming,
    status,
    queueDepth,
    queuePreview,
    pendingPermission,
    runningToolIds,
    progressByCall,
    todos,
    usage,
    costUSD,
    latestNotice,
    attachments,
    addAttachment,
    clearAttachments,
    inputHistory,
    rememberInput
  };
}
