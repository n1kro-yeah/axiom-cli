import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
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

export function InputPanel(props: InputPanelProps): React.ReactElement {
  const { theme } = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const draftBeforeHistory = useRef<string>("");

  useEffect(() => {
    updatePopup(value, cursor);
  }, [value, cursor]);

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
          items: ranked.map((entry) => ({
            label: entry.item,
            insert: entry.item
          })),
          selected: 0
        });
        return;
      }
    }

    setPopup(null);
  }

  function acceptPopupItem(state: PopupState): void {
    const item = state.items[state.selected];
    if (!item) {
      setPopup(null);
      return;
    }

    if (state.kind === "slash") {
      setValue(`${item.insert} `);
      setCursor(item.insert.length + 1);
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
        setValue(replacementBase);
        setCursor(replacementBase.length);
      } else {
        const nextValue = `${replacementBase}@${quoted}${trailing}`;
        setValue(nextValue);
        setCursor(atMatch.index + 1 + quoted.length);
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

    setValue("");
    setCursor(0);
    setHistoryIndex(null);
    draftBeforeHistory.current = "";
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
        setValue(draftBeforeHistory.current);
        setCursor(draftBeforeHistory.current.length);
        return;
      }
    }

    const entry = props.history[index] ?? "";
    setHistoryIndex(index);
    setValue(entry);
    setCursor(entry.length);
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
          setValue("");
          setCursor(0);
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
          setValue((current) => current.slice(0, cursor - 1) + current.slice(cursor));
          setCursor((current) => Math.max(current - 1, 0));
        }
        return;
      }
      if (key.backspace || key.delete) {
        setValue((current) => current.slice(0, cursor) + current.slice(cursor + 1));
        return;
      }

      if (key.ctrl && input === "v") {
        props.onPasteImage();
        return;
      }
      if (key.ctrl && input === "u") {
        setValue("");
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "k") {
        setValue((current) => current.slice(0, cursor));
        return;
      }
      if (key.ctrl && input === "w") {
        setValue((current) => {
          const left = current.slice(0, cursor).replace(/\S+\s*$/, "");
          const next = left + current.slice(cursor);
          setCursor(left.length);
          return next;
        });
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
        setValue((current) => current.slice(0, cursor) + printable + current.slice(cursor));
        setCursor((current) => current + printable.length);
      }
    },
    { isActive: !props.overlayOpen }
  );

  const renderedInput = useMemo(() => renderWithCursor(value, cursor), [value, cursor]);

  const showBusyLine = props.busy && !props.waitingPermission;

  return (
    <Box flexDirection="column">
      {popup ? (
        <Box flexDirection="column" marginBottom={0}>
          {popup.items.map((item, index) => (
            <Box key={`${item.label}_${index}`} paddingLeft={index === popup.selected ? 0 : 2}>
              <Text color={index === popup.selected ? theme.accentBright : theme.textSecondary}>
                {index === popup.selected ? "▸ " : "  "}
                {item.label}
              </Text>
              {item.hint ? <Text dimColor> {item.hint}</Text> : null}
            </Box>
          ))}
          <Text dimColor> tab/enter complete · esc dismiss</Text>
        </Box>
      ) : null}

      <Box borderStyle="round" borderColor={props.waitingPermission ? theme.warning : props.busy ? theme.borderActive : theme.border} paddingX={1}>
        <Box width="100%" flexDirection="row" flexWrap="wrap">
          <Text color={theme.accentBright} bold>
            {"› "}
          </Text>
          {value.length === 0 && !showBusyLine ? (
            <Text dimColor>{props.placeholder ?? "Ask anything… (/commands · @files)"}</Text>
          ) : (
            <Text wrap="wrap">{renderedInput}</Text>
          )}
        </Box>
      </Box>

      {props.attachments.length > 0 ? (
        <Box paddingLeft={2} gap={1} flexWrap="wrap">
          {props.attachments.map((chip) => (
            <Text key={chip.id} color={theme.info}>
              [{chip.kind === "image" ? "🖼" : "≡"} {chip.label}]
            </Text>
          ))}
          <Text dimColor>(esc clears input · they attach on send)</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function renderWithCursor(value: string, cursor: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  if (value.length === 0) {
    nodes.push(<Text key="cursor">▌</Text>);
    return nodes;
  }

  const head = value.slice(0, cursor);
  const cursorChar = value[cursor] ?? "";
  const tail = value.slice(cursor + (cursorChar ? 1 : 0));

  if (head) nodes.push(<React.Fragment key="head">{head}</React.Fragment>);
  if (cursorChar) {
    nodes.push(
      <Text key="cursorchar" inverse>
        {cursorChar}
      </Text>
    );
  } else {
    nodes.push(<Text key="endcursor">▌</Text>);
  }
  if (tail) nodes.push(<React.Fragment key="tail">{tail}</React.Fragment>);

  return nodes;
}

export function pushInputHistory(history: string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return history;
  const filtered = history.filter((existing) => existing !== trimmed);
  filtered.push(trimmed);
  return filtered.slice(-MAX_HISTORY);
}
