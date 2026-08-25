import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type {
  AttachmentRef,
  ChatMessage,
  PermissionDecision,
  PermissionMode,
  PermissionRequest
} from "../types.js";
import type { Agent } from "../agent/loop.js";
import { useAgentBus } from "./hooks/use-agent-bus.js";
import { ThemeContext, getTheme, ACCENT_NAMES, AXIOM_LOGO } from "./theme.js";
import type { AccentName } from "./theme.js";
import { CompletedMessages, StreamingMessage } from "./components/message-list.js";
import { InputPanel } from "./components/input-panel.js";
import { StatusBar, ActivityLine, ModeBanner } from "./components/status-bar.js";
import { PermissionDialog, NoticeLine } from "./components/dialogs.js";
import { OverlayPicker, HelpOverlay } from "./components/overlay-picker.js";
import type { PickerOption } from "./components/overlay-picker.js";
import { ProviderWizard } from "./components/provider-wizard.js";
import type { ProviderDraft } from "./components/provider-wizard.js";
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

export function AxiomApp(props: { runtime: TuiRuntime }): React.ReactElement {
  const { exit } = useApp();
  const runtime = props.runtime;
  const { agent, config, sessions, registry, commands, paths, translator, permissionEngine } = runtime;

  const bus = useAgentBus(agent);
  const [overlay, setOverlay] = useState<OverlayState>({ kind: "none" });
  const [accent, setAccentState] = useState<AccentName>(config.loadGlobalSync().theme.accent);
  const [mode, setModeState] = useState<PermissionMode>(agent.mode);
  const [fileIndex, setFileIndex] = useState<string[]>([]);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [expandedThinkingIds, setExpandedThinkingIds] = useState<Set<string>>(new Set());
  const [commandNotices, setCommandNotices] = useState<Array<{ level: "info" | "warn" | "error"; text: string }>>([]);

  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const activePermissionResolveRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const lastCtrlCRef = useRef(0);
  const fileRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnMessageCountRef = useRef(agent.messages.length);

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

  useEffect(() => {
    permissionEngine.setAskHandler(async (request: PermissionRequest) => {
      return new Promise<PermissionDecision>((resolve) => {
        const resolver = (decision: PermissionDecision) => {
          permissionResolverRef.current = null;
          activePermissionResolveRef.current = null;
          resolve(decision);
          agent.emit({ type: "permission_resolved", requestId: request.id, decision });
        };
        permissionResolverRef.current = resolver;
        activePermissionResolveRef.current = resolver;
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
      if (event.type === "user_message_added") {
        void sessions.appendMessage(runtime.sessionId, structuredClone(event.message));
        turnMessageCountRef.current += 1;
      }
      if (event.type === "assistant_finished") {
        void sessions.appendMessage(runtime.sessionId, structuredClone(event.message));
        turnMessageCountRef.current += 1;
      }
      if (event.type === "status_changed" && event.status === "idle") {
        void sessions.updateMeta(runtime.sessionId, (draft) => {
          draft.messageCount = agent.messages.length;
          draft.totalCostUSD = agent.cost;
          draft.totalUsage = agent.usage;
        });
      }
    });
    return off;
  }, [agent, refreshFileIndex, runtime.sessionId, sessions]);

  const pushCommandNotice = useCallback((level: "info" | "warn" | "error", text: string) => {
    const firstLine = text.split("\n")[0];
    setCommandNotices((current) => {
      const previous = current[current.length - 1];
      if (previous && previous.level === level && previous.text === firstLine) return current;
      return [...current.slice(-3), { level, text: firstLine }];
    });
  }, []);

  useEffect(() => {
    if (!bus.latestNotice) return;
    pushCommandNotice(bus.latestNotice.level, bus.latestNotice.text);
  }, [bus.latestNotice, pushCommandNotice]);

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
      notice: pushCommandNotice,
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
      pushCommandNotice,
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
        pushCommandNotice("info", `provider "${draft.id}" saved (${draft.type})`);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [config, pushCommandNotice, runtime]
  );

  const handleSubmit = useCallback(
    async (text: string) => {
      bus.rememberInput(text.split("\n")[0].slice(0, 200));

      if (text.trim().startsWith("/")) {
        const result = await commands.dispatch(text, commandContext);
        if (result.kind === "notice") pushCommandNotice(result.level, result.text);
        return;
      }

      const attachmentsForSend: AttachmentRef[] = [...bus.attachments];
      await agent.send(text, attachmentsForSend.length > 0 ? attachmentsForSend : undefined);
      bus.clearAttachments();
    },
    [agent, bus, commandContext, commands, pushCommandNotice]
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
        pushCommandNotice("info", "stopping generationвЂ¦ press Ctrl+C again to quit");
      } else {
        pushCommandNotice("info", "press Ctrl+C again to quit");
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
      const lastAssistant = [...bus.completed].reverse().find((message) => message.role === "assistant");
      if (lastAssistant) {
        setExpandedThinkingIds((current) => {
          const next = new Set(current);
          if (next.has(lastAssistant.id)) next.delete(lastAssistant.id);
          else next.add(lastAssistant.id);
          return next;
        });
      }
      return;
    }
    if (input === "e" && !key.ctrl && !key.meta && bus.status !== "idle") {
      return;
    }
    if (input === "e" && !key.ctrl && !key.meta) {
      const lastToolCall = findLastToolCallId([...bus.completed]);
      if (lastToolCall) {
        setExpandedToolIds((current) => {
          const next = new Set(current);
          if (next.has(lastToolCall)) next.delete(lastToolCall);
          else next.add(lastToolCall);
          return next;
        });
      }
    }
  }, { isActive: overlay.kind === "none" });

  const slashHints = useMemo(() => commands.hints(), [commands]);
  const providerLabel = useMemo(() => {
    const providerId = agent.modelReference.split("/")[0];
    try {
      return registry.providerLabel(providerId);
    } catch {
      return providerId;
    }
  }, [agent.modelReference, registry]);

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

  const permissionRequestFromBus = bus.pendingPermission;
  const terminalRows = useTerminalRows();

  const handlePermissionDecision = useCallback(
    (decision: PermissionDecision) => {
      const resolver = activePermissionResolveRef.current ?? permissionResolverRef.current;
      resolver?.(decision);
      setCommandNotices((current) => [
        ...current.slice(-4),
        {
          level: decision === "deny" ? ("warn" as const) : ("info" as const),
          text: decision === "deny" ? "denied" : "approved"
        }
      ]);
    },
    []
  );

  return (
    <ThemeContext.Provider value={themeValue}>
      <Box flexDirection="column" width="100%">
        <CompletedMessages
          messages={bus.completed}
          expandedToolIds={expandedToolIds}
          expandedThinkingIds={expandedThinkingIds}
          runningToolIds={bus.runningToolIds}
        />

        <Box flexDirection="column" height={terminalRows}>
          <Box flexGrow={1} flexDirection="column">
            <WelcomeHeader visible={bus.completed.length === 0} subtitle={translator.dict.tui.welcomeSubtitle} />
            <Box flexGrow={1} flexShrink={1} />

            {bus.streaming ? (
              <StreamingMessage
                message={bus.streaming}
                runningToolIds={bus.runningToolIds}
                progressByCall={bus.progressByCall}
                pendingPermissionTool={undefined}
              />
            ) : null}

            {permissionRequestFromBus ? (
              <PermissionDialog request={permissionRequestFromBus} onDecision={handlePermissionDecision} />
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
              pushCommandNotice("info", `model в†’ ${value}`);
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
                pushCommandNotice("info", `resumed "${meta.title}"`);
              } else {
                pushCommandNotice("warn", "session empty or missing");
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
            options={ACCENT_NAMES.map((name) => ({ label: name, value: name }))}
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
              { label: "Р СѓСЃСЃРєРёР№", value: "ru" }
            ]}
            onClose={() => setOverlay({ kind: "none" })}
            onSelect={(value) => {
              config.mutateGlobal((draft) => {
                draft.language = value as "en" | "ru";
              });
              pushCommandNotice("info", `language в†’ ${value} (restart to fully apply)`);
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
                  { keys: "в†‘ / в†“", description: "input history В· navigate menus" },
                  { keys: "/", description: "slash commands" },
                  { keys: "@", description: "fuzzy file reference" },
                  { keys: "tab", description: "complete popup selection" },
                  { keys: "shift+tab", description: "cycle permission mode" },
                  { keys: "esc", description: "stop generation В· close overlays" },
                  { keys: "ctrl+t", description: "toggle last thinking block" },
                  { keys: "e", description: "expand/collapse last tool output" },
                  { keys: "ctrl+v", description: "attach clipboard image" },
                  { keys: "ctrl+c Г—2", description: "quit" }
                ]
              },
              {
                heading: "Commands",
                entries: slashHints.map((hint) => ({
                  keys: `/${hint.name}`,
                  description: hint.description
                }))
              }
            ]}
            onClose={() => setOverlay({ kind: "none" })}
          />
        ) : null}

        {commandNotices.map((entry, index) => (
          <NoticeLine key={`${index}_${entry.text}`} level={entry.level} text={entry.text} />
        ))}

        <ModeBanner mode={mode} />
        <ActivityLine status={bus.status} />
          </Box>

          <InputPanel
          busy={bus.status !== "idle"}
          waitingPermission={bus.status === "waiting_permission"}
          history={bus.inputHistory}
          slashCommands={slashHints}
          getFileSuggestions={() => fileIndex}
          attachments={bus.attachments.map((attachment) => ({
            id: attachment.path,
            label: attachment.path.split(/[\\/]/).pop() ?? attachment.path,
            kind: attachment.kind === "image" ? ("image" as const) : ("text" as const)
          }))}
          onAddPathAttachment={(path) => {
            bus.addAttachment({
              path: `${paths.projectRoot}\\${path}`.replace(/^\\\\/, "\\"),
              kind: /\.(png|jpe?g|gif|webp|bmp)$/i.test(path) ? "image" : "text"
            });
          }}
          onClearAttachments={bus.clearAttachments}
          modeHint={mode === "normal" ? undefined : mode}
          onSubmit={(text) => void handleSubmit(text)}
          onAbort={() => agent.abort("esc")}
          onPasteImage={() => pushCommandNotice("warn", "clipboard paste requires platform support (see docs)")}
          onOpenHelp={openHelp}
          overlayOpen={overlay.kind !== "none"}
        />

        <StatusBar
          status={bus.status}
          mode={mode}
          model={modelInfo}
          providerLabel={providerLabel}
          usedTokens={bus.usage.inputTokens + bus.usage.cacheReadTokens}
          totalTokens={bus.usage.inputTokens}
          costUSD={bus.costUSD}
          queueDepth={bus.queueDepth}
          mcpCount={Object.keys(config.loadGlobalSync().mcp).length}
          todos={bus.todos}
          cwd={paths.projectRoot}
          errorText={bus.status === "error" ? (commandNotices[commandNotices.length - 1]?.text ?? "error") : null}
        />
        </Box>
      </Box>
    </ThemeContext.Provider>
  );
}

