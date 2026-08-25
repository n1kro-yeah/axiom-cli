import type { ModelInfo, Usage } from "../types.js";
import { addUsage, emptyUsage } from "../types.js";

export function estimateTokensFromText(text: string): number {
  if (text.length === 0) return 0;
  let asciiCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code <= 126) asciiCount += 1;
  }
  const nonAscii = text.length - asciiCount;
  return Math.ceil(asciiCount / 4) + Math.ceil(nonAscii / 1.6);
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function contextUsagePercent(usedTokens: number, model: ModelInfo): number {
  if (model.contextWindow <= 0) return 0;
  return Math.min((usedTokens / model.contextWindow) * 100, 100);
}

export interface ContextGaugeState {
  percent: number;
  label: string;
  level: "ok" | "warn" | "critical";
}

export function contextGauge(usedTokens: number, model: ModelInfo): ContextGaugeState {
  const percent = contextUsagePercent(usedTokens, model);
  const label = `${formatTokenCount(usedTokens)}`;
  if (percent >= 85) return { percent, label, level: "critical" };
  if (percent >= 60) return { percent, label, level: "warn" };
  return { percent, label, level: "ok" };
}

export class CostTracker {
  private readonly total: Usage = emptyUsage();
  private accumulatedUSD = 0;

  add(delta: Usage): void {
    addUsage(this.total, delta);
  }

  addCost(usd: number): void {
    this.accumulatedUSD += usd;
  }

  snapshot(): Usage {
    return { ...this.total };
  }

  get costUSD(): number {
    return Number(this.accumulatedUSD.toFixed(6));
  }

  reset(): void {
    this.total.inputTokens = 0;
    this.total.outputTokens = 0;
    this.total.cacheReadTokens = 0;
    this.total.cacheWriteTokens = 0;
    this.total.reasoningTokens = 0;
    this.accumulatedUSD = 0;
  }
}

export function computeMessageCost(model: ModelInfo | undefined, usage: Usage | undefined): number {
  if (!model?.pricing || !usage) return 0;
  const pricing = model.pricing;
  const input = ((usage.inputTokens + usage.reasoningTokens) / 1_000_000) * pricing.inputPerMillion;
  const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheRead = ((usage.cacheReadTokens || 0) / 1_000_000) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion * 0.1);
  const cacheWrite =
    ((usage.cacheWriteTokens || 0) / 1_000_000) * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion * 1.25);
  return Number((input + output + cacheRead + cacheWrite).toFixed(6));
}

export function mergeUsageList(list: Array<Usage | undefined>): Usage {
  const merged = emptyUsage();
  for (const entry of list) {
    if (entry) addUsage(merged, entry);
  }
  return merged;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface BudgetLimits {
  maxTokensPerMessage?: number;
  maxCostPerMessageUSD?: number;
  maxToolCallsPerMessage?: number;
  maxSubagentsPerSession?: number;
}

export class MessageBudget {
  private tokensThisMessage = 0;
  private costThisMessageUSD = 0;
  private toolCallsThisMessage = 0;

  constructor(private readonly limits: BudgetLimits) {}

  startMessage(): void {
    this.tokensThisMessage = 0;
    this.costThisMessageUSD = 0;
    this.toolCallsThisMessage = 0;
  }

  recordTokens(count: number): void {
    this.tokensThisMessage += count;
  }

  recordCost(usd: number): void {
    this.costThisMessageUSD += usd;
  }

  recordToolCall(): BudgetCheckResult {
    this.toolCallsThisMessage += 1;
    const max = this.limits.maxToolCallsPerMessage ?? Infinity;
    if (this.toolCallsThisMessage > max) {
      return { allowed: false, reason: `Tool call budget exhausted (${max} per message)` };
    }
    return { allowed: true };
  }

  checkTokenBudget(): BudgetCheckResult {
    const limit = this.limits.maxTokensPerMessage ?? Infinity;
    if (limit !== Infinity && this.tokensThisMessage > limit) {
      return { allowed: false, reason: `Token budget exhausted (${limit} per message)` };
    }
    const costLimit = this.limits.maxCostPerMessageUSD ?? Infinity;
    if (costLimit !== Infinity && this.costThisMessageUSD > costLimit) {
      return { allowed: false, reason: `Cost budget exhausted ($${costLimit} per message)` };
    }
    return { allowed: true };
  }

  get spentTokens(): number {
    return this.tokensThisMessage;
  }

  get spentUSD(): number {
    return this.costThisMessageUSD;
  }

  get toolCalls(): number {
    return this.toolCallsThisMessage;
  }
}
