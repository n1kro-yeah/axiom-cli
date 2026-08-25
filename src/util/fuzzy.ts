export interface FuzzyScore {
  score: number;
  positions: number[];
}

export function fuzzyMatch(pattern: string, target: string): FuzzyScore | null {
  if (pattern.length === 0) return { score: 0, positions: [] };
  if (pattern.length > target.length) return null;

  const lowerPattern = pattern.toLowerCase();
  const lowerTarget = target.toLowerCase();
  const positions: number[] = [];

  let score = 0;
  let patternIndex = 0;
  let previousMatch = -1;
  let consecutive = 0;

  for (let i = 0; i < target.length && patternIndex < lowerPattern.length; i += 1) {
    if (lowerTarget[i] !== lowerPattern[patternIndex]) continue;

    positions.push(i);

    if (previousMatch === i - 1) {
      consecutive += 1;
      score += 8 + consecutive * 2;
    } else {
      consecutive = 0;
      score += 3;
      if (i === 0) score += 12;
      else {
        const prevChar = target[i - 1];
        if (prevChar === "/" || prevChar === "\\" || prevChar === "-" || prevChar === "_" || prevChar === " ") {
          score += 9;
        } else if (isUpperCase(target[i]) && !isUpperCase(prevChar)) {
          score += 7;
        } else if (prevChar === ".") {
          score += 5;
        }
      }
    }

    previousMatch = i;
    patternIndex += 1;
  }

  if (patternIndex < lowerPattern.length) return null;

  const density = positions.length / Math.max(previousMatch + 1, 1);
  score += Math.round(density * 10);
  score -= Math.max(0, target.length - pattern.length) * 0.05;

  return { score, positions };
}

function isUpperCase(char: string): boolean {
  return char >= "A" && char <= "Z";
}

export function rankByFuzzy<T>(
  items: T[],
  query: string,
  keyOf: (item: T) => string,
  limit = 50
): Array<{ item: T; score: number }> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return items.slice(0, limit).map((item) => ({ item, score: 0 }));
  }

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const key = keyOf(item);
    const direct = fuzzyMatch(trimmed, key);
    if (direct) {
      scored.push({ item, score: direct.score });
      continue;
    }
    const segments = splitSearchSegments(key);
    let bestSegment = 0;
    for (const segment of segments) {
      const segmentScore = fuzzyMatch(trimmed, segment);
      if (segmentScore && segmentScore.score > bestSegment) {
        bestSegment = segmentScore.score;
      }
    }
    if (bestSegment > 0) {
      scored.push({ item, score: bestSegment * 0.6 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function splitSearchSegments(key: string): string[] {
  return key
    .split(/[\\/._\-\s]/)
    .filter((segment) => segment.length > 0)
    .map((segment, index, all) => (index === all.length - 1 ? segment : `${segment}`));
}

export interface GlobToken {
  kind: "literal" | "single" | "star" | "doublestar" | "charset" | "brace";
  value?: string;
  alternatives?: GlobToken[];
  chars?: string;
  negated?: boolean;
}

export function globToRegExp(glob: string): RegExp {
  let source = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];
    switch (char) {
      case "*": {
        if (glob[index + 1] === "*") {
          if (glob[index + 2] === "/") {
            source += "(?:.*/)?";
            index += 3;
            break;
          }
          source += ".*";
          index += 2;
          break;
        }
        source += "[^/]*";
        index += 1;
        break;
      }
      case "?":
        source += "[^/]";
        index += 1;
        break;
      case "[":
        {
          let close = index + 1;
          let negated = false;
          if (glob[close] === "!" || glob[close] === "^") {
            negated = true;
            close += 1;
          }
          let body = "";
          while (close < glob.length && glob[close] !== "]") {
            body += glob[close].replace(/([\\\]])/, "\\$1");
            close += 1;
          }
          if (close >= glob.length) {
            source += "\\[";
            index += 1;
            break;
          }
          source += `[${negated ? "^" : ""}${body}]`;
          index = close + 1;
        }
        break;
      case "{":
        {
          let depth = 1;
          let close = index + 1;
          while (close < glob.length && depth > 0) {
            if (glob[close] === "{") depth += 1;
            if (glob[close] === "}") depth -= 1;
            if (depth > 0) close += 1;
          }
          const inner = glob.slice(index + 1, close);
          const alternatives = inner.split(",").map((alt) => `(?:${globToRegExp(alt).source.replace(/^\^|\$$/g, "")})`);
          const combined = alternatives.length > 1 ? `(?:${alternatives.join("|")})` : alternatives.join("");
          source += combined;
          index = close + 1;
        }
        break;
      default:
        source += escapeRegExpChar(char);
        index += 1;
        break;
    }
  }

  return new RegExp(`^${source}$`, "");
}

export function escapeRegExpChar(char: string): string {
  if (/[.*+?^${}()|[\]\\]/.test(char)) return `\\${char}`;
  return char;
}

export function globMatchesAny(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlobPath(path, pattern)) return true;
  }
  return false;
}

export function matchGlobPath(path: string, glob: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedGlob = glob.replace(/\\/g, "/");
  const regex = globToRegExp(normalizedGlob);
  if (regex.test(normalizedPath)) return true;
  if (!normalizedGlob.includes("/")) {
    const base = normalizedPath.split("/").pop() ?? "";
    if (regex.test(base)) return true;
  }
  if (!normalizedGlob.startsWith("/") && !normalizedGlob.includes("/")) {
    const segments = normalizedPath.split("/");
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (regex.test(segments.slice(i).join("/"))) return true;
    }
  }
  return false;
}

export function highlightPositions(text: string, positions: number[]): string {
  if (positions.length === 0) return text;
  const set = new Set(positions);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (set.has(i)) out += `\u001b[1m${text[i]}\u001b[0m`;
    else out += text[i];
  }
  return out;
}

export function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const candidate = values[i];
    let j = 0;
    while (j < prefix.length && j < candidate.length && prefix[j] === candidate[j]) j += 1;
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) return "";
  }
  return prefix;
}