function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout?.rows ?? 24);

  useEffect(() => {
    if (!stdout) return;
    setRows(stdout.rows ?? 24);
    const stream = stdout as unknown as { on?: (event: string, handler: () => void) => void; off?: (event: string, handler: () => void) => void };
    const onResize = () => setRows(stdout.rows ?? 24);
    stream.on?.("resize", onResize);
    return () => {
      stream.off?.("resize", onResize);
    };
  }, [stdout]);

  return rows;
}

function WelcomeHeader({ visible, subtitle }: { visible: boolean; subtitle: string }): React.ReactElement | null {
  const { theme } = useThemeSafe();
  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingLeft={1} paddingBottom={1}>
      <Text>
        <Text color={theme.textSecondary}>{AXIOM_LOGO}</Text>
        <Text dimColor> v0.1.0</Text>
      </Text>
      <Text dimColor>{subtitle}</Text>
      <Text dimColor>
        <Text color={theme.textSecondary}>/</Text> commands ·{" "}
        <Text color={theme.textSecondary}>@</Text> files ·{" "}
        <Text color={theme.textSecondary}>shift+tab</Text> modes ·{" "}
        <Text color={theme.textSecondary}>/init</Text> to create AGENTS.md
      </Text>
    </Box>
  );
}

function useThemeSafe() {
  const context = React.useContext(ThemeContext);
  return context;
}

