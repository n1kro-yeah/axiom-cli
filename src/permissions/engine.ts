import type { PermissionBroker, PermissionDecision, PermissionMode, PermissionRequest, PermissionRule } from "../types.js";
import { createLogger } from "../util/log.js";
import {
  DecisionAuditLog,
  matchesPattern,
  requestSummaryPattern,
  ruleKey,
  sortedBySpecificity,
  specificityOf
} from "./patterns.js";

const log = createLogger("permissions");

export type AskHandler = (request: PermissionRequest) => Promise<PermissionDecision>;

export interface PermissionEngineOptions {
  rules: PermissionRule[];
  mode: PermissionMode;
  onAsk?: AskHandler;
}

interface ResolvedRuleMatch {
  rule: PermissionRule;
  specificity: number;
}

export class PermissionEngine implements PermissionBroker {
  private rules: PermissionRule[];
  private mode: PermissionMode;
  private askHandler: AskHandler | undefined;
  private readonly remembered = new Map<string, PermissionDecision>();
  private sessionDenyAll = false;
  private readonly audit = new DecisionAuditLog();

  constructor(options: PermissionEngineOptions) {
    this.rules = [...options.rules];
    this.mode = options.mode;
    this.askHandler = options.onAsk;
  }

  setMode(mode: PermissionMode): void {
    log.debug(`mode ${this.mode} -> ${mode}`);
    this.mode = mode;
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  get auditLog(): DecisionAuditLog {
    return this.audit;
  }

  setAskHandler(handler: AskHandler | undefined): void {
    this.askHandler = handler;
  }

  setRules(rules: PermissionRule[]): void {
    this.rules = [...rules];
  }

  addRuntimeRule(rule: PermissionRule): void {
    const key = ruleKey(rule.tool, rule.pattern);
    if (rule.decision === "allow") {
      this.remembered.set(key, "allow_always");
    } else if (rule.decision === "deny") {
      this.remembered.set(key, "deny");
    }
    if (!this.rules.some((existing) => ruleKey(existing.tool, existing.pattern) === key)) {
      this.rules.push(rule);
    }
  }

  denyEverythingForSession(): void {
    this.sessionDenyAll = true;
  }

  async request(
    request: Omit<PermissionRequest, "id">,
    options: { mode: PermissionMode }
  ): Promise<PermissionDecision> {
    const effectiveMode: PermissionMode = options.mode ?? this.mode;

    if (effectiveMode === "bypass") {
      this.audit.record({ tool: request.tool, decision: "mode_auto", mode: effectiveMode });
      return "allow_once";
    }

    if (this.sessionDenyAll) {
      this.audit.record({ tool: request.tool, decision: "deny", mode: effectiveMode });
      return "deny";
    }

    const pattern = requestSummaryPattern(request);

    const rememberedDecision = pattern ? this.remembered.get(ruleKey(request.tool, pattern)) : undefined;
    if (rememberedDecision === "allow_always") {
      this.audit.record({ tool: request.tool, pattern, decision: "rule_allow", mode: effectiveMode });
      return "allow_once";
    }
    if (rememberedDecision === "deny") {
      this.audit.record({ tool: request.tool, pattern, decision: "rule_deny", mode: effectiveMode });
      return "deny";
    }

    const matched = this.matchRules(request.tool, pattern);
    for (const match of sortedBySpecificity(matched)) {
      if (match.rule.decision === "deny") {
        this.audit.record({ tool: request.tool, pattern, decision: "rule_deny", mode: effectiveMode });
        return "deny";
      }
      if (match.rule.decision === "allow") {
        this.audit.record({ tool: request.tool, pattern, decision: "rule_allow", mode: effectiveMode });
        return "allow_once";
      }
    }

    if (effectiveMode === "accept" && request.risk !== "high") {
      this.audit.record({ tool: request.tool, decision: "mode_auto", mode: effectiveMode });
      return "allow_once";
    }

    if (effectiveMode === "plan") {
      this.audit.record({ tool: request.tool, decision: "mode_auto", mode: effectiveMode });
      return "deny";
    }

    if (!this.askHandler) {
      log.warn(`no ask handler; denying ${request.tool}`);
      this.audit.record({ tool: request.tool, decision: "deny", mode: effectiveMode });
      return "deny";
    }

    const fullRequest: PermissionRequest = {
      id: `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      ...request
    };

    let decision: PermissionDecision;
    try {
      decision = await this.askHandler(fullRequest);
    } catch (error) {
      log.error("ask handler failed", error);
      decision = "deny";
    }

    if (decision === "allow_always" && pattern) {
      this.remembered.set(ruleKey(request.tool, pattern), "allow_always");
    }
    if (decision === "deny" && pattern) {
      this.remembered.set(ruleKey(request.tool, pattern), "deny");
    }

    this.audit.record({ tool: request.tool, pattern, decision, mode: effectiveMode });
    return decision === "allow_always" ? "allow_once" : decision;
  }

  private matchRules(tool: string, pattern?: string): ResolvedRuleMatch[] {
    const matches: ResolvedRuleMatch[] = [];

    for (const rule of this.rules) {
      const toolToken = rule.tool.split(":")[0];
      const toolMatches = toolToken === tool || rule.tool === "*" || rule.tool.startsWith(`${tool}:`);
      if (!toolMatches) continue;

      if (rule.pattern && pattern) {
        if (matchesPattern(rule.pattern, pattern)) {
          matches.push({ rule, specificity: specificityOf(rule.pattern) + 5 });
        }
        continue;
      }

      matches.push({
        rule,
        specificity: rule.pattern ? specificityOf(rule.pattern) : 0
      });
    }

    return matches;
  }

  exportRememberedRules(): PermissionRule[] {
    const out: PermissionRule[] = [];
    for (const [key] of this.remembered) {
      const index = key.indexOf("::");
      const tool = key.slice(0, index);
      const pattern = key.slice(index + 2);
      const decision = this.remembered.get(key);
      if (!decision) continue;
      out.push({
        tool,
        pattern: pattern === "*" ? undefined : pattern,
        decision: decision === "allow_always" ? "allow" : "deny"
      });
    }
    return out;
  }
}

export function createAutoAllowBroker(mode: PermissionMode): PermissionBroker {
  return {
    request: async (_request, options) => {
      void _request;
      void options;
      return "allow_once";
    }
  };
}
