import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/permissions/engine.js";
import { matchesPattern, requestSummaryPattern } from "../src/permissions/patterns.js";
import type { PermissionRequest } from "../src/types.js";

function makeRequest(overrides: Partial<PermissionRequest> = {}): Omit<PermissionRequest, "id"> {
  return {
    tool: "bash",
    title: "Run shell command",
    summary: ["npm run build"],
    risk: "medium",
    ...overrides
  };
}

async function collect(engine: PermissionEngine, request: Omit<PermissionRequest, "id">, mode: "normal" | "accept" | "plan" | "bypass") {
  const decisions: string[] = [];
  engine.setAskHandler(async () => {
    decisions.push("asked");
    return "allow_once";
  });
  const decision = await engine.request(request, { mode });
  return { decision, askedCount: decisions.length };
}

describe("PermissionEngine mode behavior", () => {
  it("auto-allows everything in bypass", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "bypass" });
    const outcome = await collect(engine, makeRequest(), "bypass");
    expect(outcome.decision).toBe("allow_once");
    expect(outcome.askedCount).toBe(0);
  });

  it("denies mutating tools in plan mode without asking", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "normal" });
    const outcome = await collect(engine, makeRequest(), "plan");
    expect(outcome.decision).toBe("deny");
    expect(outcome.askedCount).toBe(0);
  });

  it("auto-approves non-high-risk in accept mode", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "normal" });
    const medium = await collect(engine, makeRequest({ risk: "medium" }), "accept");
    expect(medium.decision).toBe("allow_once");

    const high = await collect(engine, makeRequest({ risk: "high" }), "accept");
    expect(high.decision).toBe("allow_once");
    expect(high.askedCount).toBe(1);
  });

  it("asks the handler in normal mode", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "normal" });
    const outcome = await collect(engine, makeRequest(), "normal");
    expect(outcome.decision).toBe("allow_once");
    expect(outcome.askedCount).toBe(1);
  });

  it("falls back to deny when no ask handler exists", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "normal" });
    const decision = await engine.request(makeRequest(), { mode: "normal" });
    expect(decision).toBe("deny");
  });
});

describe("PermissionEngine rule matching and memory", () => {
  it("honors explicit deny before allow", async () => {
    const engine = new PermissionEngine({
      rules: [
        { tool: "bash", decision: "ask" },
        { tool: "bash", pattern: "git push*", decision: "deny" },
        { tool: "bash", pattern: "git*", decision: "allow" }
      ],
      mode: "normal"
    });

    const pushed = await engine.request(
      makeRequest({ summary: ["git push --force origin main"] }),
      { mode: "normal" }
    );
    expect(pushed).toBe("deny");

    engine.setAskHandler(async () => "allow_once");
    const status = await engine.request(makeRequest({ summary: ["git status"] }), { mode: "normal" });
    expect(status).toBe("allow_once");
  });

  it("remembers allow_always per pattern", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "normal" });
    let asks = 0;
    engine.setAskHandler(async () => {
      asks += 1;
      return "allow_always";
    });

    const first = await engine.request(makeRequest({ summary: ["npm run build"] }), { mode: "normal" });
    expect(first).toBe("allow_once");
    expect(asks).toBe(1);

    const second = await engine.request(makeRequest({ summary: ["npm run build"] }), { mode: "normal" });
    expect(second).toBe("allow_once");
    expect(asks).toBe(1);
  });

  it("caches denies so the user is not re-prompted", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "normal" });
    let asks = 0;
    engine.setAskHandler(async () => {
      asks += 1;
      return "deny";
    });

    await engine.request(makeRequest({ summary: ["rm -rf dist"] }), { mode: "normal" });
    const again = await engine.request(makeRequest({ summary: ["rm -rf dist"] }), { mode: "normal" });
    expect(again).toBe("deny");
    expect(asks).toBe(1);
  });

  it("exports remembered rules for persistence", async () => {
    const engine = new PermissionEngine({ rules: [], mode: "normal" });
    engine.setAskHandler(async () => "allow_always");
    await engine.request(makeRequest({ tool: "fetch", summary: ["https://example.com/docs"] }), { mode: "normal" });

    const exported = engine.exportRememberedRules();
    expect(exported.some((rule) => rule.tool === "fetch" && rule.decision === "allow")).toBe(true);
  });
});

describe("pattern utilities", () => {
  it("derives stable patterns from requests", () => {
    expect(requestSummaryPattern(makeRequest({ summary: ["npm run build"] }))).toBe("bash:npm run");
    expect(requestSummaryPattern(makeRequest({ tool: "write", title: "f", summary: ["src/x.ts", "3 lines"], risk: "low" }))).toBe("write:src/x.ts");
  });

  it("matches glob-ish rule patterns against candidates", () => {
    expect(matchesPattern("bash:git*", "bash:git status")).toBe(true);
    expect(matchesPattern("write:src/*", "write:src/deep/file.ts")).toBe(true);
    expect(matchesPattern("bash:cargo*", "bash:npm install")).toBe(false);
  });
});
