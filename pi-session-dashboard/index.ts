import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  Key,
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { readdir, readFile, rm, mkdir, rename, writeFile } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────

interface SessionInfo {
  filePath: string;
  dirName: string;
  fileName: string;
  project: string;
  cwd: string;
  timestamp: string;
  id: string;
  name?: string;
  model?: string;
  entryCount: number;
  lastMessage?: string;
}

interface ProjectGroup {
  project: string;
  cwd: string;
  sessions: SessionInfo[];
}

type DashboardAction =
  | { type: "open"; sessionPath: string }
  | { type: "create"; cwd: string; project: string; name?: string }
  | { type: "delete"; sessionPath: string }
  | { type: "archive"; sessionPath: string }
  | { type: "addProject"; path: string };

// ── Paths ─────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? "";
const SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const ARCHIVE_DIR = join(SESSIONS_DIR, "archive");
const PROJECTS_CONFIG = join(HOME, ".pi/agent/session-projects.json");

// ── Project Config ────────────────────────────────────────────────────

async function loadProjectDirs(): Promise<string[]> {
  try {
    const raw = await readFile(PROJECTS_CONFIG, "utf-8");
    const dirs = JSON.parse(raw);
    return Array.isArray(dirs) ? dirs.filter((d: any) => typeof d === "string") : [];
  } catch {
    return [];
  }
}

async function saveProjectDirs(dirs: string[]): Promise<void> {
  const unique = [...new Set(dirs)].sort();
  await writeFile(PROJECTS_CONFIG, JSON.stringify(unique, null, 2) + "\n", "utf-8");
}

async function addProjectDir(dir: string): Promise<void> {
  const dirs = await loadProjectDirs();
  const resolved = dir.startsWith("~") ? join(HOME, dir.slice(1)) : dir;
  if (!dirs.includes(resolved)) {
    dirs.push(resolved);
    await saveProjectDirs(dirs);
  }
}

// ── Session Scanner ────────────────────────────────────────────────────

async function scanSessions(): Promise<ProjectGroup[]> {
  const groups = new Map<string, ProjectGroup>();

  // Scan existing session directories
  if (existsSync(SESSIONS_DIR)) {
    const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "archive") continue;

      const dirPath = join(SESSIONS_DIR, entry.name);
      let files: string[];
      try {
        files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(dirPath, file);
        const info = await parseSessionHeader(filePath, entry.name, file);
        if (!info) continue;

        const existing = groups.get(info.cwd);
        if (existing) {
          existing.sessions.push(info);
        } else {
          groups.set(info.cwd, {
            project: info.project,
            cwd: info.cwd,
            sessions: [info],
          });
        }
      }
    }
  }

  // Add configured project dirs (even if they have no sessions yet)
  const configDirs = await loadProjectDirs();
  for (const dir of configDirs) {
    if (!groups.has(dir) && existsSync(dir)) {
      const project = basename(dir);
      groups.set(dir, { project, cwd: dir, sessions: [] });
    }
  }

  const result = Array.from(groups.values());
  for (const group of result) {
    group.sessions.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
  result.sort(
    (a, b) =>
      new Date(b.sessions[0]?.timestamp ?? 0).getTime() -
      new Date(a.sessions[0]?.timestamp ?? 0).getTime()
  );

  return result;
}

async function parseSessionHeader(
  filePath: string,
  dirName: string,
  fileName: string
): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    const header = JSON.parse(lines[0]);
    if (header.type !== "session") return null;

    const cwd = header.cwd ?? "";
    const project = cwd.split("/").pop() || "unknown";

    let lastMessage: string | undefined;
    let model: string | undefined;
    let name: string | undefined;
    const entryCount = lines.length;

    // Scan first ~20 lines for session_info (name) and model_change
    for (const line of lines.slice(1, 20)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session_info" && entry.name) {
          name = entry.name;
        }
        if (entry.type === "session_name" && entry.name) {
          name = entry.name;
        }
        if (entry.type === "model_change" && !model) {
          model = entry.model;
        }
      } catch {
        // skip
      }
    }

    // Scan tail for last user message and late model changes
    const tail = lines.slice(-20);
    for (const line of tail) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message?.role === "user") {
          const text =
            typeof entry.message.content === "string"
              ? entry.message.content
              : entry.message.content?.[0]?.text ?? "";
          if (text) lastMessage = text;
        }
        if (entry.type === "session_info" && entry.name) {
          name = entry.name;
        }
        if (entry.type === "session_name" && entry.name) {
          name = entry.name;
        }
      } catch {
        // skip
      }
    }

    return {
      filePath,
      dirName,
      fileName,
      project,
      cwd,
      timestamp: header.timestamp,
      id: header.id,
      name,
      model,
      entryCount,
      lastMessage,
    };
  } catch {
    return null;
  }
}

