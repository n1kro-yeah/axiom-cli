import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useInput, useStdout, useWindowSize } from "ink";
import type {
  AgentEvent,
  AttachmentRef,
  PermissionDecision,
  PermissionMode,
  PermissionRequest
} from "../types.js";
import type { Agent } from "../agent/loop.js";
import { applyAgentEvents, bubblesFromMessages } from "./transcript.js";
import type { Bubble } from "./transcript.js";
import { ThemeContext, getTheme } from "./theme.js";
import type { AccentName } from "./theme.js";
import { Transcript } from "./components/transcript.js";
import { InputPanel, pushInputHistory } from "./components/input-panel.js";
import { StatusBar } from "./components/status-bar.js";
import type { StatusBarData } from "./components/status-bar.js";
import { TerminalViewport, liveTranscriptRows } from "./components/terminal-viewport.js";
import { PermissionDialog, NoticeLine } from "./components/dialogs.js";
import { OverlayPicker, HelpOverlay } from "./components/overlay-picker.js";
import { ProviderWizard } from "./components/provider-wizard.js";
import type { ProviderDraft } from "./components/provider-wizard.js";
import { ModelPickerOverlay, SessionsPickerOverlay } from "./components/overlays.js";
import type { CommandRegistry, CommandContext } from "../commands/registry.js";
import type { ConfigStore } from "../config/loader.js";
import type { AuthStore } from "../auth/store.js";
import type { SessionStore } from "../session/store.js";
import type { CheckpointManager } from "../session/checkpoint.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HooksRunner } from "../hooks/runner.js";
import type { PermissionEngine } from "../permissions/engine.js";
import type { AxiomPaths } from "../config/paths.js";
import type { Translator } from "../i18n/index.js";
import { walkFiles } from "../util/walk.js";

export interface TuiRuntime {
  agent: Agent;
  config: ConfigStore;
  auth: AuthStore;
  sessions: SessionStore;
  checkpoints: CheckpointManager;
  registry: ProviderRegistry;
  tools: ToolRegistry;
  hooks: HooksRunner;
  commands: CommandRegistry;
  paths: AxiomPaths;
  translator: Translator;
  permissionEngine: PermissionEngine;
  sessionId: string;
  onExit: () => void;
}

type OverlayState =
  | { kind: "none" }
  | { kind: "model" }
  | { kind: "sessions" }
  | { kind: "theme" }
  | { kind: "lang" }
  | { kind: "help" }
  | { kind: "provider-add" };

const MODE_CYCLE: PermissionMode[] = ["normal", "accept", "plan", "bypass"];
const STREAM_FRAME_MS = 50;

