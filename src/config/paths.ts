import os from "node:os";
import { join, relative, resolve } from "node:path";

export interface AxiomPaths {
  homeDir: string;
  configDir: string;
  authFile: string;
  configFile: string;
  sessionsDir: string;
  checkpointsDir: string;
  promptsDir: string;
  skillsDir: string;
  logsDir: string;
  logFile: string;
  cacheDir: string;

  projectRoot: string;
  projectAxiomDir: string;
  projectConfigFile: string;
  projectSkillsDir: string;
  projectCommandsDir: string;
  projectRulesDir: string;
}

export function computePaths(cwd: string, env: NodeJS.ProcessEnv = process.env): AxiomPaths {
  const homeOverride = env["AXIOM_HOME"];
  const userHome = homeOverride && homeOverride.length > 0 ? resolve(homeOverride) : os.homedir();
  const configDir = env["AXIOM_CONFIG_DIR"]
    ? resolve(env["AXIOM_CONFIG_DIR"])
    : join(userHome, ".axiom");

  const projectRoot = resolve(cwd);

  return {
    homeDir: userHome,
    configDir,
    authFile: join(configDir, "auth.json"),
    configFile: join(configDir, "config.json"),
    sessionsDir: join(configDir, "sessions"),
    checkpointsDir: join(configDir, "checkpoints"),
    promptsDir: join(configDir, "prompts"),
    skillsDir: join(configDir, "skills"),
    logsDir: join(configDir, "logs"),
    logFile: join(configDir, "logs", "axiom.log"),
    cacheDir: join(configDir, "cache"),

    projectRoot,
    projectAxiomDir: join(projectRoot, ".axiom"),
    projectConfigFile: findProjectConfigFile(projectRoot),
    projectSkillsDir: join(projectRoot, ".axiom", "skills"),
    projectCommandsDir: join(projectRoot, ".axiom", "commands"),
    projectRulesDir: join(projectRoot, ".axiom", "rules")
  };
}

function findProjectConfigFile(root: string): string {
  const candidates = [join(root, ".axiom", "config.json"), join(root, "axiom.json")];
  return candidates[0];
}

export const SESSION_FILE_VERSION = 1;

export function sessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sanitizeId(sessionId) + ".jsonl");
}

export function checkpointFilePath(checkpointsDir: string, sessionId: string): string {
  return join(checkpointsDir, sanitizeId(sessionId));
}

export function promptFilePath(promptsDir: string, slug: string): string {
  return join(promptsDir, `${sanitizeId(slug)}.md`);
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

export function ensureWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rel = relativeSafe(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsoluteRel(rel));
}

function relativeSafe(from: string, to: string): string {
  return relative(from, to);
}

function isAbsoluteRel(rel: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("/");
}

export const RULE_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "axiom.md"];

export function ruleCandidatesForRoot(root: string): string[] {
  return RULE_FILE_CANDIDATES.map((name) => join(root, name));
}

export function localRulesCandidate(root: string): string {
  return join(root, "AXIOM.local.md");
}

export function userRulesCandidate(homeDir: string): string {
  return join(homeDir, ".axiom", "AGENTS.md");
}
