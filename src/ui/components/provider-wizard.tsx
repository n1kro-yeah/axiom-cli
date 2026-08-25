import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme.js";
import { OverlayPicker } from "./overlay-picker.js";
import type { PickerOption } from "./overlay-picker.js";
import { TextInput, validateName, validateNonEmpty, validateUrl } from "./text-input.js";

export interface ProviderWizardProps {
  knownProviderIds: string[];
  onSubmit: (draft: ProviderDraft) => Promise<string | null>;
  onCancel: () => void;
}

export interface ProviderDraft {
  id: string;
  type: "anthropic" | "openai" | "gemini";
  baseUrl: string;
  apiKey?: string;
  keyEnv?: string;
  defaultModel?: string;
}

type Step =
  | { kind: "preset" }
  | { kind: "url"; preset: PresetEntry }
  | { kind: "id"; preset: PresetEntry; url: string }
  | { kind: "key"; preset: PresetEntry; url: string; id: string }
  | { kind: "model"; draft: ProviderDraft }
  | { kind: "verifying"; draft: ProviderDraft; model: string | undefined };

interface PresetEntry {
  label: string;
  value: string;
  baseUrl: string;
  providerType: "anthropic" | "openai" | "gemini";
  needsKey: boolean;
  keyEnv?: string;
  defaultModel?: string;
}

