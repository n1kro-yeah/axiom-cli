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
  const slice = filtered.slice(Math.max(start, 0), Math.max(start, 0) + visible);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color={theme.textPrimary}>
          {props.title}
        </Text>
        {props.filterable && filter.length > 0 ? (
          <Text dimColor>/{filter}</Text>
        ) : null}
      </Box>

      <Box flexDirection="column" marginTop={0} marginBottom={0}>
        {slice.map((option, index) => {
          const absoluteIndex = Math.max(start, 0) + index;
          const selected = absoluteIndex === cursor;

          if (!option.hint) {
            return (
              <Box key={`${option.value}_${index}`} width="100%">
                <Text color={selected ? theme.accentBright : theme.textSecondary} bold={selected}>
                  {selected ? "> " : "  "}
                  {option.label}
                </Text>
              </Box>
            );
          }

          return (
            <Box key={`${option.value}_${index}`} width="100%" justifyContent="space-between">
              <Text color={selected ? theme.accentBright : theme.textSecondary} bold={selected}>
                {selected ? "> " : "  "}
                {option.label}
              </Text>
              <Text color={selected ? theme.textSecondary : theme.textFaint}>{option.hint}</Text>
            </Box>
          );
        })}

        {slice.length === 0 ? <Text dimColor>{"  no matches"}</Text> : null}
      </Box>

      <Box marginTop={0}>
        <Text dimColor>
          up/down navigate · enter select{props.filterable ? " · type to filter" : ""} · esc close
        </Text>
      </Box>
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
    <Box flexDirection="column" paddingLeft={2} paddingRight={1} paddingY={0}>
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
            <Box key={entryIndex} width="100%" justifyContent="space-between">
              <Text color={theme.textPrimary}>{entry.description}</Text>
              <Text color={theme.success}>{entry.keys}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Text dimColor>esc/q close</Text>
    </Box>
  );
}
