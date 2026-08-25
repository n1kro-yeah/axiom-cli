import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { rankByFuzzy } from "../../util/fuzzy.js";
import { useTheme } from "../theme.js";

export interface PickerOption {
  label: string;
  hint?: string;
  value: string;
}

export interface OverlayPickerProps {
  title: string;
  options: PickerOption[];
  onSelect: (value: string) => void;
  onClose: () => void;
  filterable: boolean;
  visibleCount?: number;
}

export function OverlayPicker(props: OverlayPickerProps): React.ReactElement {
  const { theme } = useTheme();
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const visible = props.visibleCount ?? 12;

  const filtered = useMemo(() => {
    if (!props.filterable || filter.trim().length === 0) return props.options.slice(0, 200);
    const ranked = rankByFuzzy(props.options, filter.trim(), (option) => option.label, 60);
    return ranked.map((entry) => entry.item);
  }, [filter, props.filterable, props.options]);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((current) => (current <= 0 ? filtered.length - 1 : current - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => (current >= filtered.length - 1 ? 0 : current + 1));
      return;
    }
    if (key.return) {
      const chosen = filtered[cursor];
      if (chosen) props.onSelect(chosen.value);
      else props.onClose();
      return;
    }
    if (key.escape) {
      props.onClose();
      return;
    }
    if (!props.filterable) return;

    if (key.backspace || key.delete) {
      setFilter((current) => current.slice(0, -1));
      return;
    }
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      setFilter((current) => current + input);
    }
  });

  const start = Math.max(Math.min(cursor - Math.floor(visible / 2), filtered.length - visible), 0);
  const slice = filtered.slice(start, start + visible);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.overlayBorder}
      paddingX={1}
      marginBottom={0}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.accentBright}>
          {props.title}
        </Text>
        <Text dimColor>
          {filtered.length} items{props.filterable && filter.length > 0 ? ` · "${filter}"` : ""}
        </Text>
      </Box>

      <Box flexDirection="column" marginY={0}>
        {slice.map((option, index) => {
          const absoluteIndex = start + index;
          const selected = absoluteIndex === cursor;
          return (
            <Box key={`${option.value}_${index}`} paddingLeft={selected ? 0 : 2}>
              <Text color={selected ? theme.accentBright : theme.textPrimary}>
                {selected ? "▸ " : "  "}
                {option.label}
              </Text>
              {option.hint ? <Text dimColor> {option.hint}</Text> : null}
            </Box>
          );
        })}
        {slice.length === 0 ? <Text dimColor> no matches</Text> : null}
      </Box>

      <Text dimColor>
        ↑↓ navigate · enter select · esc close{props.filterable ? " · type to filter" : ""}
      </Text>
    </Box>
  );
}

export interface HelpOverlayEntry {
  keys: string;
  description: string;
}

export interface HelpOverlayProps {
  title: string;
  sections: Array<{ heading: string; entries: HelpOverlayEntry[] }>;
  onClose: () => void;
}

export function HelpOverlay(props: HelpOverlayProps): React.ReactElement {
  const { theme } = useTheme();

  useInput((_input, key) => {
    if (key.escape || key.return || _input === "q") props.onClose();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.overlayBorder} paddingX={2} paddingY={1}>
      <Text bold color={theme.accentBright}>
        {props.title}
      </Text>
      <Text> </Text>
      {props.sections.map((section, sectionIndex) => (
        <Box key={sectionIndex} flexDirection="column" marginBottom={1}>
          <Text bold color={theme.accent}>
            {section.heading}
          </Text>
          {section.entries.map((entry, entryIndex) => (
            <Box key={entryIndex} gap={2}>
              <Box width={22}>
                <Text color={theme.success}>{entry.keys}</Text>
              </Box>
              <Text>{entry.description}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Text dimColor>esc/q close</Text>
    </Box>
  );
}