// ── Create session in a specific directory ─────────────────────────────

async function createSessionInDir(cwd: string, name?: string): Promise<string> {
  const encoded = "--" + cwd.slice(1).replace(/[/\\:]/g, "-") + "--";
  const dir = join(SESSIONS_DIR, encoded);
  await mkdir(dir, { recursive: true });

  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const safeTs = timestamp.replace(/[:.]/g, "-");
  const filename = `${safeTs}_${id}.jsonl`;
  const filePath = join(dir, filename);

  let content = JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd,
  }) + "\n";

  if (name) {
    content += JSON.stringify({ type: "session_info", name }) + "\n";
  }

  await writeFile(filePath, content, "utf-8");

  return filePath;
}

// ── Dashboard TUI Component ───────────────────────────────────────────

type Mode = "browse" | "create" | "addProject";

class SessionDashboard implements Component {
  private projects: ProjectGroup[];
  private selectedProjectIdx = 0;
  private selectedSessionIdx = 0;
  private focusPane: "projects" | "sessions" = "projects";
  private mode: Mode = "browse";
  private nameInput = "";
  private pathInput = "";
  private scrollOffsetProjects = 0;
  private scrollOffsetSessions = 0;
  private theme: Theme;
  private done: (result: DashboardAction | null) => void;
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(
    projects: ProjectGroup[],
    theme: Theme,
    done: (result: DashboardAction | null) => void
  ) {
    this.projects = projects;
    this.theme = theme;
    this.done = done;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  handleInput(data: string): void {
    // ── Input modes (create / addProject) ──
    if (this.mode === "create") {
      if (matchesKey(data, Key.escape)) {
        this.mode = "browse";
        this.nameInput = "";
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const project = this.projects[this.selectedProjectIdx];
        if (project) {
          const name = this.nameInput.trim() || undefined;
          this.done({ type: "create", cwd: project.cwd, project: project.project, name });
        }
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.nameInput = this.nameInput.slice(0, -1);
        this.invalidate();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.nameInput += data;
        this.invalidate();
        return;
      }
      return;
    }

    if (this.mode === "addProject") {
      if (matchesKey(data, Key.escape)) {
        this.mode = "browse";
        this.pathInput = "";
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const path = this.pathInput.trim();
        if (path) {
          this.done({ type: "addProject", path });
        }
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.pathInput = this.pathInput.slice(0, -1);
        this.invalidate();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.pathInput += data;
        this.invalidate();
        return;
      }
      return;
    }

    // ── Browse mode ──
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.done(null);
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.focusPane =
        this.focusPane === "projects" ? "sessions" : "projects";
      this.invalidate();
      return;
    }

    if (matchesKey(data, "l") || matchesKey(data, Key.right)) {
      if (this.focusPane === "projects") {
        this.focusPane = "sessions";
        this.selectedSessionIdx = 0;
        this.scrollOffsetSessions = 0;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, "h") || matchesKey(data, Key.left)) {
      if (this.focusPane === "sessions") {
        this.focusPane = "projects";
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
      if (this.focusPane === "projects") {
        if (this.selectedProjectIdx < this.projects.length - 1) {
          this.selectedProjectIdx++;
          this.selectedSessionIdx = 0;
          this.scrollOffsetSessions = 0;
        }
      } else {
        const sessions = this.currentSessions();
        if (this.selectedSessionIdx < sessions.length - 1) {
          this.selectedSessionIdx++;
        }
      }
      this.invalidate();
      return;
    }

    if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
      if (this.focusPane === "projects") {
        if (this.selectedProjectIdx > 0) {
          this.selectedProjectIdx--;
          this.selectedSessionIdx = 0;
          this.scrollOffsetSessions = 0;
        }
      } else {
        if (this.selectedSessionIdx > 0) {
          this.selectedSessionIdx--;
        }
      }
      this.invalidate();
      return;
    }

    if (matchesKey(data, "g")) {
      if (this.focusPane === "projects") {
        this.selectedProjectIdx = 0;
        this.selectedSessionIdx = 0;
        this.scrollOffsetSessions = 0;
      } else {
        this.selectedSessionIdx = 0;
      }
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.shift("g"))) {
      if (this.focusPane === "projects") {
        this.selectedProjectIdx = Math.max(0, this.projects.length - 1);
        this.selectedSessionIdx = 0;
        this.scrollOffsetSessions = 0;
      } else {
        const sessions = this.currentSessions();
        this.selectedSessionIdx = Math.max(0, sessions.length - 1);
      }
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.focusPane === "projects") {
        this.focusPane = "sessions";
        this.selectedSessionIdx = 0;
        this.scrollOffsetSessions = 0;
      } else {
        const session = this.currentSession();
        if (session) {
          this.done({ type: "open", sessionPath: session.filePath });
        }
      }
      this.invalidate();
      return;
    }

    if (matchesKey(data, "d")) {
      if (this.focusPane === "sessions") {
        const session = this.currentSession();
        if (session) {
          this.done({ type: "delete", sessionPath: session.filePath });
        }
      }
      return;
    }

    if (matchesKey(data, "a")) {
      if (this.focusPane === "projects") {
        this.mode = "addProject";
        this.pathInput = "~/dev/";
        this.invalidate();
      } else {
        const session = this.currentSession();
        if (session) {
          this.done({ type: "archive", sessionPath: session.filePath });
        }
      }
      return;
    }

    if (matchesKey(data, "n")) {
      const project = this.projects[this.selectedProjectIdx];
      if (project) {
        this.mode = "create";
        this.nameInput = "";
        this.invalidate();
      }
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
    const title = " Sessions ";
    const titleLen = visibleWidth(title);
    const topAfterTitle = innerWidth - titleLen - 1;
    lines.push(
      border("┌─") +
        t.fg("accent", t.bold(title)) +
        border("─".repeat(Math.max(0, topAfterTitle)) + "┐")
    );

    // ── Subtitle ──
    const subtitle = "Browse and switch between Pi sessions";
    lines.push(
      border("│") +
        " " +
        t.fg("muted", truncateToWidth(subtitle, innerWidth - 1)) +
        padTo(subtitle, innerWidth) +
        border("│")
    );
    lines.push(border("├" + "─".repeat(innerWidth) + "┤"));

    // ── Create dialog ──
    if (this.mode === "create") {
      const project = this.projects[this.selectedProjectIdx];
      lines.push(boxLine("", innerWidth, border));
      lines.push(
        boxLine(
          "  " + t.fg("accent", t.bold("New Session")),
          innerWidth,
          border
        )
      );
      lines.push(boxLine("", innerWidth, border));
      lines.push(
        boxLine(
          "  " +
            t.fg("muted", "Project: ") +
            t.bold(project?.project ?? "unknown"),
          innerWidth,
          border
        )
      );
      const shortCwd = shortenPath(project?.cwd ?? "");
      lines.push(
        boxLine(
          "  " + t.fg("muted", "Path:    ") + t.fg("dim", shortCwd),
          innerWidth,
          border
        )
      );
      lines.push(boxLine("", innerWidth, border));
      const cursor = "█";
      const inputDisplay = this.nameInput + cursor;
      lines.push(
        boxLine(
          "  " +
            t.fg("muted", "Title:   ") +
            truncateToWidth(inputDisplay, innerWidth - 13),
          innerWidth,
          border
        )
      );
      lines.push(boxLine("", innerWidth, border));
      lines.push(
        boxLine(
          "  " + t.fg("muted", "[Enter] create  [Esc] cancel"),
          innerWidth,
          border
        )
      );
      lines.push(boxLine("", innerWidth, border));
      lines.push(border("└" + "─".repeat(innerWidth) + "┘"));
      this.cachedLines = lines;
      this.cachedWidth = width;
      return lines;
    }

    // ── Add project dialog ──
    if (this.mode === "addProject") {
      lines.push(boxLine("", innerWidth, border));
      lines.push(
        boxLine(
          "  " + t.fg("accent", t.bold("Add Project")),
          innerWidth,
          border
        )
      );
      lines.push(boxLine("", innerWidth, border));
      const cursor = "█";
      const inputDisplay = this.pathInput + cursor;
      lines.push(
        boxLine(
          "  " +
            t.fg("muted", "Path: ") +
            truncateToWidth(inputDisplay, innerWidth - 10),
          innerWidth,
          border
        )
      );
      lines.push(boxLine("", innerWidth, border));
      lines.push(
        boxLine(
          "  " + t.fg("muted", "[Enter] add  [Esc] cancel"),
          innerWidth,
          border
        )
      );
      lines.push(boxLine("", innerWidth, border));
      lines.push(border("└" + "─".repeat(innerWidth) + "┘"));
      this.cachedLines = lines;
      this.cachedWidth = width;
      return lines;
    }

    // ── Empty state ──
    if (this.projects.length === 0) {
      lines.push(
        boxLine(t.fg("muted", "  No sessions found."), innerWidth, border)
      );
      lines.push(boxLine("", innerWidth, border));
      lines.push(
        boxLine(
          t.fg("muted", "  Press [a] to add a project directory."),
          innerWidth,
          border
        )
      );
      lines.push(
        boxLine(
          t.fg("muted", "  Press [esc] to close."),
          innerWidth,
          border
        )
      );
      lines.push(border("└" + "─".repeat(innerWidth) + "┘"));
      this.cachedLines = lines;
      this.cachedWidth = width;
      return lines;
    }

    // ── Two-pane content ──
    const leftWidth = Math.min(Math.floor(innerWidth * 0.35), 40);
    const rightWidth = innerWidth - leftWidth - 1;
    const maxRows = 18;

    const leftLines = this.renderProjectList(leftWidth, maxRows);
    const rightLines = this.renderSessionList(rightWidth, maxRows);

    const height = Math.max(leftLines.length, rightLines.length);
    while (leftLines.length < height) leftLines.push(padStr("", leftWidth));
    while (rightLines.length < height)
      rightLines.push(padStr("", rightWidth));

    const midSep = border("│");
    for (let i = 0; i < height; i++) {
      lines.push(
        border("│") + leftLines[i] + midSep + rightLines[i] + border("│")
      );
    }

    // ── Footer ──
    lines.push(border("├" + "─".repeat(innerWidth) + "┤"));
    const footerKeys =
      this.focusPane === "projects"
        ? "[j/k] navigate  [l/enter] open  [n] new  [a] add project  [q] close"
        : "[j/k] navigate  [enter] switch  [h] back  [d] del  [a] archive  [n] new  [q] close";
    lines.push(
      boxLine(" " + t.fg("muted", footerKeys), innerWidth, border)
    );
    lines.push(border("└" + "─".repeat(innerWidth) + "┘"));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderProjectList(width: number, maxRows: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const header =
      this.focusPane === "projects"
        ? t.fg("accent", t.bold(truncateToWidth(" Projects", width)))
        : t.fg("muted", t.bold(truncateToWidth(" Projects", width)));
    lines.push(padStr(header, width));
    lines.push(t.fg("borderMuted", "─".repeat(width)));

    const visibleCount = maxRows - 2;
    if (this.selectedProjectIdx >= this.scrollOffsetProjects + visibleCount) {
      this.scrollOffsetProjects = this.selectedProjectIdx - visibleCount + 1;
    }
    if (this.selectedProjectIdx < this.scrollOffsetProjects) {
      this.scrollOffsetProjects = this.selectedProjectIdx;
    }

    const visibleProjects = this.projects.slice(
      this.scrollOffsetProjects,
      this.scrollOffsetProjects + visibleCount
    );

    for (let i = 0; i < visibleProjects.length; i++) {
      const group = visibleProjects[i];
      const idx = i + this.scrollOffsetProjects;
      const isSelected = idx === this.selectedProjectIdx;
      const isFocused = isSelected && this.focusPane === "projects";

      const icon = isSelected ? "▸" : " ";
      const count = t.fg("muted", `(${group.sessions.length})`);
      const name = truncateToWidth(group.project, width - 8);

      let line = ` ${icon} ${name} ${count}`;
      line = truncateToWidth(line, width);
      line = padStr(line, width);

      if (isFocused) {
        line = t.bg("selectedBg", line);
      } else if (isSelected) {
        line = t.fg("accent", line);
      }

      lines.push(line);
    }

    if (this.projects.length > visibleCount) {
      const indicator = `${this.scrollOffsetProjects + 1}-${Math.min(this.scrollOffsetProjects + visibleCount, this.projects.length)}/${this.projects.length}`;
      lines.push(t.fg("muted", padStr(` ${indicator}`, width)));
    }

    return lines;
  }

  private renderSessionList(width: number, maxRows: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const sessions = this.currentSessions();

    const project = this.projects[this.selectedProjectIdx];
    const headerText = project ? ` ${project.project}` : " Sessions";
    const header =
      this.focusPane === "sessions"
        ? t.fg("accent", t.bold(truncateToWidth(headerText, width)))
        : t.fg("muted", t.bold(truncateToWidth(headerText, width)));
    lines.push(padStr(header, width));
    lines.push(t.fg("borderMuted", "─".repeat(width)));

    if (sessions.length === 0) {
      lines.push(t.fg("muted", padStr("  No sessions", width)));
      lines.push(t.fg("dim", padStr("  Press [n] to create one", width)));
      return lines;
    }

    const rowsPerSession = 3;
    const visibleCount = Math.floor((maxRows - 2) / rowsPerSession);
    if (this.selectedSessionIdx >= this.scrollOffsetSessions + visibleCount) {
      this.scrollOffsetSessions = this.selectedSessionIdx - visibleCount + 1;
    }
    if (this.selectedSessionIdx < this.scrollOffsetSessions) {
      this.scrollOffsetSessions = this.selectedSessionIdx;
    }

    const visibleSessions = sessions.slice(
      this.scrollOffsetSessions,
      this.scrollOffsetSessions + visibleCount
    );

    for (let i = 0; i < visibleSessions.length; i++) {
      const session = visibleSessions[i];
      const idx = i + this.scrollOffsetSessions;
      const isSelected = idx === this.selectedSessionIdx;
      const isFocused = isSelected && this.focusPane === "sessions";

      const ts = formatTimestamp(session.timestamp);
      const entries = t.fg("dim", ` [${session.entryCount}]`);
      const title = session.name
        ? t.bold(truncateToWidth(session.name, width - 20))
        : ts;
      const meta = session.name ? t.fg("muted", ` ${ts}`) : "";
      const model = session.model ? t.fg("muted", ` ${session.model}`) : "";
      let line1 = ` ${isSelected ? "▸" : " "} ${title}${meta}${model}${entries}`;
      line1 = truncateToWidth(line1, width);
      line1 = padStr(line1, width);

      const preview = session.lastMessage
        ? truncateToWidth(session.lastMessage.replace(/\n/g, " "), width - 6)
        : t.fg("dim", "no messages");
      let line2 = `    ${preview}`;
      line2 = truncateToWidth(line2, width);
      line2 = padStr(line2, width);

      if (isFocused) {
        line1 = t.bg("selectedBg", line1);
        line2 = t.bg("selectedBg", line2);
      }

      lines.push(line1);
      lines.push(line2);

      if (i < visibleSessions.length - 1) {
        lines.push(
          t.fg("borderMuted", padStr("  " + "·".repeat(width - 4), width))
        );
      }
    }

    if (sessions.length > visibleCount) {
      const indicator = `${this.scrollOffsetSessions + 1}-${Math.min(this.scrollOffsetSessions + visibleCount, sessions.length)}/${sessions.length}`;
      lines.push(t.fg("muted", padStr(` ${indicator}`, width)));
    }

    return lines;
  }

  private currentSessions(): SessionInfo[] {
    return this.projects[this.selectedProjectIdx]?.sessions ?? [];
  }

  private currentSession(): SessionInfo | undefined {
    return this.currentSessions()[this.selectedSessionIdx];
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

function padStr(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width);
  return text + " ".repeat(width - w);
}

function padTo(text: string, innerWidth: number): string {
  const w = visibleWidth(text);
  const remaining = innerWidth - w - 1;
  return remaining > 0 ? " ".repeat(remaining) : "";
}

function boxLine(
  content: string,
  innerWidth: number,
  border: (s: string) => string
): string {
  return border("│") + padStr(content, innerWidth) + border("│");
}

function shortenPath(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return `today ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    } else if (diffDays === 1) {
      return `yesterday ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: diffDays > 365 ? "numeric" : undefined,
      });
    }
  } catch {
    return ts;
  }
}