function findLastToolCallId(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && part.type === "tool_call") return part.id;
    }
  }
  return undefined;
}

interface ModelPickerOverlayProps {
  registry: ProviderRegistry;
  current: string;
  onClose: () => void;
  onSelect: (value: string) => void;
}

function ModelPickerOverlay(props: ModelPickerOverlayProps): React.ReactElement {
  const groups = props.registry.allModelsGrouped();
  const options: PickerOption[] = [];

  for (const group of groups) {
    for (const model of group.models) {
      const value = `${group.providerId}/${model.id}`;
      options.push({
        label: value,
        hint: `${model.label} В· ${Math.round(model.contextWindow / 1000)}k${model.recommended ? "  в…" : ""}`,
        value
      });
    }
  }

  return (
    <OverlayPicker
      title={`Select model (current: ${props.current})`}
      options={options}
      filterable
      visibleCount={14}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  );
}

interface SessionsPickerOverlayProps {
  sessions: SessionStore;
  onClose: () => void;
  onSelect: (id: string) => void | Promise<void>;
}

function SessionsPickerOverlay(props: SessionsPickerOverlayProps): React.ReactElement {
  const [options, setOptions] = useState<PickerOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void props.sessions.listSessions().then((all) => {
      if (cancelled) return;
      setOptions(
        all.slice(0, 40).map((meta) => ({
          label: meta.title.slice(0, 50),
          hint: `${new Date(meta.updatedAt).toISOString().slice(5, 16)} В· ${meta.messageCount} msg В· $${meta.totalCostUSD.toFixed(3)}`,
          value: meta.id
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [props.sessions]);

  return (
    <OverlayPicker
      title="Resume session"
      options={options}
      filterable
      visibleCount={12}
      onSelect={(value) => void props.onSelect(value)}
      onClose={props.onClose}
    />
  );
}
