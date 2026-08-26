import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  ScrollView,
  VStack,
  TuiAltScreen,
  TuiMainScreen,
  ProcessTerminal,
  matchesKey,
  isViewportTUI
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentEvent, PermissionDecision, PermissionMode } from "../../types.js";
import type { Agent } from "../../agent/loop.js";
import type { TuiRuntime } from "../app-types.js";import { applyAgentEvents, bubblesFromMessages } from "../transcript.js";
import type { Bubble } from "../transcript.js";
import { makeAnsiTheme, resolveAccentName } from "./ansi.js";
import type { AnsiTheme } from "./ansi.js";
import { TranscriptComponent } from "./transcript-component.js";
import { StatusComponent } from "./status-component.js";
import { LogoComponent } from "./logo-component.js";
import { showPermissionOverlay, showPickerOverlay, showTextInputOverlay } from "./overlays.js";
import type { OverlayContext } from "./overlays.js";

const STREAM_FRAME_MS = 50;
const MODE_CYCLE: PermissionMode[] = ["normal", "accept", "plan", "bypass"];

export class AxiomTui {
  private readonly tui!: TUI;
  private readonly terminalColumns: number;
  private readonly ansi: AnsiTheme;
  private readonly transcript: TranscriptComponent;
  private readonly status: StatusComponent;
  private readonly editor: Editor;
  private readonly pendingContainer = new Container();
  private readonly footerContainer = new Container();
  private bubbles: Bubble[] = [];
  private pendingEvents: AgentEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: PermissionMode;
  private turnStart: number | null = null;
  private sessionStart = Date.now();
  private lastCtrlC = 0;
  private closed = false;
  private offAgent: () => void = () => undefined;
  private statusTick: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runtime: TuiRuntime,
    options: { altScreen: boolean }
  ) {
    const terminal = new ProcessTerminal();
    this.ansi = makeAnsiTheme(resolveAccentName(runtime.config.loadGlobalSync().theme.accent));
    this.terminalColumns = terminal.columns ?? 100;
    this.mode = runtime.agent.mode;
    this.transcript = new TranscriptComponent(this.ansi);
    this.status = new StatusComponent(this.ansi);

    const commandHints = runtime.commands.hints();
    const autocomplete = new CombinedAutocompleteProvider(
      commandHints.map((hint) => ({ name: hint.name, description: hint.description })),
      runtime.paths.projectRoot
    );

    if (options.altScreen) {
      this.tui = new TuiAltScreen(terminal);
    } else {
      this.tui = new TuiMainScreen(terminal);
    }

    const editorTheme = {
      borderColor: (text: string) => this.ansi.accent(text),
      selectList: {
        selectedPrefix: (text: string) => this.ansi.accent(`> ${text}`),
        selectedText: (text: string) => this.ansi.bold(text),
        description: (text: string) => this.ansi.muted(text),
        scrollInfo: (text: string) => this.ansi.faint(text),
        noMatch: (text: string) => this.ansi.muted(text)
      }
    };

    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteProvider(autocomplete);

    this.buildLayout();
    this.wireEditor();
    this.wireAgent();
    this.wirePermission();
    this.wireKeys();
  }

  private overlayCtx(): OverlayContext {
    if (!this.overlayContext) {
      this.overlayContext = {
        tui: this.tui,
        ansi: this.ansi,
        restoreFocus: () => this.tui.setFocus(this.editor)
      };
    }
    return this.overlayContext;
  }

  private buildLayout(): void {
    const transcriptRoot = new Container();
    transcriptRoot.addChild(
      new LogoComponent(
        this.ansi,
        "0.1.0",
        "agentic coding assistant - / commands - @ files - shift+tab modes",
        this.runtime.paths.projectRoot,
        this.terminalColumns
      )
    );
    transcriptRoot.addChild(this.transcript);

    if (isViewportTUI(this.tui)) {
      const transcriptView = new ScrollView(transcriptRoot, {
        follow: "end",
        primary: true,
        overscroll: "chain"
      });

      const dock = new VStack([
        { component: this.pendingContainer, shrink: 1, minSize: 0 },
        { component: this.status, shrink: 1, minSize: 1 },
        { component: this.editor, shrink: 1, minSize: 3 },
        { component: this.footerContainer, shrink: 1, minSize: 0 }
      ]);

      this.tui.setLayoutRoot(
        new VStack([
          { component: transcriptView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
          { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 }
        ])
      );
    } else {
      this.tui.addChild(transcriptRoot);
      this.tui.addChild(this.pendingContainer);
      this.tui.addChild(this.status);
      this.tui.addChild(this.editor);
      this.tui.addChild(this.footerContainer);
    }

    this.tui.setFocus(this.editor);
  }

  private wireEditor(): void {
    this.editor.onSubmit = (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      void this.handleSubmit(trimmed);
    };
  }

  private wireAgent(): void {
    const { agent } = this.runtime;

    this.bubbles = bubblesFromMessages(agent.messages);
    this.transcript.setBubbles(this.bubbles);

    this.offAgent = agent.on((event: AgentEvent) => {
      this.handleAgentEvent(event);
    });

    this.statusTick = setInterval(() => {
      if (this.turnStart !== null) {
        this.updateStatus();
        this.tui.requestRender();
      }
    }, 1000);
  }

  private persistMessage(message: { id: string; role: string; parts: unknown[] }): void {
    void this.runtime.sessions
      .appendMessage(this.runtime.sessionId, structuredClone(message as never))
      .catch(() => undefined);
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "user_message_added":
      case "assistant_finished":
        this.persistMessage(event.message);
        break;

      case "status_changed":
        if (event.status === "streaming") this.turnStart = Date.now();
        if (event.status === "idle" || event.status === "error" || event.status === "aborted") {
          this.turnStart = null;
          void this.runtime.sessions.updateMeta(this.runtime.sessionId, (draft) => {
            draft.messageCount = this.runtime.agent.messages.length;
            draft.totalCostUSD = this.runtime.agent.cost;
            draft.totalUsage = this.runtime.agent.usage;
          });
        }
        this.updateStatus();
        break;

      case "queue_updated":
      case "todo_updated":
      case "usage_updated":
        this.updateStatus();
        break;

      default:
        break;
    }

    this.pendingEvents.push(event);
    if (event.type !== "text_delta" && event.type !== "thinking_delta") {
      this.flushTranscript();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushTranscript(), STREAM_FRAME_MS);
    }
  }

  private flushTranscript(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const events = this.pendingEvents;
    if (events.length === 0) return;
    this.pendingEvents = [];
    this.bubbles = applyAgentEvents(this.bubbles, events);
    this.transcript.setBubbles(this.bubbles);
    this.tui.requestRender();
  }

  private updateStatus(): void {
    const { agent, config } = this.runtime;
    const usage = agent.usage;
    const modelInfo = (() => {
      try {
        return this.runtime.registry.resolveModelInfo(agent.modelReference).model;
      } catch {
        return { contextWindow: 128000 };
      }
    })();

    this.status.update({
      modelRef: agent.modelReference,
      effort: config.loadGlobalSync().effort,
      thinking: config.loadGlobalSync().thinking,
      mode: this.mode,
      inputTokens: usage.inputTokens + usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: agent.cost,
      contextWindow: modelInfo.contextWindow,
      turnMs: this.turnStart,
      sessionMs: Date.now() - this.sessionStart,
      bypass: this.mode === "bypass",
      busy: agent.isRunning,
      mcpConnected: Object.values(config.loadGlobalSync().mcp).filter((server) => server.enabled).length,
      queueDepth: agent.queuedCount,
      cwd: this.runtime.paths.projectRoot
    });
  }

  private wirePermission(): void {
    const { permissionEngine, agent } = this.runtime;

    permissionEngine.setAskHandler(async (request) => {
      return new Promise<PermissionDecision>((resolve) => {
        showPermissionOverlay(this.overlayCtx(), request, (decision) => {
          this.permissionResolver = null;
          resolve(decision);
          agent.emit({ type: "permission_resolved", requestId: request.id, decision });
        });
        agent.emit({ type: "permission_requested", request });
      });
    });
  }

  private permissionResolver: ((decision: PermissionDecision) => void) | null = null;
  private overlayContext: OverlayContext | null = null;

  private wireKeys(): void {
    this.tui.addInputListener((data: string): { consume?: boolean } | undefined => {
      if (matchesKey(data, "ctrl+c")) {
        const now = Date.now();
        if (now - this.lastCtrlC < 1600) {
          void this.stop();
          process.exit(0);
          return;
        }
        this.lastCtrlC = now;
        if (this.runtime.agent.isRunning) {
          this.runtime.agent.abort("ctrl-c");
          this.notice("info", "stopping generation... press Ctrl+C again to quit");
        } else {
          this.notice("info", "press Ctrl+C again to quit");
        }
        return;
      }

      if (this.tui.hasOverlay()) return;
      if (matchesKey(data, "shift+tab")) {
        const currentIndex = MODE_CYCLE.indexOf(this.mode);
        this.setMode(MODE_CYCLE[(currentIndex + 1) % MODE_CYCLE.length]);
        return;
      }

      if (matchesKey(data, "escape")) {
        if (this.tui.hasOverlay()) return;
        if (this.runtime.agent.isRunning) {
          this.runtime.agent.abort("esc");
          this.notice("info", "stopped");
          return;
        }
      }
    });
  }

  private setMode(next: PermissionMode): void {
    this.mode = next;
    this.runtime.agent.setMode(next);
    this.runtime.permissionEngine.setMode(next);
    this.notice("info", `mode: ${next}`);
    this.updateStatus();
    this.tui.requestRender();
  }

  notice(level: "info" | "warn" | "error", text: string): void {
    this.handleAgentEvent({ type: "notice", level, text: text.split("\n")[0] });
  }

  private async handleSubmit(text: string): Promise<void> {
    if (text.startsWith("/")) {
      const result = await this.runtime.commands.dispatch(text, this.buildCommandContext());
      if (result.kind === "notice") this.notice(result.level, result.text);
      return;
    }

    if (this.runtime.agent.isRunning) {
      this.runtime.agent.enqueue(text);
      this.updateStatus();
      this.tui.requestRender();
      return;
    }

    await this.runtime.agent.send(text);
    this.tui.requestRender();
  }

  private buildCommandContext() {
    const runtime = this.runtime;
    return {
      agent: runtime.agent,
      config: runtime.config,
      auth: runtime.auth,
      sessions: runtime.sessions,
      checkpoints: runtime.checkpoints,
      registry: runtime.registry,
      tools: runtime.tools,
      hooks: runtime.hooks,
      paths: runtime.paths,
      t: runtime.translator,
      skills: () => [],
      sessionId: () => runtime.sessionId,
      ui: {
        openModelPicker: () => this.openModelPicker(),
        openSessions: () => this.openSessions(),
        openThemePicker: () => this.openThemePicker(),
        openLangPicker: () => this.openLangPicker(),
        openHelp: () => this.openHelp(),
        openProviderAdd: () => this.openProviderAdd(),
        notice: (level: "info" | "warn" | "error", text: string) => this.notice(level, text),
        requestExit: () => void this.stop(),
        setMode: (next: PermissionMode) => this.setMode(next),
        refreshFileIndex: () => undefined
      }
    };
  }

  private openModelPicker(): void {
    const groups = this.runtime.registry.allModelsGrouped();
    const items = groups.flatMap((group) =>
      group.models.map((model) => ({
        key: `${group.providerId}/${model.id}`,
        label: `${group.providerId}/${model.id}`,
        hint: `${model.label} - ${Math.round(model.contextWindow / 1000)}k`
      }))
    );
    showPickerOverlay(this.overlayCtx(), "Select model", items, (value: string) => {
      if (!value) return;
      this.runtime.agent.setModel(value);
      this.runtime.config.mutateGlobal((draft) => {
        draft.model = value;
      });
      this.notice("info", `model: ${value}`);
    });
  }

  private openSessions(): void {
    void this.runtime.sessions.listSessions().then((all) => {
      const items = all.slice(0, 40).map((meta) => ({
        key: meta.id,
        label: meta.title.slice(0, 50),
        hint: `${new Date(meta.updatedAt).toISOString().slice(5, 16)} - ${meta.messageCount} msg`
      }));
      showPickerOverlay(this.overlayCtx(), "Resume session", items, (id: string) => {
        if (!id) return;
        void this.runtime.sessions.loadMeta(id).then(async (meta) => {
          const messages = meta ? await this.runtime.sessions.loadMessages(id) : [];
          if (meta && messages.length > 0) {
            this.runtime.agent.restoreMessages(messages);
            this.runtime.agent.setModel(`${meta.provider}/${meta.model}`);
            this.bubbles = bubblesFromMessages(messages);
            this.transcript.setBubbles(this.bubbles);
            this.notice("info", `resumed "${meta.title}"`);
          } else {
            this.notice("warn", "session empty or missing");
          }
          this.tui.requestRender();
        });
      });
    });
  }

  private openThemePicker(): void {
    const accents = ["violet", "cyan", "magenta", "green", "yellow", "blue", "red"];
    showPickerOverlay(this.overlayCtx(), "Accent color", accents.map((name) => ({ key: name, label: name })), (value: string) => {
      if (!value) return;
      this.runtime.config.mutateGlobal((draft) => {
        draft.theme.accent = value as never;
      });
      this.notice("info", `accent: ${value} (restart to fully apply)`);
    });
  }

  private openLangPicker(): void {
    showPickerOverlay(
      this.overlayCtx(),
      "Language",
      [
        { key: "en", label: "English" },
        { key: "ru", label: "Русский" }
      ],
      (value: string) => {
        if (!value) return;
        this.runtime.config.mutateGlobal((draft) => {
          draft.language = value as "en" | "ru";
        });
        this.notice("info", `language: ${value} (restart to fully apply)`);
      }
    );
  }

  private openHelp(): void {
    const entries = this.runtime.commands.hints().map((hint) => ({
      key: `/${hint.name}`,
      label: `/${hint.name}`,
      hint: hint.description
    }));
    showPickerOverlay(this.overlayCtx(), "Commands", entries, () => undefined);
  }

  private openProviderAdd(): void {
    const ctx = this.overlayCtx();
    const presets = [
      { key: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", type: "anthropic" as const, needsKey: true, keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-5" },
      { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", type: "openai" as const, needsKey: true, keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5" },
      { key: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", type: "openai" as const, needsKey: true, keyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4.5" },
      { key: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "gemini" as const, needsKey: true, keyEnv: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash" },
      { key: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", type: "openai" as const, needsKey: true, keyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
      { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", type: "openai" as const, needsKey: true, keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
      { key: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", type: "openai" as const, needsKey: false, keyEnv: "", defaultModel: "qwen3-coder" },
      { key: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", type: "openai" as const, needsKey: false, keyEnv: "", defaultModel: "openai/gpt-oss-20b" },
      { key: "__custom__", label: "Custom URL...", baseUrl: "", type: "openai" as const, needsKey: true, keyEnv: "", defaultModel: "" }
    ];

    showPickerOverlay(
      ctx,
      "Add provider - choose a preset",
      presets.map((preset) => ({ key: preset.key, label: preset.label, hint: preset.baseUrl || "any OpenAI/Anthropic-compatible endpoint" })),
      (presetKey) => {
        if (!presetKey) return;
        const preset = presets.find((entry) => entry.key === presetKey);
        if (!preset) return;

        const proceed = (baseUrl: string, providerType: "anthropic" | "openai" | "gemini") => {
          const suggestedId = preset.key === "__custom__" ? this.suggestProviderId(baseUrl) : preset.key;
          showTextInputOverlay(ctx, "Provider id (used as id/model)", { initialValue: suggestedId }, (id) => {
            if (!id) return;
            const envSuggestion = preset.keyEnv || `AXIOM_${id.toUpperCase()}_API_KEY`;

            const finish = (apiKey: string | null, keyEnv: string | null) => {
              this.runtime.config.mutateGlobal((draft) => {
                draft.providers[id] = {
                  type: providerType,
                  baseUrl,
                  ...(apiKey ? { apiKey } : {}),
                  ...(keyEnv ? { keyEnv } : {}),
                  ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {})
                };
              });
              if (apiKey) {
                void this.runtime.auth.setProvider(id, { apiKey }).then(() => {
                  this.runtime.registry.invalidateAdapter(id);
                  this.notice("info", `provider "${id}" saved (${providerType}) - switch with /model ${id}/<model>`);
                });
              } else {
                this.runtime.registry.invalidateAdapter(id);
                this.notice("info", `provider "${id}" saved, key read from ${keyEnv}`);
              }
            };

            if (!preset.needsKey) {
              finish(null, null);
              return;
            }

            showTextInputOverlay(ctx, `API key for ${id} (empty = use ${envSuggestion})`, {}, (key) => {
              if (key) finish(key, null);
              else finish(null, envSuggestion);
            });
          });
        };

        if (preset.key === "__custom__") {
          showTextInputOverlay(ctx, "Base URL (https://host/v1)", {}, (url) => {
            if (!url) return;
            let normalized = url;
            if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
            const type = /anthropic/i.test(normalized)
              ? ("anthropic" as const)
              : /generativelanguage|googleapis/i.test(normalized)
                ? ("gemini" as const)
                : ("openai" as const);
            proceed(normalized, type);
          });
          return;
        }

        proceed(preset.baseUrl, preset.type);
      }
    );
  }

  private suggestProviderId(url: string): string {
    try {
      const candidate = /^https?:\/\//i.test(url) ? url : `http://${url}`;
      const host = new URL(candidate).hostname.replace(/^www\./, "");
      const parts = host.split(".");
      const core = parts.length > 2 ? parts[parts.length - 2] : parts[0];
      const cleaned = (core ?? "custom").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
      return cleaned.length > 0 ? cleaned : "custom";
    } catch {
      return "custom";
    }
  }

  async start(): Promise<void> {
    this.tui.start();
    this.updateStatus();
    this.tui.requestRender();
    await new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
  }

  private resolveStop: (() => void) | null = null;

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offAgent?.();
    if (this.statusTick) clearInterval(this.statusTick);
    await this.runtime.hooks.runSessionEnd({ sessionId: this.runtime.sessionId }).catch(() => undefined);
    await this.runtime.mcp?.shutdown().catch(() => undefined);
    await this.runtime.lsp?.shutdownAll().catch(() => undefined);
    this.tui.stop();
    this.resolveStop?.();
  }
}
