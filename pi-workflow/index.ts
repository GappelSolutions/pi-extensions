import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  Key,
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { readFile, readdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { existsSync } from "fs";
import { buildInitPrompt } from "./prompts/init.js";
import { buildResearchPrompt } from "./prompts/research.js";
import { buildPlanPrompt } from "./prompts/plan.js";
import { buildImplementPrompt } from "./prompts/implement.js";
import { buildCommitPrompt } from "./prompts/commit.js";
import { buildSketchPrompt } from "./prompts/sketch.js";
import { buildCleanupPrompt } from "./prompts/cleanup.js";

// ── Config Types ────────────────────────────────────────────────────────

export interface CommitConfig {
  language: "en" | "de";
  messageFormat: string;
  directCommit: boolean;
  targetBranch: string;
  ticketRequired: boolean;
  ticketPlatform: "azure-devops" | "linear" | "github" | "none";
  platform: "azure-devops" | "github" | "none";
  prDescriptionLanguage: "en" | "de";
  coAuthoredBy: boolean | string;
  branchFormat: string;
  prReady: boolean;
}

export interface WorkflowConfig {
  commit: CommitConfig;
  vault: string;
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WorkflowConfig = {
  commit: {
    language: "en",
    messageFormat: "${type}(${component}): ${description}",
    directCommit: true,
    targetBranch: "main",
    ticketRequired: false,
    ticketPlatform: "none",
    platform: "none",
    prDescriptionLanguage: "en",
    coAuthoredBy: false,
    branchFormat: "${type}/${ticket}-${description}",
    prReady: false,
  },
  vault: "~/dev/codelayer-vault",
};

const HOME = process.env.HOME ?? "";

// ── Skill Definitions ───────────────────────────────────────────────────

interface SkillDef {
  key: string;
  label: string;
  desc: string;
  prompt: PromptBuilder;
  chainable: boolean;
}

const SKILLS: SkillDef[] = [
  { key: "research", label: "Research", desc: "Research codebase, document findings", prompt: buildResearchPrompt, chainable: true },
  { key: "plan", label: "Plan", desc: "Create detailed implementation plan", prompt: buildPlanPrompt, chainable: true },
  { key: "implement", label: "Implement", desc: "Execute an approved plan", prompt: buildImplementPrompt, chainable: true },
  { key: "commit", label: "Commit", desc: "Config-driven commit + PR", prompt: buildCommitPrompt, chainable: true },
  { key: "sketch", label: "Sketch", desc: "Create visual wireframes", prompt: buildSketchPrompt, chainable: false },
  { key: "cleanup", label: "Cleanup", desc: "Clean up completed vault folders", prompt: buildCleanupPrompt, chainable: false },
  { key: "init", label: "Init", desc: "Generate project workflow config", prompt: buildInitPrompt, chainable: false },
];

const CHAIN_ORDER = ["research", "plan", "implement", "commit"];

// ── Config Reader ───────────────────────────────────────────────────────

function deepMerge<T extends Record<string, any>>(base: T, override: Record<string, any>): T {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val) && key in base && typeof (base as any)[key] === "object") {
      (result as any)[key] = deepMerge((base as any)[key], val);
    } else {
      (result as any)[key] = val;
    }
  }
  return result;
}

