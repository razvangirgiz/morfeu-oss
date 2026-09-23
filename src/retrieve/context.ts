import type { App } from "../app.js";
import type { Memory, MemoryType, Scope } from "../core/types.js";
import { errorMessage, Params } from "../db/client.js";
import { listPinned } from "../memory/pins.js";
import { MEMORY_COLUMNS, mapMemory } from "../memory/row.js";
import { scopeSql, servingSql } from "../memory/serving.js";
import { recordUsage } from "../memory/usage.js";
import { resolveScope } from "../memory/write.js";
import { search } from "./search.js";
import { formatWhen, localTimeZone, nowHeader } from "./when.js";

export type ContextOptions = {
  now: Date;
  /** Undefined means every scope; an empty list serves only the clock. */
  scopes?: readonly Scope[];
  /** Restricts the RELEVANT section to these memory types. */
  types?: readonly MemoryType[];
  /** Approximate size limit in tokens (4 characters each). The [NOW] line is always included. */
  tokenBudget?: number;
  includeCandidates?: boolean;
  queryVector?: readonly number[];
  skipSemantic?: boolean;
  recordUsage?: boolean;
  timeZone?: string;
};

export type CompiledContext = {
  markdown: string;
  /** Memory ids that made it into the markdown, in order. */
  memoryIds: string[];
  warnings: string[];
};

export const DEFAULT_TOKEN_BUDGET = 2000;
const RECENT_DAYS = 7;
const NOTHING_RELEVANT = "- (no relevant memories found)";

type Section = { title: string; memories: Memory[] };

/**
 * The context an agent reads at the start of a task, as compact markdown:
 *
 *   [NOW]            the serving machine's clock, so the agent can date things
 *   [INSTRUCTIONS]   standing rules for the requested agent scopes
 *   [PINNED]         memories the user chose to always include
 *   [PROJECT STATE]  current state of the requested projects
 *   [RELEVANT]       the best search hits for the task
 *   [RECENT]         what was learned in the last week
 *
 * Each memory appears once, in the first section that claims it, followed by
 * its age and id. Sections fill in that order until the budget runs out.
 */
export async function compileContext(app: App, task: string, options: ContextOptions): Promise<CompiledContext> {
  const { now } = options;
  const timeZone = options.timeZone ?? localTimeZone();
  const header = nowHeader(now, timeZone);
  const scopes = options.scopes?.map((s) => resolveScope(s, app.config.userId));
  if (scopes?.length === 0) return { markdown: header, memoryIds: [], warnings: [] };

  const relevant = await search(app, task, {
    now,
    scopes,
    types: options.types,
    limit: 10,
    includeCandidates: options.includeCandidates,
    queryVector: options.queryVector,
    skipSemantic: options.skipSemantic,
  });
  const sections: Section[] = [
    { title: "INSTRUCTIONS", memories: await instructions(app, now, scopes) },
    { title: "PINNED", memories: await listPinned(app.pool, now, scopes) },
    { title: "PROJECT STATE", memories: await projectState(app, now, scopes) },
    { title: "RELEVANT", memories: relevant.hits.map((h) => h.memory) },
    { title: "RECENT", memories: await recent(app, now, scopes) },
  ];

  const budget = (options.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * 4;
  const lines = [header];
  const memoryIds: string[] = [];
  let used = header.length;
  const seen = new Set<string>();
  for (const section of sections) {
    const fresh = section.memories.filter((m) => !seen.has(m.id));
    for (const m of fresh) seen.add(m.id);
    const title = `\n[${section.title}]`;
    const body: string[] = [];
    // Each line costs its length plus the newline that joins it.
    let size = title.length + 1;
    for (const memory of fresh) {
      const full = renderLine(memory, now, timeZone, true);
      const line = used + size + full.length + 1 <= budget ? full : renderLine(memory, now, timeZone, false);
      if (used + size + line.length + 1 > budget) continue;
      body.push(line);
      memoryIds.push(memory.id);
      size += line.length + 1;
    }
    if (body.length === 0) {
      if (section.title !== "RELEVANT") continue;
      body.push(NOTHING_RELEVANT);
      size += NOTHING_RELEVANT.length + 1;
    }
    if (used + size > budget) continue;
    lines.push(title, ...body);
    used += size;
  }

  if (options.recordUsage) {
    await recordUsage(app.pool, memoryIds, now).catch((err) =>
      app.log.warn(`could not record memory usage: ${errorMessage(err)}`),
    );
  }
  return { markdown: lines.join("\n"), memoryIds, warnings: relevant.warnings };
}

/** `- claim (28 Aug, 7d ago) [id]`; the compact form drops the id when space is tight. */
function renderLine(memory: Memory, now: Date, timeZone: string, withId: boolean): string {
  const content = memory.content.replace(/\s*\n\s*/g, " ");
  const candidate = memory.status === "candidate" ? " (unconfirmed)" : "";
  const id = withId ? ` [${memory.id}]` : "";
  return `- ${content}${candidate} (${formatWhen(memory, now, timeZone)})${id}`;
}

async function query(app: App, sql: (p: Params) => string): Promise<Memory[]> {
  const p = new Params();
  const res = await app.pool.query(sql(p), p.values);
  return res.rows.map(mapMemory);
}

/** Standing instructions, only when the caller asks for agent scopes. */
async function instructions(app: App, now: Date, scopes: readonly Scope[] | undefined): Promise<Memory[]> {
  const agents = scopes?.filter((s) => s.type === "agent");
  if (!agents?.length) return [];
  return query(
    app,
    (p) =>
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE type = 'instruction' AND ${servingSql({ timeParam: p.add(now), historical: false })}
         AND ${scopeSql(agents, (v) => p.add(v))}
       ORDER BY importance DESC, observed_at DESC LIMIT 12`,
  );
}

/** Latest project_state memories, only for projects the caller names. */
async function projectState(app: App, now: Date, scopes: readonly Scope[] | undefined): Promise<Memory[]> {
  const projects = scopes?.filter((s) => s.type === "project");
  if (!projects?.length) return [];
  return query(
    app,
    (p) =>
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE type = 'project_state' AND ${servingSql({ timeParam: p.add(now), historical: false })}
         AND ${scopeSql(projects, (v) => p.add(v))}
       ORDER BY observed_at DESC LIMIT 8`,
  );
}

/** What was learned in the last week, preferring the requested projects when there are any. */
async function recent(app: App, now: Date, scopes: readonly Scope[] | undefined): Promise<Memory[]> {
  const projects = scopes?.filter((s) => s.type === "project");
  const within = projects?.length ? projects : scopes;
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
  return query(
    app,
    (p) =>
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE observed_at >= ${p.add(since)} AND ${servingSql({ timeParam: p.add(now), historical: false })}
         AND ${scopeSql(within, (v) => p.add(v))}
       ORDER BY observed_at DESC LIMIT 8`,
  );
}
