import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { rankByFuzzy } from "../../util/fuzzy.js";
import { useTheme } from "../theme.js";

export interface SlashCommandHint {
  name: string;
  description: string;
}

export interface AttachmentChip {
  id: string;
  label: string;
  kind: "image" | "text";
}

export interface InputPanelProps {
  busy: boolean;
  waitingPermission: boolean;
  history: string[];
  slashCommands: SlashCommandHint[];
  getFileSuggestions: () => string[];
  attachments: AttachmentChip[];
  pendingCount: number;
  hint?: string;
  onAddPathAttachment: (path: string) => void;
  onClearAttachments: () => void;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onPasteImage: () => void;
  onOpenHelp: () => void;
  overlayOpen: boolean;
  placeholder?: string;
}

interface PopupState {
  kind: "slash" | "file";
  items: Array<{ label: string; hint?: string; insert: string }>;
  selected: number;
}

const MAX_HISTORY = 300;
const SUGGESTION_WINDOW = 6;

function characters(value: string): string[] {
  return [...value];
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function InputPanel(props: InputPanelProps): React.ReactElement {
  const { theme } = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const historyDraft = useRef("");
  const draftBeforeHistory = useRef("");

  const valueChars = characters(value);

  useEffect(() => {
    setCursor((current) => clampValue(current, 0, valueChars.length));
  }, [value.length]);

  function updatePopup(currentValue: string, currentCursor: number): void {
    const beforeCursorText = currentValue.slice(0, currentCursor);

    if (beforeCursorText.startsWith("/") && !beforeCursorText.includes(" ")) {
      const query = beforeCursorText.slice(1).toLowerCase();
      const matches = props.slashCommands
        .filter((command) => command.name.startsWith(query))
        .slice(0, 8)
        .map((command) => ({
          label: `/${command.name}`,
          hint: command.description,
          insert: `/${command.name}`
        }));
      setPopup(matches.length > 0 ? { kind: "slash", items: matches, selected: 0 } : null);
      return;
    }

    const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursorText);
    if (atMatch) {
      const query = atMatch[1] ?? "";
      const suggestions = props.getFileSuggestions();
      const ranked = rankByFuzzy(suggestions, query, (item) => item, 8);
      if (ranked.length > 0) {
        setPopup({
          kind: "file",
          items: ranked.map((entry) => ({ label: entry.item, insert: entry.item })),
          selected: 0
        });
        return;
      }
    }

    setPopup(null);
  }

  function change(next: string, nextCursor?: number): void {
    setValue(next);
    setCursor(nextCursor ?? characters(next).length);
    setHistoryIndex(null);
    historyDraft.current = next;
  }

  function acceptPopupItem(state: PopupState): void {
    const item = state.items[state.selected];
    if (!item) {
      setPopup(null);
      return;
    }

    if (state.kind === "slash") {
      change(`${item.insert} `);
      setPopup(null);
      return;
    }

    const beforeCursorText = value.slice(0, cursor);
    const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursorText);
    if (atMatch && atMatch.index !== undefined) {
      const replacementBase = value.slice(0, atMatch.index);
      const trailing = value.slice(cursor);
      const quoted = item.insert.includes(" ") ? `"${item.insert}"` : item.insert;

      if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(item.insert)) {
        props.onAddPathAttachment(item.insert);
        change(replacementBase, replacementBase.length);
      } else {
        change(`${replacementBase}@${quoted}${trailing}`, atMatch.index + 1 + quoted.length);
      }
    }
    setPopup(null);
  }

  function submit(): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    if (props.attachments.length > 0) {
      const attachmentNote = props.attachments
        .map((chip) => `[attachment ${chip.kind}: ${chip.label}]`)
        .join(" ");
      props.onSubmit(`${trimmed}\n${attachmentNote}`);
      props.onClearAttachments();
    } else {
      props.onSubmit(trimmed);
    }

    change("");
    setPopup(null);
  }

  function navigateHistory(direction: 1 | -1): void {
    if (props.history.length === 0) return;

    let index: number;
    if (historyIndex === null) {
      if (direction === 1) return;
      draftBeforeHistory.current = value;
      index = props.history.length - 1;
    } else {
      index = historyIndex + direction;
      if (index >= props.history.length) return;
      if (index < 0) {
        setHistoryIndex(null);
        change(draftBeforeHistory.current, draftBeforeHistory.current.length);
        return;
      }
    }

    const entry = props.history[index] ?? "";
    setHistoryIndex(index);
    change(entry, entry.length);
  }

  useInput(
    (input, key) => {
      if (key.upArrow) {
        if (popup) {
          setPopup({ ...popup, selected: (popup.selected - 1 + popup.items.length) % popup.items.length });
        } else {
          navigateHistory(-1);
        }
        return;
      }
      if (key.downArrow) {
        if (popup) {
          setPopup({ ...popup, selected: (popup.selected + 1) % popup.items.length });
        } else {
          navigateHistory(1);
        }
        return;
      }
      if (key.tab && popup) {
        acceptPopupItem(popup);
        return;
      }
      if (key.escape) {
        if (popup) {
          setPopup(null);
          return;
        }
        if (value.length > 0) {
          change("");
          return;
        }
        props.onAbort();
        return;
      }
      if (key.return) {
        if (popup) {
          acceptPopupItem(popup);
          return;
        }
        submit();
        return;
      }
      if (key.leftArrow) {
        setCursor((current) => Math.max(current - 1, 0));
        return;
      }
      if (key.rightArrow) {
        setCursor((current) => Math.min(current + 1, value.length));
        return;
      }
      if ((key.backspace || key.delete) && !key.meta) {
        if (cursor > 0) {
          const chars = characters(value);
          chars.splice(cursor - 1, 1);
          change(chars.join(""), cursor - 1);
        }
        return;
      }
      if (key.backspace || key.delete) {
        const chars = characters(value);
        chars.splice(cursor, 1);
        change(chars.join(""), cursor);
        return;
      }

      if (key.ctrl && input === "v") {
        props.onPasteImage();
        return;
      }
      if (key.ctrl && input === "u") {
        change("");
        return;
      }
      if (key.ctrl && input === "k") {
        change(value.slice(0, cursor), cursor);
        return;
      }
      if (key.ctrl && input === "w") {
        const left = value.slice(0, cursor).replace(/\S+\s*$/, "");
        change(left + value.slice(cursor), left.length);
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }

      if (input && !key.ctrl && !key.meta && input.length >= 1) {
        const printable = input.replace(/[\r\n]/g, "");
        if (printable.length === 0) return;
        const chars = characters(value);
        chars.splice(cursor, 0, ...characters(printable));
        change(chars.join(""), cursor + characters(printable).length);
      }
    },
    { isActive: !props.overlayOpen }
  );

  useEffect(() => {
    updatePopup(value, cursor);
  }, [value, cursor]);

  const suggestions = useMemo(() => {
    if (!popup) return [] as PopupState["items"];
    return popup.items;
  }, [popup]);

  const suggestionStart = Math.max(
    0,
    Math.min((popup?.selected ?? 0) - SUGGESTION_WINDOW + 2, suggestions.length - SUGGESTION_WINDOW)
  );
  const visibleSuggestions = suggestions.slice(suggestionStart, suggestionStart + SUGGESTION_WINDOW);

  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box
        width="100%"
        borderStyle="round"
        borderColor={props.waitingPermission ? theme.warning : props.busy ? theme.border : theme.accent}
        borderDimColor={props.busy && !props.waitingPermission}
        paddingX={1}
      >
        <Text color={props.busy ? "gray" : theme.accent}>{"> "} </Text>
        <EditableText value={value} cursor={cursor} placeholder={props.placeholder ?? "ask anything"} />
        {props.pendingCount > 0 ? <Text dimColor> · {props.pendingCount} queued</Text> : null}
      </Box>

      {props.attachments.length > 0 ? (
        <Text dimColor>
          {"  "}+ {props.attachments.map((chip) => chip.label).join(" · ")}
        </Text>
      ) : null}

      {props.busy && props.hint ? <Text dimColor>{"  "}{props.hint}</Text> : null}

      {popup && visibleSuggestions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {visibleSuggestions.map((item, index) => {
            const selected = suggestionStart + index === popup.selected;
            return (
              <Text key={`${item.label}_${index}`} color={selected ? theme.accent : undefined} dimColor={!selected}>
                {selected ? "> " : "  "}
                {item.label}
                {item.hint ? <Text dimColor> - {item.hint}</Text> : null}
              </Text>
            );
          })}
          {suggestions.length > visibleSuggestions.length ? (
            <Text dimColor>... {suggestions.length - visibleSuggestions.length} more</Text>
          ) : null}
          <Text dimColor>tab/enter complete · esc dismiss</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function EditableText({
  value,
  cursor,
  placeholder
}: {
  value: string;
  cursor: number;
  placeholder: string;
}): React.ReactElement {
  const chars = characters(value);
  const at = clampValue(cursor, 0, chars.length);

  if (chars.length === 0) {
    const placeholderChars = characters(placeholder);
    return (
      <Text>
        <Text inverse>{placeholderChars[0] ?? " "}</Text>
        <Text color="gray">{placeholderChars.slice(1).join("")}</Text>
      </Text>
    );
  }

  return (
    <Text wrap="wrap">
      {chars.slice(0, at).join("")}
      <Text inverse>{chars[at] ?? " "}</Text>
      {chars.slice(at + 1).join("")}
    </Text>
  );
}

export function pushInputHistory(history: string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return history;
  const filtered = history.filter((existing) => existing !== trimmed);
  filtered.push(trimmed);
  return filtered.slice(-MAX_HISTORY);
}
