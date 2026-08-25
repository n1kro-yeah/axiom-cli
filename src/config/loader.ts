import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AxiomPaths } from "./paths.js";
import {
  mergePermissionRules,
  parseGlobalConfig,
  parseProjectConfig,
  defaultGlobalConfig
} from "./schema.js";
import type { GlobalConfig, ProjectConfig } from "./schema.js";
import type { PermissionRule, PermissionMode } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";

const log = createLogger("config");

export interface EffectiveConfig {
  global: GlobalConfig;
  project: ProjectConfig | null;
  projectTrusted: boolean;
  model: string;
  effort: "low" | "medium" | "high";
  thinking: boolean;
  maxTokens: number;
  mode: PermissionMode;
  permissions: PermissionRule[];
  warnings: string[];
}

export class ConfigStore {
  private paths: AxiomPaths;
  private cachedGlobal: GlobalConfig | null = null;

  constructor(paths: AxiomPaths) {
    this.paths = paths;
  }

  updatePaths(paths: AxiomPaths): void {
    this.paths = paths;
    this.cachedGlobal = null;
  }

  loadGlobalSync(): GlobalConfig {
    if (this.cachedGlobal) return this.cachedGlobal;
    const file = this.paths.configFile;
    if (!existsSync(file)) {
      const fresh = defaultGlobalConfig();
      try {
        writeFileSyncSafe(file, JSON.stringify(fresh, null, 2));
      } catch (error) {
        log.warn("could not create default config", error);
      }
      this.cachedGlobal = fresh;
      return fresh;
    }
    try {
      const rawText = readFileSync(file, "utf8");
      const parsed = JSON.parse(rawText) as unknown;
      const { config } = parseGlobalConfig(parsed);
      this.cachedGlobal = config;
      return config;
    } catch (error) {
      log.error("global config unreadable, using defaults", error);
      this.cachedGlobal = defaultGlobalConfig();
      return this.cachedGlobal;
    }
  }

  async saveGlobal(config: GlobalConfig): Promise<void> {
    await mkdir(dirname(this.paths.configFile), { recursive: true });
    await writeFile(this.paths.configFile, JSON.stringify(config, null, 2), "utf8");
    this.cachedGlobal = config;
  }

  mutateGlobal(mutator: (draft: GlobalConfig) => void): GlobalConfig {
    const current = this.loadGlobalSync();
    const draft = structuredClone(current);
    mutator(draft);
    void this.saveGlobal(draft).catch((error) => log.error("failed to persist config", error));
    return draft;
  }

  async loadProject(): Promise<{ config: ProjectConfig | null; trusted: boolean; warnings: string[] }> {
    let rawText: string | undefined;
    for (const candidate of [this.paths.projectConfigFile]) {
      try {
        rawText = await readFile(candidate, "utf8");
        break;
      } catch {
      }
    }
    if (rawText === undefined) return { config: null, trusted: false, warnings: [] };

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch (error) {
      return { config: null, trusted: false, warnings: [`Project config is not valid JSON`] };
    }

    const { config, warnings } = parseProjectConfig(parsed);
    if (!config) return { config: null, trusted: false, warnings };

    const normalizedRoot = this.paths.projectRoot.replace(/\\/g, "/").toLowerCase();
    const global = this.loadGlobalSync();
    const explicitlyTrusted =
      config.trusted === true || global.trustedProjects.some((entry) => entry.replace(/\\/g, "/").toLowerCase() === normalizedRoot);

    return { config, trusted: explicitlyTrusted, warnings };
  }

  async trustProject(revoke = false): Promise<void> {
    const normalizedRoot = this.paths.projectRoot;
    const current = structuredClone(this.loadGlobalSync());

    if (revoke) {
      current.trustedProjects = current.trustedProjects.filter(
        (entry) => entry.replace(/\\/g, "/").toLowerCase() !== normalizedRoot.replace(/\\/g, "/").toLowerCase()
      );
      await this.saveGlobal(current);
      return;
    }

    if (!current.trustedProjects.includes(normalizedRoot)) {
      current.trustedProjects.push(normalizedRoot);
    }
    await this.saveGlobal(current);

    try {
      const existing = await this.readRawProjectIfExists();
      const parsed = existing ? (JSON.parse(existing) as Record<string, unknown>) : { version: 1 as const };
      parsed["trusted"] = true;
      await mkdir(dirname(this.paths.projectConfigFile), { recursive: true });
      await writeFile(this.paths.projectConfigFile, JSON.stringify(parsed, null, 2), "utf8");
    } catch (error) {
      log.warn("trust flag could not be written into project config", error);
    }
  }

  private async readRawProjectIfExists(): Promise<string | undefined> {
    try {
      return await readFile(this.paths.projectConfigFile, "utf8");
    } catch {
      return undefined;
    }
  }

  resolveEffective(options: { modeOverride?: PermissionMode; modelOverride?: string }): EffectiveConfig {
    const global = this.loadGlobalSync();
    void this.loadProject()
      .then((projectState) => {
        log.debug(`project config loaded: ${projectState.config ? "yes" : "no"} trusted=${projectState.trusted}`);
      })
      .catch(() => undefined);

    const warnings: string[] = [];
    let effectivePermissions = [...global.permissions];
    let model = options.modelOverride ?? global.model;
    let effort = global.effort;
    let thinking = global.thinking;
    let maxTokens = global.maxTokens;
    const mode = options.modeOverride ?? global.mode;

    try {
      const projectState = this.loadProjectBlocking();
      if (projectState.config && projectState.trusted) {
        const p = projectState.config;
        if (p.model) model = p.model;
        if (p.effort) effort = p.effort;
        if (p.thinking !== undefined) thinking = p.thinking;
        if (p.maxTokens) maxTokens = p.maxTokens;
        if (p.permissions?.length) effectivePermissions = mergePermissionRules(effectivePermissions, p.permissions);
      } else if (projectState.config && !projectState.trusted) {
        warnings.push("Project config found but not trusted. Run `axiom trust` to enable it.");
      }
      warnings.push(...projectState.warnings);
    } catch {
    }

    return {
      global,
      project: null,
      projectTrusted: false,
      model,
      effort,
      thinking,
      maxTokens,
      mode,
      permissions: effectivePermissions,
      warnings
    };
  }

  private loadProjectBlocking(): { config: ProjectConfig | null; trusted: boolean; warnings: string[] } {
    try {
      const rawText = readFileSync(this.paths.projectConfigFile, "utf8");
      const { config, warnings } = parseProjectConfig(JSON.parse(rawText));
      if (!config) return { config: null, trusted: false, warnings };
      const normalizedRoot = this.paths.projectRoot.replace(/\\/g, "/").toLowerCase();
      const global = this.loadGlobalSync();
      const trusted =
        config.trusted === true ||
        global.trustedProjects.some((entry) => entry.replace(/\\/g, "/").toLowerCase() === normalizedRoot);
      return { config, trusted, warnings };
    } catch {
      return { config: null, trusted: false, warnings: [] };
    }
  }
}

function writeFileSyncSafe(filePath: string, content: string): void {
  try {
    mkdirSyncSafe(dirname(filePath));
    writeFileSync(filePath, content, "utf8");
  } catch (error) {
    throw new AxiomError(`Failed writing ${filePath}`, { cause: error });
  }
}

function mkdirSyncSafe(dir: string): void {
  import("node:fs")
    .then((fs) => fs.mkdirSync(dir, { recursive: true }))
    .catch(() => undefined);
}
