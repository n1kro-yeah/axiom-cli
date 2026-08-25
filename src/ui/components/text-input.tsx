import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme.js";

export interface TextInputProps {
  label?: string;
  placeholder?: string;
  initialValue?: string;
  mask?: boolean;
  validator?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  active: boolean;
  hint?: string;
}

interface CursorRender {
  before: string;
  cursorChar: string;
  after: string;
  cursorAtEnd: boolean;
}

export function TextInput(props: TextInputProps): React.ReactElement {
  const { theme } = useTheme();
  const [value, setValue] = useState(props.initialValue ?? "");
  const [cursor, setCursor] = useState((props.initialValue ?? "").length);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    setErrorText(null);
  }, [value]);

  function submit(): void {
    const trimmed = value.trim();
    if (!props.mask || trimmed.length > 0 || props.placeholder === undefined) {
      if (props.validator) {
        const problem = props.validator(trimmed);
        if (problem) {
          setErrorText(problem);
          return;
        }
      }
    }
    props.onSubmit(trimmed);
    setValue("");
    setCursor(0);
  }

  useInput(
    (input, key) => {
      if (key.return) {
        submit();
        return;
      }
      if (key.escape) {
        props.onCancel();
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
      if (key.ctrl && input === "u") {
        setValue("");
        setCursor(0);
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

      if (input && !key.ctrl && !key.meta) {
        const printable = input.replace(/[\r\n]/g, "");
        if (printable.length === 0) return;
        setValue((current) => current.slice(0, cursor) + printable + current.slice(cursor));
        setCursor((current) => current + printable.length);
      }
    },
    { isActive: props.active }
  );

  const display = props.mask ? "*".repeat(value.length) : value;
  const render = buildCursorRender(display, cursor);

  return (
    <Box flexDirection="column">
      {props.label ? (
        <Text bold color={theme.accentBright}>
          {props.label}
        </Text>
      ) : null}
      <Box borderStyle="round" borderColor={errorText ? theme.danger : theme.border} paddingX={1}>
        {display.length === 0 && props.placeholder ? (
          <>
            <Text color={theme.accentBright}>{"> "}</Text>
            <Text dimColor>{props.placeholder}</Text>
            <Text dimColor>▌</Text>
          </>
        ) : (
          <Text wrap="truncate-end">
            <Text color={theme.accentBright}>{"> "}</Text>
            {render.before}
            <Text inverse>{render.cursorChar}</Text>
            {render.after}
          </Text>
        )}
      </Box>
      {errorText ? (
        <Text color={theme.danger}>✗ {errorText}</Text>
      ) : null}
      {props.hint ? <Text dimColor>{props.hint}</Text> : <Text dimColor>enter confirm · esc cancel</Text>}
    </Box>
  );
}

function buildCursorRender(display: string, cursor: number): CursorRender {
  const before = display.slice(0, cursor);
  const cursorChar = display[cursor] ?? "";
  const after = display.slice(cursor + (cursorChar ? 1 : 0));

  return {
    before,
    cursorChar,
    after,
    cursorAtEnd: cursor >= display.length
  };
}

export function validateUrl(value: string): string | null {
  if (value.length === 0) return "URL is required";
  let candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "only http(s) protocols are supported";
    }
    if (parsed.hostname.length === 0) return "hostname is missing";
    return null;
  } catch {
    return "not a valid URL";
  }
}

export function validateNonEmpty(value: string): string | null {
  return value.trim().length === 0 ? "value is required" : null;
}

export function validateName(value: string): string | null {
  if (value.trim().length === 0) return "provider id is required";
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(value.trim())) {
    return "use letters, digits, dash or underscore (max 32)";
  }
  return null;
}
