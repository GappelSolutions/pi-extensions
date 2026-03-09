import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

// ── Project Detection ───────────────────────────────────────────────────

async function detectProject(cwd: string): Promise<string> {
  let dir = cwd;
  while (true) {
    const configPath = join(dir, ".pi", "workflow.json");
    if (existsSync(configPath)) {
      try {
        const raw = await readFile(configPath, "utf-8");
        const config = JSON.parse(raw);
        if (config.lazylink?.project) return config.lazylink.project;
      } catch { /* fall through */ }
      break;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return basename(cwd);
}

// ── Agent ID ─────────────────────────────────────────────────────────────

let cachedAgentId: string | undefined;

function getAgentId(): string {
  if (cachedAgentId) return cachedAgentId;
  const pid = process.ppid ?? process.pid;
  const idFile = `/tmp/lazylink-agent-${pid}`;
  try {
    if (existsSync(idFile)) {
      const id = readFileSync(idFile, "utf-8").trim();
      if (id) { cachedAgentId = id; return id; }
    }
  } catch { /* generate new */ }
  cachedAgentId = `pi-${Math.random().toString(36).slice(2, 10)}`;
  try { writeFileSync(idFile, cachedAgentId); } catch { /* ok */ }
  return cachedAgentId;
}

// ── Lazylink CLI Wrapper ────────────────────────────────────────────────

async function ll(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await pi.exec("lazylink", args, { cwd, timeout: 10000 });
    return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e.message ?? "lazylink not found" };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Summarize a tool execution into a short human-readable string */
function summarizeTool(toolName: string, args: any, result: any, isError: boolean): string {
  if (isError) return `${toolName} failed`;

  switch (toolName) {
    case "bash":
    case "Bash": {
      const cmd = args?.command ?? "";
      const short = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
      return `ran: ${short}`;
    }
    case "read":
    case "Read": {
      const path = args?.file_path ?? args?.path ?? "";
      return `read ${basename(path)}`;
    }
    case "write":
    case "Write": {
      const path = args?.file_path ?? args?.path ?? "";
      return `wrote ${basename(path)}`;
    }
    case "edit":
    case "Edit": {
      const path = args?.file_path ?? args?.path ?? "";
      return `edited ${basename(path)}`;
    }
    case "grep":
    case "Grep": {
      const pattern = args?.pattern ?? "";
      return `searched for "${pattern}"`;
    }
    case "glob":
    case "Glob": {
      const pattern = args?.pattern ?? "";
      return `globbed ${pattern}`;
    }
    default:
      return `${toolName}`;
  }
}

/** Throttle: only call fn at most once per interval ms */
function throttle<T extends (...a: any[]) => Promise<void>>(fn: T, interval: number): T {
  let last = 0;
  let pending: Promise<void> | null = null;
  return ((...args: any[]) => {
    const now = Date.now();
    if (now - last < interval) return pending ?? Promise.resolve();
    last = now;
    pending = fn(...args);
    return pending;
  }) as T;
}

// ── Extension Entry Point ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // Accumulate tool actions within a turn for batched updates
  let turnActions: string[] = [];
  let currentProject: string | undefined;
  let currentCwd: string | undefined;

  // ── Context injection (every LLM call) ──
  pi.on("context", async (_event, ctx) => {
    const project = await detectProject(ctx.cwd);
    const agent = getAgentId();
    currentProject = project;
    currentCwd = ctx.cwd;

    const result = await ll(pi, ["status", "--project", project, "--agent", agent], ctx.cwd);
    if (!result.ok) return;

    const output = result.stdout.trim();
    // Skip if empty status
    if (!output || output.split("\n").length <= 2) return;

    return {
      messages: [{
        role: "user" as const,
        content: [{
          type: "text" as const,
          text: `<lazylink>\n${output}\n</lazylink>`,
        }],
      }],
    };
  });

  // ── Heartbeat on turn_start ──
  pi.on("turn_start", async (_event, ctx) => {
    turnActions = [];
    const project = await detectProject(ctx.cwd);
    const agent = getAgentId();
    currentProject = project;
    currentCwd = ctx.cwd;
    await ll(pi, ["msg", "send", "turn started", "--agent", agent, "--project", project, "--type", "status"], ctx.cwd);
  });

  // ── Track tool executions ──
  pi.on("tool_execution_end", async (event, ctx) => {
    const summary = summarizeTool(event.toolName, undefined, event.result, event.isError);
    turnActions.push(summary);

    // Throttled progress update every 15s max
    await throttledProgress(pi, ctx.cwd);
  });

  // Post progress at most every 15 seconds
  const throttledProgress = throttle(async (pi: ExtensionAPI, cwd: string) => {
    if (turnActions.length === 0) return;
    const project = currentProject ?? await detectProject(cwd);
    const agent = getAgentId();
    const recent = turnActions.slice(-5).join("; ");
    await ll(pi, ["msg", "send", `progress: ${recent}`, "--agent", agent, "--project", project, "--type", "status"], cwd);
  }, 15000);

  // ── Turn end: post summary of what happened ──
  pi.on("turn_end", async (event, ctx) => {
    if (turnActions.length === 0) return;
    const project = currentProject ?? await detectProject(ctx.cwd);
    const agent = getAgentId();

    // Summarize what the agent did this turn
    const actionSummary = turnActions.length <= 5
      ? turnActions.join("; ")
      : `${turnActions.slice(0, 3).join("; ")}; ... and ${turnActions.length - 3} more actions`;

    await ll(pi, [
      "msg", "send", `turn complete (${turnActions.length} actions): ${actionSummary}`,
      "--agent", agent, "--project", project, "--type", "result",
    ], ctx.cwd);

    // Record heartbeat
    await ll(pi, ["msg", "send", "heartbeat", "--agent", agent, "--project", project, "--type", "status"], ctx.cwd);

    turnActions = [];
  });

  // ── Agent end: final status ──
  pi.on("agent_end", async (_event, ctx) => {
    const project = currentProject ?? await detectProject(ctx.cwd);
    const agent = getAgentId();
    await ll(pi, [
      "msg", "send", "agent session ended",
      "--agent", agent, "--project", project, "--type", "status",
    ], ctx.cwd);
  });

  // ── Status bar ──
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const project = await detectProject(ctx.cwd);
    const result = await ll(pi, ["task", "list", "--project", project, "--format", "json"], ctx.cwd);

    if (result.ok) {
      try {
        const tasks = JSON.parse(result.stdout);
        const active = tasks.filter((t: any) => t.state === "in_progress" || t.state === "blocked").length;
        const backlog = tasks.filter((t: any) => t.state === "backlog").length;
        const parts: string[] = [];
        if (active > 0) parts.push(`${active}a`);
        if (backlog > 0) parts.push(`${backlog}b`);
        ctx.ui.setStatus("ll", parts.length > 0 ? `ll:${parts.join("/")}` : "ll");
      } catch {
        ctx.ui.setStatus("ll", "ll");
      }
    } else {
      ctx.ui.setStatus("ll", "ll");
    }
  });
}
