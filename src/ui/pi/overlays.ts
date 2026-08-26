import { Box, Container, Input, SelectList, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { PermissionDecision, PermissionRequest } from "../../types.js";
import type { AnsiTheme } from "./ansi.js";

export interface OverlayHandle {
  close(): void;
}

interface SelectListThemeLike {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

export function makeSelectListTheme(ansi: AnsiTheme): SelectListThemeLike {
  return {
    selectedPrefix: (text) => ansi.accent(`> ${text}`),
    selectedText: (text) => ansi.bold(text),
    description: (text) => ansi.muted(text),
    scrollInfo: (text) => ansi.faint(text),
    noMatch: (text) => ansi.muted(text)
  };
}

export interface OverlayContext {
  tui: TUI;
  ansi: AnsiTheme;
  restoreFocus: () => void;
}

function mount(context: OverlayContext, panel: Container, options: Parameters<TUI["showOverlay"]>[1], focusTarget?: Component): OverlayHandle {
  const handle = context.tui.showOverlay(panel, options);
  handle.focus();
  if (focusTarget) context.tui.setFocus(focusTarget);

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      handle.hide();
      context.restoreFocus();
    }
  };
}

export function showPermissionOverlay(
  context: OverlayContext,
  request: PermissionRequest,
  onDecision: (decision: PermissionDecision) => void
): OverlayHandle {
  const ansi = context.ansi;
  const riskTag = ansi.muted(`[${request.risk.toUpperCase()}]`);
  const panel = new Box(1, 0);
  panel.addChild(new Text(`${ansi.warning(`! ${request.title}`)} ${riskTag}`));
  for (const line of request.summary.slice(0, 6)) {
    panel.addChild(new TruncatedText(line.length > 110 ? `${line.slice(0, 107)}...` : line, 2, 0));
  }
  panel.addChild(new Text(" ", 0, 0));

  const list = new SelectList(
    [
      { value: "allow_once", label: "Allow once", description: "approve this single action" },
      { value: "allow_always", label: "Always allow this pattern", description: "remember the decision" },
      { value: "deny", label: "Deny", description: "reject the action" }
    ],
    3,
    makeSelectListTheme(ansi)
  );

  const handle = mount(context, panel, { anchor: "bottom-center", margin: 1 }, list);

  list.onSelect = (item) => {
    handle.close();
    onDecision(item.value as PermissionDecision);
  };
  list.onCancel = () => {
    handle.close();
    onDecision("deny");
  };

  return handle;
}

export function showConfirmOverlay(
  context: OverlayContext,
  title: string,
  onAnswer: (yes: boolean) => void
): OverlayHandle {
  const ansi = context.ansi;
  const panel = new Box(1, 0);
  panel.addChild(new Text(ansi.warning(`? ${title}`)));
  const list = new SelectList(
    [
      { value: "yes", label: "Yes", description: "confirm" },
      { value: "no", label: "No", description: "cancel" }
    ],
    2,
    makeSelectListTheme(ansi)
  );

  const handle = mount(context, panel, { anchor: "center" }, list);

  list.onSelect = (item) => {
    handle.close();
    onAnswer(item.value === "yes");
  };
  list.onCancel = () => {
    handle.close();
    onAnswer(false);
  };

  return handle;
}

export function showPickerOverlay(
  context: OverlayContext,
  title: string,
  items: Array<{ key: string; label: string; hint?: string }>,
  onSelect: (key: string) => void
): OverlayHandle {
  const ansi = context.ansi;
  const panel = new Box(1, 0);
  panel.addChild(new Text(ansi.accentBright(title)));
  const list = new SelectList(
    items.map((item) => ({ value: item.key, label: item.label, description: item.hint })),
    10,
    makeSelectListTheme(ansi)
  );

  const handle = mount(context, panel, { anchor: "center", maxHeight: "70%" }, list);

  list.onSelect = (item) => {
    handle.close();
    onSelect(item.value);
  };
  list.onCancel = () => {
    handle.close();
    onSelect("");
  };

  return handle;
}

export function showTextInputOverlay(
  context: OverlayContext,
  title: string,
  options: { mask?: boolean; initialValue?: string } = {},
  onSubmit: (value: string | null) => void
): OverlayHandle {
  const ansi = context.ansi;
  const panel = new Box(1, 0);
  panel.addChild(new Text(ansi.accentBright(title)));
  const input = new Input();
  if (options.initialValue) input.setValue(options.initialValue);

  const handle = mount(context, panel, { anchor: "center", width: 64 }, input);

  input.onSubmit = (value) => {
    handle.close();
    onSubmit(value.trim().length > 0 ? value.trim() : null);
  };
  panel.addChild(new Text(ansi.faint("enter confirm - esc cancel"), 0, 0));

  return handle;
}

export class QueuedNoticeComponent extends Container {
  constructor(ansi: AnsiTheme, lines: string[]) {
    super();
    for (const line of lines.slice(0, 3)) {
      this.addChild(new Text(ansi.info(line), 0, 0));
    }
  }
}