// ── Shared dashboard opener ───────────────────────────────────────────

async function openDashboard(
  ui: { custom: any; setWorkingMessage: any }
): Promise<DashboardAction | null> {
  ui.setWorkingMessage("Scanning sessions...");
  const projects = await scanSessions();
  ui.setWorkingMessage(undefined);

  return ui.custom(
    (_tui: any, theme: Theme, _keybindings: any, done: (r: DashboardAction | null) => void) =>
      new SessionDashboard(projects, theme, done),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        maxHeight: "90%",
        anchor: "center",
      },
    }
  );
}

// ── Process in-place actions (don't exit dashboard) ───────────────────

async function processInPlaceAction(
  result: DashboardAction,
  ui: { notify: any; confirm: any }
): Promise<void> {
  switch (result.type) {
    case "delete": {
      const confirmed = await ui.confirm(
        "Delete session",
        "Are you sure? This cannot be undone."
      );
      if (confirmed) {
        try {
          await rm(result.sessionPath);
          ui.notify("Session deleted", "info");
        } catch (e: any) {
          ui.notify(`Failed to delete: ${e.message}`, "error");
        }
      }
      break;
    }

    case "archive": {
      try {
        await mkdir(ARCHIVE_DIR, { recursive: true });
        const dest = join(ARCHIVE_DIR, basename(result.sessionPath));
        await rename(result.sessionPath, dest);
        ui.notify("Session archived", "info");
      } catch (e: any) {
        ui.notify(`Failed to archive: ${e.message}`, "error");
      }
      break;
    }

    case "addProject": {
      const resolved = result.path.startsWith("~")
        ? join(HOME, result.path.slice(1))
        : result.path;
      if (!existsSync(resolved)) {
        ui.notify(`Directory not found: ${result.path}`, "error");
        break;
      }
      await addProjectDir(resolved);
      ui.notify(`Added ${basename(resolved)}`, "info");
      break;
    }
  }
}

