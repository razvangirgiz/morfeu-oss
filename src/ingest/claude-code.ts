import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { App } from "../app.js";
import { withRunLock } from "../db/client.js";
import { appendEvent } from "../ledger/events.js";

/**
 * Reads Claude Code session transcripts (~/.claude/projects/<folder>/<session>.jsonl)
 * into the ledger. User and assistant text is kept; tool calls, tool output,
 * thinking and slash-command noise are not. A cursor per file remembers the
 * last complete line, so re-running only reads what was appended since.
 */

const SOURCE = "claude-code";

export type IngestOptions = {
  now: Date;
  /** Only folders whose name contains this text. */
  project?: string;
  /** At most this many session files. */
  limit?: number;
  projectsDir?: string;
};

export type IngestResult = { files: number; inserted: number; duplicates: number; skipped: number };

export type ParsedLine = {
  uuid: string;
  sessionId: string;
  timestamp: string;
  type: "user_message" | "assistant_message";
  text: string;
  cwd: string | undefined;
};

export async function ingestClaudeCode(app: App, options: IngestOptions): Promise<IngestResult> {
  return withRunLock(app.pool, "morfeu-ingest", async () => {
    const root = options.projectsDir ?? app.config.claudeProjectsDir;
    const files = sessionFiles(root, options.project, app.config.ingestExclude);
    const selected = options.limit === undefined ? files : files.slice(0, options.limit);
    const total: IngestResult = { files: selected.length, inserted: 0, duplicates: 0, skipped: 0 };
    for (const file of selected) {
      const r = await ingestFile(app, file, options.now);
      total.inserted += r.inserted;
      total.duplicates += r.duplicates;
      total.skipped += r.skipped;
    }
    return total;
  });
}

function sessionFiles(root: string, project: string | undefined, exclude: readonly string[]): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const name = dir.name.toLowerCase();
    if (project && !name.includes(project.toLowerCase())) continue;
    if (exclude.some((ex) => name.includes(ex.toLowerCase()))) continue;
    for (const file of readdirSync(join(root, dir.name))) {
      if (file.endsWith(".jsonl")) files.push(join(root, dir.name, file));
    }
  }
  return files.sort();
}

async function ingestFile(
  app: App,
  file: string,
  now: Date,
): Promise<{ inserted: number; duplicates: number; skipped: number }> {
  const cursor = await app.pool.query<{ last_line: string }>(
    "SELECT last_line FROM ingest_cursors WHERE source = $1 AND ref = $2",
    [SOURCE, file],
  );
  const startAfter = Number(cursor.rows[0]?.last_line ?? 0);
  const fileSession = basename(file, ".jsonl");
  let last = startAfter;
  let inserted = 0;
  let duplicates = 0;
  let skipped = 0;
  for await (const { lineNo, text } of completeLines(file)) {
    last = lineNo;
    if (lineNo <= startAfter) continue;
    const line = parseLine(text, fileSession);
    if (!line) {
      skipped += 1;
      continue;
    }
    const result = await appendEvent(app.pool, {
      occurred_at: new Date(line.timestamp),
      ingested_at: now,
      source: SOURCE,
      external_id: line.uuid,
      session_id: line.sessionId,
      agent_id: SOURCE,
      type: line.type,
      content: { project: projectOf(line.cwd) },
      content_text: line.text,
    });
    if (result.inserted) inserted += 1;
    else duplicates += 1;
  }
  await app.pool.query(
    `INSERT INTO ingest_cursors (source, ref, last_line, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, ref) DO UPDATE SET last_line = EXCLUDED.last_line, updated_at = EXCLUDED.updated_at`,
    [SOURCE, file, last, now],
  );
  return { inserted, duplicates, skipped };
}

/**
 * The project a session belongs to: the last segment of its working
 * directory. Sessions started in the home directory belong to no project.
 */
export function projectOf(cwd: string | undefined, home = homedir()): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === home.replace(/[\\/]+$/, "")) return "";
  return basename(trimmed).toLowerCase();
}

/** One transcript line to an event, or null for anything that is not user or assistant prose. */
export function parseLine(raw: string, fileSession: string): ParsedLine | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = row.type;
  if (type !== "user" && type !== "assistant") return null;
  if (row.isMeta === true || row.isSidechain === true) return null;
  const uuid = typeof row.uuid === "string" ? row.uuid : "";
  const timestamp = typeof row.timestamp === "string" ? row.timestamp : "";
  if (!uuid || Number.isNaN(Date.parse(timestamp))) return null;
  const message = (row.message ?? {}) as { content?: unknown };
  const text = textOf(message.content);
  if (!text || (type === "user" && isCommandNoise(text))) return null;
  return {
    uuid,
    sessionId: typeof row.sessionId === "string" && row.sessionId ? row.sessionId : fileSession,
    timestamp,
    type: type === "user" ? "user_message" : "assistant_message",
    text,
    cwd: typeof row.cwd === "string" ? row.cwd : undefined,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Slash commands and their wrappers carry no memory. */
export function isCommandNoise(text: string): boolean {
  if (/<command-name>|<command-message>|<local-command-(caveat|stdout)>/.test(text)) return true;
  const words = text.trim().split(/\s+/);
  return words.length <= 2 && /^\/[a-zA-Z][\w:-]*$/.test(words[0] ?? "");
}

/**
 * Yields only newline-terminated lines. A trailing fragment (a write in
 * progress) is left for a later run, once complete.
 */
async function* completeLines(file: string): AsyncGenerator<{ lineNo: number; text: string }> {
  let buffer = "";
  let lineNo = 0;
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const text = buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
      lineNo += 1;
      yield { lineNo, text };
    }
  }
}
