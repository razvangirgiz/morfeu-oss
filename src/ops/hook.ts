import { createHash } from "node:crypto";
import type { App } from "../app.js";
import type { Scope } from "../core/types.js";
import { vectorLiteral } from "../db/client.js";
import { projectOf } from "../ingest/claude-code.js";
import { compileContext } from "../retrieve/context.js";

const BUDGET = 1200;
const TIMEOUT_MS = 3000;

function sessionTask(project: string): string {
  return project
    ? `current state and recent decisions of project ${project}`
    : "who the user is and what they are working on";
}

/**
 * Claude Code's SessionStart hook: prints context for the session's project
 * before the first prompt. It must be fast and must never break a session,
 * so it never calls the embedder (it uses a cached query vector when there is
 * one), gives up after a few seconds, and prints nothing on any error.
 */
export async function sessionStartContext(app: App, stdin: string, now: Date, fallbackCwd: string): Promise<string> {
  const project = projectOf(cwdFrom(stdin) ?? fallbackCwd);
  const task = sessionTask(project);
  const work = (async () => {
    const vector = await cachedQueryVector(app, task);
    const scopes: Scope[] = [{ type: "user", id: app.config.userId }];
    if (project) scopes.push({ type: "project", id: project });
    const context = await compileContext(app, task, {
      now,
      scopes,
      tokenBudget: BUDGET,
      queryVector: vector,
      skipSemantic: vector === undefined,
    });
    return context.memoryIds.length > 0 ? context.markdown : "";
  })().catch(() => "");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function cwdFrom(stdin: string): string | undefined {
  try {
    const cwd = (JSON.parse(stdin) as { cwd?: unknown }).cwd;
    return typeof cwd === "string" && cwd ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function cachedQueryVector(app: App, task: string): Promise<number[] | undefined> {
  const hit = await app.pool.query<{ embedding: string }>(
    "SELECT embedding::text AS embedding FROM query_embeddings WHERE model = $1 AND text_hash = $2",
    [app.embedder.model, hash(task)],
  );
  return hit.rows[0] ? (JSON.parse(hit.rows[0].embedding) as number[]) : undefined;
}

/** Fills the hook's query-vector cache for the given projects; run by `morfeu run`, off the hot path. */
export async function warmSessionVectors(app: App, projects: readonly string[], now: Date): Promise<number> {
  let warmed = 0;
  for (const project of ["", ...projects]) {
    const task = sessionTask(project);
    if (await cachedQueryVector(app, task)) continue;
    const vector = app.embedder.embedQuery
      ? await app.embedder.embedQuery(task)
      : (await app.embedder.embed([task]))[0];
    if (!vector) continue;
    await app.pool.query(
      `INSERT INTO query_embeddings (model, text_hash, embedding, created_at) VALUES ($1, $2, $3::vector, $4)
       ON CONFLICT (model, text_hash) DO NOTHING`,
      [app.embedder.model, hash(task), vectorLiteral(vector), now],
    );
    warmed += 1;
  }
  return warmed;
}