export function AxiomApp(props: { runtime: TuiRuntime }): React.ReactElement {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const runtime = props.runtime;
  const { agent, config, sessions, registry, commands, paths, translator, permissionEngine } = runtime;

  const [bubbles, setBubbles] = useState<Bubble[]>(() => bubblesFromMessages(agent.messages));
  const [status, setStatus] = useState(agent.status);
  const [queueDepth, setQueueDepth] = useState(0);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [todos, setTodos] = useState(agent.todos);
  const [usageSnapshot, setUsageSnapshot] = useState(() => agent.usage);
  const [costUSD, setCostUSD] = useState(0);
  const [overlay, setOverlay] = useState<OverlayState>({ kind: "none" });
  const [accent, setAccentState] = useState<AccentName>(config.loadGlobalSync().theme.accent);
  const [mode, setModeState] = useState<PermissionMode>(agent.mode);
  const [fileIndex, setFileIndex] = useState<string[]>([]);
  const [expandedThinking, setExpandedThinking] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [sessionStart] = useState(() => Date.now());
  const [, tick] = useState(0);

  const historyRef = useRef<string[]>([]);
  const pendingEvents = useRef<AgentEvent[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const lastCtrlCRef = useRef(0);
  const fileRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnMessageCountRef = useRef(0);

  const themeValue = useMemo(
    () => ({
      theme: getTheme(accent),
      setAccent: (next: AccentName) => {
        setAccentState(next);
        config.mutateGlobal((draft) => {
          draft.theme.accent = next;
        });
      }
    }),
    [accent, config]
  );

  const flushTranscript = useCallback(() => {
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const events = pendingEvents.current;
    if (events.length === 0) return;
    pendingEvents.current = [];
    setBubbles((current) => applyAgentEvents(current, events));
  }, []);

  const queueTranscriptEvent = useCallback(
    (event: AgentEvent) => {
      pendingEvents.current.push(event);
      if (event.type !== "text_delta" && event.type !== "thinking_delta") {
        flushTranscript();
        return;
      }
      if (flushTimer.current === null) {
        flushTimer.current = setTimeout(flushTranscript, STREAM_FRAME_MS);
      }
    },
    [flushTranscript]
  );

  useEffect(() => {
    return () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      pendingEvents.current = [];
    };
  }, []);

  useEffect(() => {
    if (turnStart === null) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [turnStart]);

  useEffect(() => {
    const handle = (event: AgentEvent): void => {
      switch (event.type) {
        case "text_delta":
        case "thinking_delta":
        case "assistant_started":
        case "assistant_finished":
        case "user_message_added":
        case "tool_started":
        case "tool_progress":
        case "tool_finished":
        case "notice":
          queueTranscriptEvent(event);
          if (event.type === "user_message_added" || event.type === "assistant_finished") {
            void sessions.appendMessage(runtime.sessionId, structuredClone(event.message));
            turnMessageCountRef.current += 1;
          }
          break;

        case "status_changed":
          setStatus(event.status);
          if (event.status === "streaming") setTurnStart(Date.now());
          if (event.status === "idle" || event.status === "error" || event.status === "aborted") {
            setTurnStart(null);
            setPendingPermission(null);
            void sessions.updateMeta(runtime.sessionId, (draft) => {
              draft.messageCount = agent.messages.length;
              draft.totalCostUSD = agent.cost;
              draft.totalUsage = agent.usage;
            });
          }
          break;

        case "permission_requested":
          setPendingPermission(event.request);
          break;

        case "permission_resolved":
          setPendingPermission(null);
          break;

        case "queue_updated":
          setQueueDepth(event.depth);
          break;

        case "todo_updated":
          setTodos([...event.items]);
          break;

        case "usage_updated":
          setUsageSnapshot(event.usage);
          setCostUSD(event.costUSD);
          break;

        default:
          break;
      }
    };

    return agent.on(handle);
  }, [agent, queueTranscriptEvent, runtime.sessionId, sessions]);

  useEffect(() => {
    permissionEngine.setAskHandler(async (request: PermissionRequest) => {
      return new Promise<PermissionDecision>((resolve) => {
        const resolver = (decision: PermissionDecision) => {
          permissionResolverRef.current = null;
          resolve(decision);
          agent.emit({ type: "permission_resolved", requestId: request.id, decision });
        };
        permissionResolverRef.current = resolver;
        agent.emit({ type: "permission_requested", request });
      });
    });

    return () => {
      permissionEngine.setAskHandler(undefined);
    };
  }, [agent, permissionEngine]);

  const refreshFileIndex = useCallback(() => {
    if (fileRefreshTimerRef.current) clearTimeout(fileRefreshTimerRef.current);
    fileRefreshTimerRef.current = setTimeout(async () => {
      try {
        const walk = await walkFiles(paths.projectRoot, {
          respectGitIgnore: true,
          maxDepth: 14,
          maxEntries: 12000
        });
        setFileIndex(walk.files.slice(0, 6000));
      } catch {
      }
    }, 400);
  }, [paths.projectRoot]);

  useEffect(() => {
    refreshFileIndex();
  }, [refreshFileIndex]);

  useEffect(() => {
    const off = agent.on((event) => {
      if (event.type === "tool_started" && ["write", "edit", "patch"].includes(event.name)) {
        refreshFileIndex();
      }
    });
    return off;
  }, [agent, refreshFileIndex]);

  const pushNotice = useCallback(
    (level: "info" | "warn" | "error", text: string) => {
      queueTranscriptEvent({ type: "notice", level, text: text.split("\n")[0] });
    },
    [queueTranscriptEvent]
  );

  const openModelPicker = useCallback(() => setOverlay({ kind: "model" }), []);
  const openSessions = useCallback(() => setOverlay({ kind: "sessions" }), []);
  const openThemePicker = useCallback(() => setOverlay({ kind: "theme" }), []);
  const openLangPicker = useCallback(() => setOverlay({ kind: "lang" }), []);
  const openHelp = useCallback(() => setOverlay({ kind: "help" }), []);
  const openProviderAdd = useCallback(() => setOverlay({ kind: "provider-add" }), []);
  const requestExit = useCallback(() => {
    runtime.onExit();
    exit();
  }, [exit, runtime]);

  const uiBridge = useMemo(
    () => ({
      openModelPicker,
      openSessions,
      openThemePicker,
      openLangPicker,
      openHelp,
      openProviderAdd,
      notice: pushNotice,
      requestExit,
      setMode: (next: PermissionMode) => {
        setModeState(next);
        agent.setMode(next);
        permissionEngine.setMode(next);
      },
      refreshFileIndex
    }),
    [
      agent,
      openHelp,
      openLangPicker,
      openModelPicker,
      openProviderAdd,
      openSessions,
      openThemePicker,
      permissionEngine,
      pushNotice,
      refreshFileIndex,
      requestExit
    ]
  );

  const commandContext = useMemo<CommandContext>(
    () => ({
      agent,
      config,
      auth: runtime.auth,
      sessions,
      checkpoints: runtime.checkpoints,
      registry,
      tools: runtime.tools,
      hooks: runtime.hooks,
      paths,
      t: translator,
      skills: () => [],
      sessionId: () => runtime.sessionId,
      ui: uiBridge
    }),
    [agent, config, paths, registry, runtime, sessions, translator, uiBridge]
  );

  const rememberInput = useCallback((value: string) => {
    const trimmed = value.split("\n")[0].slice(0, 200).trim();
    if (trimmed.length === 0) return;
    const next = pushInputHistory(historyRef.current, trimmed);
    historyRef.current = next;
    setInputHistory(next);
  }, []);

  const addAttachment = useCallback((path: string, kind: "image" | "text") => {
    setAttachments((current) => {
      if (current.some((existing) => existing.path === path)) return current;
      return [...current, { kind, path, sizeBytes: 0 }];
    });
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  const handleProviderDraft = useCallback(
    async (draft: ProviderDraft): Promise<string | null> => {
      try {
        config.mutateGlobal((globalDraft) => {
          globalDraft.providers[draft.id] = {
            type: draft.type,
            baseUrl: draft.baseUrl,
            ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
            ...(draft.keyEnv ? { keyEnv: draft.keyEnv } : {}),
            ...(draft.defaultModel ? { defaultModel: draft.defaultModel } : {})
          };
        });

        if (draft.apiKey && draft.apiKey.trim().length > 0) {
          await runtime.auth.setProvider(draft.id, { apiKey: draft.apiKey.trim() });
        }

        runtime.registry.invalidateAdapter(draft.id);
        pushNotice("info", `provider "${draft.id}" saved (${draft.type})`);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [config, pushNotice, runtime]
  );

  const handleSubmit = useCallback(
    async (text: string) => {
      rememberInput(text);

      if (text.trim().startsWith("/")) {
        const result = await commands.dispatch(text, commandContext);
        if (result.kind === "notice") pushNotice(result.level, result.text);
        return;
      }

      const attachmentsForSend: AttachmentRef[] = [...attachments];
      clearAttachments();
      await agent.send(text, attachmentsForSend.length > 0 ? attachmentsForSend : undefined);
    },
    [agent, attachments, clearAttachments, commandContext, commands, pushNotice, rememberInput]
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 1600) {
        requestExit();
        return;
      }
      lastCtrlCRef.current = now;
      if (agent.isRunning) {
        agent.abort("ctrl-c");
        pushNotice("info", "stopping generation... press Ctrl+C again to quit");
      } else {
        pushNotice("info", "press Ctrl+C again to quit");
      }
      return;
    }
    if (!key.ctrl && key.tab && key.shift === true) {
      const currentIndex = MODE_CYCLE.indexOf(mode);
      const next = MODE_CYCLE[(currentIndex + 1) % MODE_CYCLE.length];
      uiBridge.setMode(next);
      return;
    }
    if (key.ctrl && input === "t") {
      setExpandedThinking((current) => !current);
      return;
    }
    if (input === "e" && !key.ctrl && !key.meta && status === "idle") {
      void expandedThinking;
    }
  }, { isActive: overlay.kind === "none" });

  const modelInfo = useMemo(() => {
    try {
      return registry.resolveModelInfo(agent.modelReference).model;
    } catch {
      return {
        id: agent.modelReference,
        label: agent.modelReference,
        provider: "unknown",
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsImages: false,
        supportsThinking: false,
        supportsCacheControl: false
      };
    }
  }, [agent.modelReference, registry]);

  const busy = status !== "idle" && status !== "error" && status !== "aborted";

  const statusBarData = useMemo<StatusBarData>(
    () => ({
      modelRef: agent.modelReference,
      effort: config.loadGlobalSync().effort,
      thinking: config.loadGlobalSync().thinking,
      mode,
      usage: {
        input: usageSnapshot.inputTokens + usageSnapshot.cacheReadTokens,
        output: usageSnapshot.outputTokens,
        cacheRead: usageSnapshot.cacheReadTokens,
        costUsd: costUSD
      },
      context: {
        window: modelInfo.contextWindow,
        used: usageSnapshot.inputTokens + usageSnapshot.cacheReadTokens,
        exact: true
      },
      turnMs: turnStart,
      sessionMs: Date.now() - sessionStart,
      bypass: mode === "bypass",
      busy,
      mcpConnected: Object.values(config.loadGlobalSync().mcp).filter((server) => server.enabled).length,
      mcpFailed: 0,
      activeAgents: 0,
      queueDepth
    }),
    [
      agent.modelReference,
      busy,
      config,
      costUSD,
      mode,
      modelInfo.contextWindow,
      queueDepth,
      sessionStart,
      turnStart,
      usageSnapshot
    ]
  );

  const handlePermissionDecision = useCallback((decision: PermissionDecision) => {
    permissionResolverRef.current?.(decision);
  }, []);

  const lastErrorText =
    status === "error" ? "the last turn failed - see transcript above" : null;

  return (
    <ThemeContext.Provider value={themeValue}>
      <TerminalViewport rows={rows}>
        <Transcript
          bubbles={bubbles}
          workspace={paths.projectRoot}
          maxLiveRows={liveTranscriptRows(rows)}
        />

        {pendingPermission ? (
          <PermissionDialog request={pendingPermission} onDecision={handlePermissionDecision} />
        ) : null}

        {overlay.kind === "model" ? (
          <ModelPickerOverlay
            registry={registry}
            current={agent.modelReference}
            onClose={() => setOverlay({ kind: "none" })}
            onSelect={(value) => {
              agent.setModel(value);
              config.mutateGlobal((draft) => {
                draft.model = value;
              });
              pushNotice("info", `model -> ${value}`);
              setOverlay({ kind: "none" });
            }}
          />
        ) : null}

        {overlay.kind === "sessions" ? (
          <SessionsPickerOverlay
            sessions={sessions}
            onClose={() => setOverlay({ kind: "none" })}
            onSelect={async (id) => {
              const meta = await sessions.loadMeta(id);
              const messages = meta ? await sessions.loadMessages(id) : [];
              if (meta && messages.length > 0) {
                agent.restoreMessages(messages);
                agent.setModel(`${meta.provider}/${meta.model}`);
                setBubbles(bubblesFromMessages(messages));
                pushNotice("info", `resumed "${meta.title}"`);
              } else {
                pushNotice("warn", "session empty or missing");
              }
              setOverlay({ kind: "none" });
            }}
          />
        ) : null}

        {overlay.kind === "provider-add" ? (
          <ProviderWizard
            knownProviderIds={registry.configuredProviderIds()}
            onSubmit={handleProviderDraft}
            onCancel={() => setOverlay({ kind: "none" })}
          />
        ) : null}

        {overlay.kind === "theme" ? (
          <OverlayPicker
            title="Accent color"
            filterable={false}
            options={["violet", "cyan", "magenta", "green", "yellow", "blue", "red"].map((name) => ({
              label: name,
              value: name
            }))}
            onClose={() => setOverlay({ kind: "none" })}
            onSelect={(value) => {
              themeValue.setAccent(value as AccentName);
              setOverlay({ kind: "none" });
            }}
          />
        ) : null}

        {overlay.kind === "lang" ? (
          <OverlayPicker
            title="Language"
            filterable={false}
            options={[
              { label: "English", value: "en" },
              { label: "Русский", value: "ru" }
            ]}
            onClose={() => setOverlay({ kind: "none" })}
            onSelect={(value) => {
              config.mutateGlobal((draft) => {
                draft.language = value as "en" | "ru";
              });
              pushNotice("info", `language -> ${value} (restart to fully apply)`);
              setOverlay({ kind: "none" });
            }}
          />
        ) : null}

        {overlay.kind === "help" ? (
          <HelpOverlay
            title="Axiom help"
            sections={[
              {
                heading: "Keys",
                entries: [
                  { keys: "enter", description: "send message / accept completion" },
                  { keys: "up / down", description: "input history · navigate menus" },
                  { keys: "/", description: "slash commands" },
                  { keys: "@", description: "fuzzy file reference" },
                  { keys: "tab", description: "complete popup selection" },
                  { keys: "shift+tab", description: "cycle permission mode" },
                  { keys: "esc", description: "stop generation · close overlays" },
                  { keys: "ctrl+v", description: "attach clipboard image" },
                  { keys: "ctrl+c x2", description: "quit" }
                ]
              },
              {
                heading: "Commands",
                entries: commands.hints().map((hint) => ({
                  keys: `/${hint.name}`,
                  description: hint.description
                }))
              }
            ]}
            onClose={() => setOverlay({ kind: "none" })}
          />
        ) : null}

        {lastErrorText ? <NoticeLine level="error" text={lastErrorText} /> : null}

        <InputPanel
          busy={busy}
          waitingPermission={status === "waiting_permission"}
          history={inputHistory}
          slashCommands={commands.hints()}
          getFileSuggestions={() => fileIndex}
          attachments={attachments.map((attachment) => ({
            id: attachment.path,
            label: attachment.path.split(/[\\/]/).pop() ?? attachment.path,
            kind: attachment.kind === "image" ? ("image" as const) : ("text" as const)
          }))}
          pendingCount={queueDepth}
          hint={busy ? "esc to interrupt" : undefined}
          onAddPathAttachment={(path) => {
            addAttachment(
              path,
              /\.(png|jpe?g|gif|webp|bmp)$/i.test(path) ? "image" : "text"
            );
          }}
          onClearAttachments={clearAttachments}
          onSubmit={(text) => void handleSubmit(text)}
          onAbort={() => agent.abort("esc")}
          onPasteImage={() => pushNotice("warn", "clipboard paste requires platform support")}
          onOpenHelp={openHelp}
          overlayOpen={overlay.kind !== "none"}
        />

        <StatusBar status={statusBarData} />
      </TerminalViewport>
    </ThemeContext.Provider>
  );
}

function useTerminalRowsFallback(): number {
  const { stdout } = useStdout();
  return stdout?.rows ?? 24;
}