const PRESETS: PresetEntry[] = [
  { label: "Anthropic", value: "anthropic", baseUrl: "https://api.anthropic.com", providerType: "anthropic", needsKey: true, keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-5" },
  { label: "OpenAI", value: "openai", baseUrl: "https://api.openai.com/v1", providerType: "openai", needsKey: true, keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5" },
  { label: "OpenRouter", value: "openrouter", baseUrl: "https://openrouter.ai/api/v1", providerType: "openai", needsKey: true, keyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4.5" },
  { label: "Google Gemini", value: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", providerType: "gemini", needsKey: true, keyEnv: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash" },
  { label: "Groq", value: "groq", baseUrl: "https://api.groq.com/openai/v1", providerType: "openai", needsKey: true, keyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
  { label: "DeepSeek", value: "deepseek", baseUrl: "https://api.deepseek.com/v1", providerType: "openai", needsKey: true, keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
  { label: "Ollama (local)", value: "ollama", baseUrl: "http://localhost:11434/v1", providerType: "openai", needsKey: false, defaultModel: "qwen3-coder" },
  { label: "LM Studio (local)", value: "lmstudio", baseUrl: "http://localhost:1234/v1", providerType: "openai", needsKey: false, defaultModel: "openai/gpt-oss-20b" },
  { label: "Custom URL…", value: "__custom__", baseUrl: "", providerType: "openai", needsKey: true }
];

export function detectProviderType(url: string): "anthropic" | "openai" | "gemini" {
  const lowered = url.toLowerCase();
  if (lowered.includes("anthropic")) return "anthropic";
  if (lowered.includes("generativelanguage") || lowered.includes("googleapis")) return "gemini";
  return "openai";
}

export function suggestProviderId(url: string): string {
  try {
    const candidate = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    const host = new URL(candidate).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const core = parts.length > 2 ? parts.slice(-2)[0] : parts[0];
    const cleaned = (core ?? "custom").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    return cleaned.length > 0 ? cleaned : "custom";
  } catch {
    return "custom";
  }
}

async function probeConnection(
  url: string,
  providerType: "anthropic" | "openai" | "gemini",
  apiKey: string | undefined,
  timeoutMs = 8000
): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (providerType === "openai") {
      const headers: Record<string, string> = { accept: "application/json" };
      if (apiKey && apiKey.trim().length > 0) headers["authorization"] = `Bearer ${apiKey.trim()}`;

      let response = await fetch(`${url.replace(/\/$/, "")}/models`, { headers, signal: controller.signal });
      if (!response.ok && response.status === 404) {
        response = await fetch(url.replace(/\/$/, ""), { headers, signal: controller.signal });
      }

      if (response.ok) {
        const text = await response.text();
        let modelCount = 0;
        try {
          const parsed = JSON.parse(text) as { data?: unknown[] };
          if (Array.isArray(parsed.data)) modelCount = parsed.data.length;
        } catch {
        }
        return { ok: true, detail: modelCount > 0 ? `connected · ${modelCount} models listed` : "connected" };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: `auth rejected (HTTP ${response.status}) — check the API key` };
      }
      return { ok: false, detail: `HTTP ${response.status}` };
    }

    if (providerType === "anthropic") {
      const response = await fetch(`${url.replace(/\/$/, "")}/v1/models`, {
        headers: {
          "x-api-key": (apiKey ?? "").trim(),
          "anthropic-version": "2023-06-01"
        },
        signal: controller.signal
      });
      if (response.ok) return { ok: true, detail: "connected · anthropic reachable" };
      if (response.status === 401) return { ok: false, detail: "invalid API key (HTTP 401)" };
      return { ok: false, detail: `HTTP ${response.status}` };
    }

    const probeUrl = `${url.replace(/\/$/, "")}/models?key=${encodeURIComponent((apiKey ?? "").trim())}`;
    const response = await fetch(probeUrl, { signal: controller.signal });
    if (response.ok) return { ok: true, detail: "connected · gemini reachable" };
    if (response.status === 400 || response.status === 403) return { ok: false, detail: "API key rejected by Google" };
    return { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: /abort/i.test(message) ? `no answer within ${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

export function ProviderWizard(props: ProviderWizardProps): React.ReactElement {
  const { theme } = useTheme();
  const [step, setStep] = useState<Step>({ kind: "preset" });
  const [noticeText, setNoticeText] = useState<string | null>(null);

  const presetOptions = useMemo<PickerOption[]>(() => {
    return PRESETS.map((preset) => ({
      label: preset.label,
      hint:
        preset.value === "__custom__"
          ? "any OpenAI-compatible / Anthropic-compatible endpoint"
          : preset.baseUrl.replace(/^https?:\/\//, ""),
      value: preset.value
    }));
  }, []);

  function finish(draft: ProviderDraft): void {
    setStep({ kind: "verifying", draft, model: draft.defaultModel });

    void (async () => {
      const savedError = await props.onSubmit(draft);
      if (savedError) {
        setNoticeText(`save failed: ${savedError}`);
        setStep({ kind: "key", preset: PRESETS.find((entry) => entry.label === draft.id) ?? { ...PRESETS[PRESETS.length - 1], label: draft.id }, url: draft.baseUrl, id: draft.id });
        return;
      }

      const probe = await probeConnection(draft.baseUrl, draft.type, draft.apiKey);
      if (probe.ok) {
        setNoticeText(`✓ ${draft.id} added and verified (${probe.detail}). Switch with /model ${draft.id}/<model>.`);
        props.onCancel();
      } else {
        setNoticeText(`saved "${draft.id}", but the endpoint did not respond: ${probe.detail}`);
        props.onCancel();
      }
    })();
  }

  if (step.kind === "verifying") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.overlayBorder} paddingX={1}>
        <Text color={theme.accentBright}>saving & probing {step.draft.baseUrl} …</Text>
      </Box>
    );
  }

  if (step.kind === "preset") {
    return (
      <Box flexDirection="column">
        <OverlayPicker
          title="Add provider — choose a preset"
          options={presetOptions}
          filterable
          visibleCount={11}
          onSelect={(value) => {
            const preset = PRESETS.find((entry) => entry.value === value);
            if (!preset) return;
            if (preset.value === "__custom__") {
              setStep({ kind: "url", preset });
            } else {
              setStep({ kind: "id", preset, url: preset.baseUrl });
            }
          }}
          onClose={props.onCancel}
        />
        {noticeText ? <Text color={theme.warning}>{noticeText}</Text> : null}
      </Box>
    );
  }

  if (step.kind === "url") {
    return (
      <Box flexDirection="column" gap={0}>
        <TextInput
          label={`Base URL for ${step.preset.label}`}
          placeholder="https://host:port/v1"
          hint="enter confirm · esc back · protocol auto-detects anthropic/gemini/openai from the URL"
          active
          validator={validateUrl}
          onSubmit={(value) => {
            let normalized = value.trim();
            if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
            const detected = detectProviderType(normalized);
            setStep({
              kind: "id",
              url: normalized,
              preset: {
                ...step.preset,
                providerType: detected,
                needsKey: detected !== "openai" || !/localhost|127\.0\.0\.1/.test(normalized)
              }
            });
          }}
          onCancel={() => setStep({ kind: "preset" })}
        />
      </Box>
    );
  }

  if (step.kind === "id") {
    const suggestedId = step.preset.value === "__custom__" ? suggestProviderId(step.url) : step.preset.value;
    return (
      <TextInput
        label="Provider id (used in /model as id/model-name)"
        placeholder={suggestedId}
        initialValue={suggestedId}
        active
        validator={(value) => validateName(value)}
        hint={
          props.knownProviderIds.includes(suggestedId)
            ? "⚠ this id already exists and will be overwritten"
            : "enter confirm · esc back"
        }
        onSubmit={(value) =>
          setStep({ kind: "key", preset: step.preset, url: step.url, id: value.trim().toLowerCase() })
        }
        onCancel={() =>
          step.preset.value === "__custom__"
            ? setStep({ kind: "url", preset: step.preset })
            : setStep({ kind: "preset" })
        }
      />
    );
  }

  if (step.kind === "key") {
    if (!step.preset.needsKey) {
      return (
        <Box flexDirection="column">
          <Text dimColor>
            {" "}
            {step.preset.label} needs no API key.
          </Text>
          <KeylessConfirm
            onConfirm={() =>
              finish({
                id: step.id,
                type: step.preset.providerType,
                baseUrl: step.url,
                defaultModel: step.preset.defaultModel
              })
            }
            onBack={() => setStep({ kind: "id", preset: step.preset, url: step.url })}
          />
        </Box>
      );
    }

    const envSuggestion = step.preset.keyEnv ?? `AXIOM_${step.id.toUpperCase()}_API_KEY`;

    return (
      <Box flexDirection="column">
        <TextInput
          label={`API key for ${step.id}`}
          mask
          placeholder={`paste key, or press enter to use $${envSuggestion}`}
          hint="input is masked · empty + enter stores a keyEnv reference instead of a literal key"
          active
          validator={(value) => (value.trim().length === 0 ? null : validateNonEmpty(value))}
          onSubmit={(value) => {
            const trimmed = value.trim();
            const draft: ProviderDraft = {
              id: step.id,
              type: step.preset.providerType,
              baseUrl: step.url,
              defaultModel: step.preset.defaultModel
            };
            if (trimmed.length > 0) draft.apiKey = trimmed;
            else draft.keyEnv = envSuggestion;
            setStep({ kind: "model", draft });
          }}
          onCancel={() => setStep({ kind: "id", preset: step.preset, url: step.url })}
        />
      </Box>
    );
  }

  if (step.kind === "model") {
    return (
      <TextInput
        label="Default model id (optional)"
        placeholder={step.draft.defaultModel ?? "e.g. gpt-5 or meta-llama/Llama-3-70b"}
        initialValue={step.draft.defaultModel ?? ""}
        active
        hint="enter to keep suggestion · esc back · you can always switch later via /model"
        onSubmit={(value) => {
          const draft = { ...step.draft };
          const modelValue = value.trim();
          draft.defaultModel = modelValue.length > 0 ? modelValue : undefined;
          finish(draft);
        }}
        onCancel={() =>
          setStep({ kind: "key", preset: PRESETS.find((entry) => entry.value === step.draft.id) ?? { ...PRESETS[8], label: step.draft.id }, url: step.draft.baseUrl, id: step.draft.id })
        }
      />
    );
  }

  return (
    <Box borderStyle="round" borderColor={theme.danger} paddingX={1}>
      <Text color={theme.danger}>wizard state error — press esc</Text>
    </Box>
  );
}

function KeylessConfirm({ onConfirm, onBack }: { onConfirm: () => void; onBack: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.return) onConfirm();
    else if (key.escape) onBack();
  });
  const { theme } = useTheme();

  return (
    <Box gap={2}>
      <Text>
        <Text bold color={theme.success}>
          [enter]
        </Text>{" "}
        save
      </Text>
      <Text>
        <Text bold>[esc]</Text> back
      </Text>
    </Box>
  );
}