export async function loadConfig(cwd: string): Promise<WorkflowConfig> {
  let dir = cwd;
  while (true) {
    const configPath = join(dir, ".pi", "workflow.json");
    if (existsSync(configPath)) {
      try {
        const raw = await readFile(configPath, "utf-8");
        const partial = JSON.parse(raw);
        return deepMerge(DEFAULT_CONFIG, partial);
      } catch {
        break;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return deepMerge(DEFAULT_CONFIG, {});
}

export function findGitRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".jj"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Vault Scanner ───────────────────────────────────────────────────────

interface VaultArtifact {
  taskName: string;
  type: "research" | "plan" | "sketch" | "other";
  fileName: string;
  timestamp: string;
}

async function scanVaultArtifacts(vault: string, project: string): Promise<VaultArtifact[]> {
  const vaultDir = join(vault.replace(/^~/, HOME), project);
  if (!existsSync(vaultDir)) return [];

  const artifacts: VaultArtifact[] = [];
  try {
    const taskDirs = await readdir(vaultDir, { withFileTypes: true });
    for (const dir of taskDirs) {
      if (!dir.isDirectory()) continue;
      const taskPath = join(vaultDir, dir.name);
      let files: string[];
      try { files = await readdir(taskPath); } catch { continue; }

      for (const file of files) {
        let type: VaultArtifact["type"] = "other";
        if (file.includes("-research.md")) type = "research";
        else if (file.includes("-plan.md")) type = "plan";
        else if (file.endsWith(".pen")) type = "sketch";
        else continue; // skip non-artifacts

        const match = file.match(/^(\d{4}-\d{2}-\d{2}-\d{4})/);
        artifacts.push({
          taskName: dir.name,
          type,
          fileName: file,
          timestamp: match ? match[1] : "",
        });
      }
    }
  } catch { /* vault dir unreadable */ }

  return artifacts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ── Skill Runner ────────────────────────────────────────────────────────

type PromptBuilder = (args: string, config: WorkflowConfig, context: SkillContext) => string;

export interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

function buildSkillContext(cwd: string): SkillContext {
  const gitRoot = findGitRoot(cwd);
  const project = gitRoot ? basename(gitRoot) : basename(cwd);
  return { cwd, gitRoot, project };
}

async function runSkill(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  promptBuilder: PromptBuilder,
) {
  const skillCtx = buildSkillContext(ctx.cwd);
  const config = await loadConfig(ctx.cwd);
  const prompt = promptBuilder(args, config, skillCtx);
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

// ── Chain State ─────────────────────────────────────────────────────────

interface ChainState {
  currentSkill: string;
  originalArgs: string;
  config: WorkflowConfig;
  context: SkillContext;
}

let chainState: ChainState | null = null;

function advanceChain(pi: ExtensionAPI): void {
  if (!chainState) return;

  const currentIdx = CHAIN_ORDER.indexOf(chainState.currentSkill);
  const nextIdx = currentIdx + 1;

  if (nextIdx >= CHAIN_ORDER.length) {
    chainState = null;
    return;
  }

  const nextSkillKey = CHAIN_ORDER[nextIdx];
  const nextSkill = SKILLS.find(s => s.key === nextSkillKey);
  if (!nextSkill) { chainState = null; return; }

  chainState.currentSkill = nextSkillKey;

  // Build continuation prompt — references vault artifacts from previous step
  const { config, context, originalArgs } = chainState;
  const vaultDir = `${config.vault}/${context.project}`;
  const continuation = `# Chain Continuation — ${nextSkillKey}

The previous step in the workflow chain just completed. Check the vault at \`${vaultDir}/\` for the latest artifacts.

Now proceed with the **${nextSkillKey}** step:

`;
  const skillPrompt = nextSkill.prompt(originalArgs, config, context);
  pi.sendUserMessage(continuation + skillPrompt, { deliverAs: "followUp" });
}

// ── Workflow Hub TUI ────────────────────────────────────────────────────

type HubMode = "clean" | "chain";

type HubAction =
  | { type: "run"; skillKey: string; mode: HubMode }
  | { type: "config" }
  | null;

class WorkflowHub implements Component {
  private skills: SkillDef[];
  private selectedIdx = 0;
  private mode: HubMode = "clean";
  private filter = "";
  private project: string;
  private branch: string;
  private configExists: boolean;
  private artifacts: VaultArtifact[];
  private config: WorkflowConfig;
  private theme: Theme;
  private done: (result: HubAction) => void;
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(
    opts: {
      skills: SkillDef[];
      project: string;
      branch: string;
      configExists: boolean;
      artifacts: VaultArtifact[];
      config: WorkflowConfig;
    },
    theme: Theme,
    done: (result: HubAction) => void,
  ) {
    this.skills = opts.skills;
    this.project = opts.project;
    this.branch = opts.branch;
    this.configExists = opts.configExists;
    this.artifacts = opts.artifacts;
    this.config = opts.config;
    this.theme = theme;
    this.done = done;
  }

  private getFiltered(): SkillDef[] {
    if (!this.filter) return this.skills;
    return this.skills.filter(s =>
      fuzzyMatch(this.filter, s.label) ||
      fuzzyMatch(this.filter, s.key)
    );
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.filter) {
        this.filter = "";
        this.selectedIdx = 0;
        this.invalidate();
      } else {
        this.done(null);
      }
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.mode = this.mode === "clean" ? "chain" : "clean";
      this.invalidate();
      return;
    }

    if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
      const filtered = this.getFiltered();
      if (this.selectedIdx < filtered.length - 1) {
        this.selectedIdx++;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
      if (this.selectedIdx > 0) {
        this.selectedIdx--;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const filtered = this.getFiltered();
      const selected = filtered[this.selectedIdx];
      if (selected) {
        this.done({ type: "run", skillKey: selected.key, mode: this.mode });
      }
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.filter) {
        this.filter = this.filter.slice(0, -1);
        this.selectedIdx = 0;
        this.invalidate();
      }
      return;
    }

    // Printable character → append to filter
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.filter += data;
      this.selectedIdx = 0;
      this.invalidate();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const t = this.theme;
    const border = (s: string) => t.fg("border", s);
    const innerWidth = width - 2;
    const lines: string[] = [];

    // ── Top border with title ──
    const title = " Workflow ";
    const topAfterTitle = innerWidth - visibleWidth(title) - 1;
    lines.push(
      border("┌─") +
      t.fg("accent", t.bold(title)) +
      border("─".repeat(Math.max(0, topAfterTitle)) + "┐")
    );

    // ── Header: project + branch ──
    const branchInfo = this.branch ? `  Branch: ${this.branch}` : "";
    const headerText = ` ${this.project}${branchInfo}`;
    lines.push(
      border("│") +
      padStr(t.bold(truncateToWidth(headerText, innerWidth)), innerWidth) +
      border("│")
    );
    lines.push(border("├" + "─".repeat(innerWidth) + "┤"));

    // ── Two-pane content ──
    const leftWidth = Math.min(Math.floor(innerWidth * 0.4), 30);
    const rightWidth = innerWidth - leftWidth - 1;
    const minRows = 18;

    const leftLines = this.renderSkillList(leftWidth);
    const rightLines = this.renderInfoPane(rightWidth);

    const height = Math.max(leftLines.length, rightLines.length, minRows);
    while (leftLines.length < height) leftLines.push(padStr("", leftWidth));
    while (rightLines.length < height) rightLines.push(padStr("", rightWidth));

    const midSep = border("│");
    for (let i = 0; i < height; i++) {
      lines.push(border("│") + leftLines[i] + midSep + rightLines[i] + border("│"));
    }

    // ── Mode indicator ──
    lines.push(border("├" + "─".repeat(innerWidth) + "┤"));
    const cleanLabel = this.mode === "clean" ? t.bg("selectedBg", t.bold(" clean ")) : t.fg("muted", " clean ");
    const chainLabel = this.mode === "chain" ? t.bg("selectedBg", t.bold(" chain ")) : t.fg("muted", " chain ");
    const modeLine = `  Mode: ${cleanLabel}  ${chainLabel}`;
    lines.push(border("│") + padStr(modeLine, innerWidth) + border("│"));

    // ── Footer ──
    lines.push(border("├" + "─".repeat(innerWidth) + "┤"));
    const footerKeys = "type to filter  [enter] run  [tab] mode  [esc] clear/close";
    lines.push(
      border("│") +
      padStr(" " + t.fg("muted", footerKeys), innerWidth) +
      border("│")
    );
    lines.push(border("└" + "─".repeat(innerWidth) + "┘"));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderSkillList(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const filtered = this.getFiltered();

    // ── Filter input ──
    if (this.filter) {
      const cursor = "█";
      const filterDisplay = ` ${t.fg("accent", "/")}${this.filter}${cursor}`;
      lines.push(padStr(filterDisplay, width));
    } else {
      lines.push(padStr(t.fg("accent", t.bold(" Skills")), width));
    }
    lines.push(t.fg("borderMuted", "─".repeat(width)));

    if (filtered.length === 0) {
      lines.push(padStr(t.fg("muted", "   no match"), width));
    } else {
      for (let i = 0; i < filtered.length; i++) {
        const skill = filtered[i];
        const isSelected = i === this.selectedIdx;
        const icon = isSelected ? "▸" : " ";
        const chainIcon = this.mode === "chain" && skill.chainable ? t.fg("muted", " ⛓") : "";

        let line = ` ${icon} ${skill.label}${chainIcon}`;
        line = truncateToWidth(line, width);
        line = padStr(line, width);

        if (isSelected) {
          line = t.bg("selectedBg", line);
        }
        lines.push(line);
      }
    }

    lines.push(padStr("", width));
    return lines;
  }

  private renderInfoPane(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const filtered = this.getFiltered();

    // ── Selected skill description ──
    const selected = filtered[this.selectedIdx];
    if (selected) {
      lines.push(padStr(t.fg("accent", t.bold(` ${selected.label}`)), width));
      lines.push(t.fg("borderMuted", "─".repeat(width)));
      lines.push(padStr(t.fg("muted", ` ${selected.desc}`), width));
    } else {
      lines.push(padStr(t.fg("muted", " Type to filter skills"), width));
      lines.push(t.fg("borderMuted", "─".repeat(width)));
    }
    lines.push(padStr("", width));

    // ── Config summary ──
    const configLabel = this.configExists ? t.fg("dim", ".pi/workflow.json") : t.fg("muted", "no config (defaults)");
    lines.push(padStr(` Config: ${configLabel}`, width));
    lines.push(padStr(` Platform: ${t.fg("muted", this.config.commit.platform)}`, width));
    lines.push(padStr(` Target: ${t.fg("muted", this.config.commit.targetBranch)}`, width));
    lines.push(padStr("", width));

    // ── Recent artifacts ──
    lines.push(padStr(t.fg("accent", " Recent:"), width));
    if (this.artifacts.length === 0) {
      lines.push(padStr(t.fg("muted", "   no artifacts"), width));
    } else {
      const shown = this.artifacts.slice(0, 5);
      for (const a of shown) {
        const ago = formatAgo(a.timestamp);
        const label = `${a.taskName}/${a.type}`;
        let line = `   ${truncateToWidth(label, width - 15)} ${t.fg("dim", ago)}`;
        lines.push(padStr(truncateToWidth(line, width), width));
      }
    }

    return lines;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────

function fuzzyMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let pi = 0;
  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] === p[pi]) pi++;
  }
  return pi === p.length;
}

function padStr(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width);
  return text + " ".repeat(width - w);
}

function formatAgo(ts: string): string {
  if (!ts) return "";
  try {
    // ts format: YYYY-MM-DD-HHmm
    const [datePart, timePart] = [ts.slice(0, 10), ts.slice(11)];
    const hours = timePart.slice(0, 2);
    const mins = timePart.slice(2);
    const d = new Date(`${datePart}T${hours}:${mins}:00`);
    const diffMs = Date.now() - d.getTime();
    const diffH = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffH < 1) return "just now";
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return "yesterday";
    if (diffD < 7) return `${diffD}d ago`;
    return datePart;
  } catch {
    return ts;
  }
}

