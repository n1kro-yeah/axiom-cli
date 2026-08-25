export type PartialJsonResult =
  | { complete: true; value: unknown }
  | { complete: false; value: unknown; missingClosers: string[] };

export function parsePartialJson(input: string): PartialJsonResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { complete: false, value: undefined, missingClosers: [] };

  const direct = tryParse(trimmed);
  if (direct !== UNPARSEABLE) return { complete: true, value: direct };

  const scanner = scanStructure(trimmed);
  const repaired = buildRepairedText(trimmed, scanner);
  const parsed = tryParse(repaired.text);
  if (parsed !== UNPARSEABLE) {
    return { complete: false, value: parsed, missingClosers: scanner.missingClosers };
  }

  const aggressive = tryParse(stripTrailingComma(repaired.text));
  if (aggressive !== UNPARSEABLE) {
    return { complete: false, value: aggressive, missingClosers: scanner.missingClosers };
  }

  const salvaged = salvageTopLevelFields(trimmed);
  return { complete: false, value: salvaged, missingClosers: scanner.missingClosers };
}

const UNPARSEABLE = Symbol("unparseable");

function tryParse(text: string): unknown | typeof UNPARSEABLE {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return UNPARSEABLE;
  }
}

interface StructureScan {
  stack: string[];
  missingClosers: string[];
  inString: boolean;
  escapeNext: boolean;
}

function scanStructure(text: string): StructureScan {
  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (char === "\\") escapeNext = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }

  const missingClosers: string[] = [];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    missingClosers.push(stack[i] === "{" ? "}" : "]");
  }

  return { stack, missingClosers, inString, escapeNext };
}

function buildRepairedText(
  original: string,
  scan: StructureScan
): { text: string; cutPosition: number } {
  let working = original;

  if (scan.inString) {
    const lastQuote = working.lastIndexOf('"');
    const lastBackslashBeforeQuote = working.lastIndexOf("\\", lastQuote > 0 ? lastQuote - 1 : undefined);
    if (lastQuote !== -1 && lastBackslashBeforeQuote !== lastQuote - 1) {
      working = `${working.slice(0, lastQuote)}"`;
    } else {
      working += '"';
    }
  }

  working = removeDanglingFragment(working);

  for (let i = scan.missingClosers.length - 1; i >= 0; i -= 1) {
    working += scan.missingClosers[i];
  }

  return { text: working, cutPosition: original.length };
}

function removeDanglingFragment(text: string): string {
  let working = text;
  for (;;) {
    const trimmedEnd = working.replace(/\s+$/, "");
    if (
      trimmedEnd.endsWith(":") ||
      trimmedEnd.endsWith(",") ||
      trimmedEnd.endsWith("{") ||
      trimmedEnd.endsWith("[")
    ) {
      working = trimmedEnd.slice(0, -1).replace(/\s+$/, "").replace(/,\s*$/, "");
      continue;
    }
    return working;
  }
}

function stripTrailingComma(text: string): string {
  return text.replace(/,\s*(?=[}\]])/g, "");
}

export function salvageTopLevelFields(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let index = skipWhitespace(text, 0);
  if (index >= text.length || text[index] !== "{") return result;
  index += 1;

  for (;;) {
    index = skipWhitespace(text, index);
    if (index >= text.length) break;
    if (text[index] === "}") break;
    if (text[index] !== '"') break;

    const keyStart = index + 1;
    let keyEnd = findClosingQuote(text, keyStart);
    if (keyEnd === -1) break;
    const key = unescapeJsonString(text.slice(keyStart, keyEnd));
    index = skipWhitespace(text, keyEnd + 1);
    if (index >= text.length || text[index] !== ":") break;
    index = skipWhitespace(text, index + 1);

    const valueStart = index;
    let valueEnd = locateCompleteValue(text, valueStart);
    if (valueEnd === -1) {
      const partialValue = extractPartialValue(text, valueStart);
      if (partialValue !== undefined) result[key] = partialValue.value;
      break;
    }
    const slice = text.slice(valueStart, valueEnd);
    const parsed = tryParse(slice);
    if (parsed !== UNPARSEABLE) result[key] = parsed;
    index = skipWhitespace(text, valueEnd);
    if (index < text.length && text[index] === ",") index += 1;
    else break;
  }

  return result;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function findClosingQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return -1;
}

function locateCompleteValue(text: string, start: number): number {
  if (start >= text.length) return -1;
  const first = text[start];
  if (first === "{") {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  if (first === "[") {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  if (first === '"') {
    const end = findClosingQuote(text, start + 1);
    return end === -1 ? -1 : end + 1;
  }
  let cursor = start;
  while (cursor < text.length && !/[,\n\r}]/.test(text[cursor])) cursor += 1;
  return cursor;
}

function extractPartialValue(text: string, start: number): { value: unknown } | undefined {
  if (start >= text.length) return undefined;
  const first = text[start];
  if (first === '"' || first === "{") {
    const partial = parsePartialJson(text.slice(start));
    if (partial.value !== undefined) return { value: partial.value };
  }
  return undefined;
}

function unescapeJsonString(raw: string): string {
  return raw.replace(/\\(.)/g, (_match, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return char;
    }
  });
}

export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as T;
  const clone: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = deepClone(val);
  }
  return clone as T;
}

export function deepGet(source: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function truncateForLog(text: string, limit = 500): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(+${text.length - limit})`;
}
