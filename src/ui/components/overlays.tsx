import React, { useEffect, useState } from "react";
import { OverlayPicker } from "./overlay-picker.js";
import type { PickerOption } from "./overlay-picker.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { SessionStore } from "../../session/store.js";

interface ModelPickerOverlayProps {
  registry: ProviderRegistry;
  current: string;
  onClose: () => void;
  onSelect: (value: string) => void;
}

export function ModelPickerOverlay(props: ModelPickerOverlayProps): React.ReactElement {
  const groups = props.registry.allModelsGrouped();
  const options: PickerOption[] = [];

  for (const group of groups) {
    for (const model of group.models) {
      const value = `${group.providerId}/${model.id}`;
      options.push({
        label: value,
        hint: `${model.label} · ${Math.round(model.contextWindow / 1000)}k${model.recommended ? "  *" : ""}`,
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

export function SessionsPickerOverlay(props: SessionsPickerOverlayProps): React.ReactElement {
  const [options, setOptions] = useState<PickerOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void props.sessions.listSessions().then((all) => {
      if (cancelled) return;
      setOptions(
        all.slice(0, 40).map((meta) => ({
          label: meta.title.slice(0, 50),
          hint: `${new Date(meta.updatedAt).toISOString().slice(5, 16)} · ${meta.messageCount} msg · $${meta.totalCostUSD.toFixed(3)}`,
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