// Returns an exit action (open/create) or null (user closed)
function isExitAction(result: DashboardAction): boolean {
  return result.type === "open" || result.type === "create";
}

// ── Dashboard loop — stays open until user exits or switches ──────────

async function dashboardLoop(
  ui: { custom: any; setWorkingMessage: any; notify: any; confirm: any },
  onExit: (result: DashboardAction) => Promise<void>
): Promise<void> {
  while (true) {
    const result = await openDashboard(ui);
    if (!result) return; // q/esc

    if (isExitAction(result)) {
      await onExit(result);
      return;
    }

    // In-place action: process and re-open
    await processInPlaceAction(result, ui);
  }
}

// ── Extension Entry Point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Path selected from ctrl+s shortcut — consumed by /sessions command
  let pendingSwitchPath: string | null = null;

  // ctrl+s shortcut — opens dashboard, queues switch for /sessions
  pi.registerShortcut("ctrl+s", {
    description: "Open session dashboard",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      // Custom loop: "create" is in-place (stays open), "open" queues switch
      while (true) {
        const result = await openDashboard(ctx.ui);
        if (!result) return; // q/esc

        if (result.type === "open") {
          pendingSwitchPath = result.sessionPath;
          ctx.ui.notify(`Type /sessions to switch`, "info");
          return;
        }

        if (result.type === "create") {
          const filePath = await createSessionInDir(result.cwd, result.name);
          ctx.ui.notify(`Session created for ${result.project}`, "info");
          // Stay in dashboard — re-opens so user can see and select the new session
          continue;
        }

        // In-place actions (delete, archive, addProject)
        await processInPlaceAction(result, ctx.ui);
      }
    },
  });

  // /sessions command — opens dashboard or switches to pending session
  pi.registerCommand("sessions", {
    description: "Browse Pi sessions grouped by project",

    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Session dashboard requires a TUI", "warning");
        return;
      }

      // Auto-switch if ctrl+s already selected a session
      if (!args.trim() && pendingSwitchPath) {
        const path = pendingSwitchPath;
        pendingSwitchPath = null;
        await ctx.switchSession(path);
        return;
      }

      // Handle direct switch
      if (args.startsWith("--switch ")) {
        const path = args.slice("--switch ".length).trim();
        await ctx.switchSession(path);
        return;
      }

      // Full dashboard
      await dashboardLoop(ctx.ui, async (result) => {
        if (result.type === "create") {
          const filePath = await createSessionInDir(result.cwd, result.name);
          ctx.ui.notify(`Session created for ${result.project}`, "info");
          await ctx.switchSession(filePath);
        } else if (result.type === "open") {
          await ctx.switchSession(result.sessionPath);
        }
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("dash", "loaded");
    }
  });
}