// ── Open Hub ────────────────────────────────────────────────────────────

async function openHub(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<HubAction> {
  const cwd = ctx.cwd;
  const skillCtx = buildSkillContext(cwd);
  const config = await loadConfig(cwd);
  const artifacts = await scanVaultArtifacts(config.vault, skillCtx.project);

  // Get branch name
  let branch = "";
  try {
    const result = await pi.exec("git", ["branch", "--show-current"], { cwd });
    if (result.code === 0) branch = result.stdout.trim();
  } catch { /* no git */ }

  const configExists = existsSync(
    join(skillCtx.gitRoot ?? cwd, ".pi", "workflow.json")
  );

  return ctx.ui.custom(
    (_tui: any, theme: Theme, _kb: any, done: (r: HubAction) => void) =>
      new WorkflowHub(
        {
          skills: SKILLS,
          project: skillCtx.project,
          branch,
          configExists,
          artifacts,
          config,
        },
        theme,
        done,
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        maxHeight: "90%",
        anchor: "center",
      },
    },
  );
}

// ── Extension Entry Point ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── gs:workflow — TUI Hub ──
  pi.registerCommand("gs:workflow", {
    description: "Open workflow hub — select and run skills",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Workflow hub requires a TUI", "warning");
        return;
      }

      // Direct chain invocation: /gs:workflow chain research "query"
      if (args.startsWith("chain ")) {
        const rest = args.slice(6).trim();
        const spaceIdx = rest.indexOf(" ");
        const skillKey = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
        const skillArgs = spaceIdx > 0 ? rest.slice(spaceIdx + 1) : "";

        const skill = SKILLS.find(s => s.key === skillKey);
        if (!skill) {
          ctx.ui.notify(`Unknown skill: ${skillKey}`, "error");
          return;
        }

        const skillCtx = buildSkillContext(ctx.cwd);
        const config = await loadConfig(ctx.cwd);

        chainState = {
          currentSkill: skillKey,
          originalArgs: skillArgs,
          config,
          context: skillCtx,
        };

        ctx.ui.notify(`Chain: starting ${skillKey}`, "info");
        const prompt = skill.prompt(skillArgs, config, skillCtx);
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        return;
      }

      const result = await openHub(pi, ctx);
      if (!result) return;

      if (result.type === "config") {
        const skillCtx = buildSkillContext(ctx.cwd);
        const configPath = join(skillCtx.gitRoot ?? ctx.cwd, ".pi", "workflow.json");
        if (existsSync(configPath)) {
          pi.sendUserMessage(`Read and display the config at ${configPath}, then ask if I want to change anything.`, { deliverAs: "followUp" });
        } else {
          await runSkill(pi, "", ctx, buildInitPrompt);
        }
        return;
      }

      if (result.type === "run") {
        const skill = SKILLS.find(s => s.key === result.skillKey);
        if (!skill) return;

        const skillCtx = buildSkillContext(ctx.cwd);
        const config = await loadConfig(ctx.cwd);

        if (result.mode === "chain") {
          chainState = {
            currentSkill: result.skillKey,
            originalArgs: "",
            config,
            context: skillCtx,
          };
          ctx.ui.notify(`Chain: starting ${result.skillKey}`, "info");
        }

        const prompt = skill.prompt("", config, skillCtx);
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    },
  });

  // ── gs:init ──
  pi.registerCommand("gs:init", {
    description: "Generate .pi/workflow.json by analyzing project git history",
    handler: async (args, ctx) => runSkill(pi, args, ctx, buildInitPrompt),
  });

  // ── gs:research ──
  pi.registerCommand("gs:research", {
    description: "Research codebase and document findings in vault",
    handler: async (args, ctx) => runSkill(pi, args, ctx, buildResearchPrompt),
  });

  // ── gs:plan ──
  pi.registerCommand("gs:plan", {
    description: "Create detailed implementation plan in vault",
    handler: async (args, ctx) => runSkill(pi, args, ctx, buildPlanPrompt),
  });

  // ── gs:implement ──
  pi.registerCommand("gs:implement", {
    description: "Implement an approved plan from vault",
    handler: async (args, ctx) => runSkill(pi, args, ctx, buildImplementPrompt),
  });

  // ── gs:commit ──
  pi.registerCommand("gs:commit", {
    description: "Config-driven commit with optional quality gate and PR creation",
    handler: async (args, ctx) => runSkill(pi, args, ctx, buildCommitPrompt),
  });

  // ── gs:sketch ──
  pi.registerCommand("gs:sketch", {
    description: "Create visual wireframes using Pencil or TUI Studio",
    handler: async (args, ctx) => runSkill(pi, args, ctx, buildSketchPrompt),
  });

  // ── gs:cleanup ──
  pi.registerCommand("gs:cleanup", {
    description: "Clean up completed task folders from vault",
    handler: async (args, ctx) => runSkill(pi, args, ctx, buildCleanupPrompt),
  });

  // ── Ctrl+W shortcut — quick hub access ──
  pi.registerShortcut("ctrl+w", {
    description: "Open workflow hub",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      const result = await openHub(pi, ctx);
      if (!result) return;

      if (result.type === "config") {
        const skillCtx = buildSkillContext(ctx.cwd);
        const configPath = join(skillCtx.gitRoot ?? ctx.cwd, ".pi", "workflow.json");
        if (existsSync(configPath)) {
          pi.sendUserMessage(`Read and display the config at ${configPath}, then ask if I want to change anything.`);
        } else {
          const config = await loadConfig(ctx.cwd);
          const prompt = buildInitPrompt("", config, skillCtx);
          pi.sendUserMessage(prompt);
        }
        return;
      }

      if (result.type === "run") {
        const skill = SKILLS.find(s => s.key === result.skillKey);
        if (!skill) return;

        const skillCtx = buildSkillContext(ctx.cwd);
        const config = await loadConfig(ctx.cwd);

        if (result.mode === "chain") {
          chainState = {
            currentSkill: result.skillKey,
            originalArgs: "",
            config,
            context: skillCtx,
          };
        }

        const prompt = skill.prompt("", config, skillCtx);
        pi.sendUserMessage(prompt);
      }
    },
  });

  // ── Chain mode: advance on agent_end ──
  pi.on("agent_end", async (_event, _ctx) => {
    if (chainState) {
      advanceChain(pi);
    }
  });

  // ── Status indicator ──
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("wf", "gs");
    }
  });
}
