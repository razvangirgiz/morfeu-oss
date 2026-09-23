import { existsSync } from "node:fs";
import type { App } from "../app.js";
import { errorMessage } from "../db/client.js";
import { type DreamResult, dream } from "../dream/dream.js";
import { type ExtractResult, extract } from "../extract/extract.js";
import { type IngestResult, ingestClaudeCode } from "../ingest/claude-code.js";
import { reindexVectors } from "../memory/reindex.js";
import { backupDatabase } from "./backup.js";
import { prepareDatabase } from "./database.js";
import { warmSessionVectors } from "./hook.js";

export type RunReport = {
  ingest?: IngestResult;
  extract?: ExtractResult;
  dream?: DreamResult;
  reindexed?: number;
  backup?: string;
  /** Steps that failed; the run continues past a failed step when it can. */
  errors: string[];
};

/**
 * The scheduled job, one step after another: back up, ingest new Claude Code
 * sessions, extract candidates, consolidate them, and embed anything still
 * missing a vector. A failed step is reported and does not stop later steps
 * that do not depend on it.
 */
export async function runAll(app: App, now: Date, options: { backup?: boolean } = {}): Promise<RunReport> {
  const report: RunReport = { errors: [] };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      report.errors.push(`${name}: ${errorMessage(err)}`);
      app.log.error(`${name} failed: ${errorMessage(err)}`);
      return undefined;
    }
  };
  if (!(await step("database", () => prepareDatabase(app)))) return report;
  if (options.backup !== false) report.backup = (await step("backup", () => backupDatabase(app.config, now)))?.path;
  if (existsSync(app.config.claudeProjectsDir)) {
    report.ingest = await step("ingest", () => ingestClaudeCode(app, { now }));
  }
  if (app.config.llm.provider !== "none") {
    report.extract = await step("extract", () => extract(app, { now }));
    report.dream = await step("dream", () => dream(app, { now }));
  }
  if (app.config.embedding.provider !== "none") {
    const reindex = await step("reindex", () => reindexVectors(app));
    report.reindexed = reindex?.embedded;
    if (reindex?.error) report.errors.push(`reindex: ${reindex.error}`);
    await step("session vectors", async () => {
      const projects = await app.pool.query<{ id: string }>(
        "SELECT DISTINCT scope_id AS id FROM memories WHERE scope_type = 'project' AND status = 'active'",
      );
      return warmSessionVectors(
        app,
        projects.rows.map((r) => r.id),
        now,
      );
    });
  }
  return report;
}

export function formatRunReport(r: RunReport): string {
  const lines: string[] = [];
  if (r.backup) lines.push(`backup    ${r.backup}`);
  if (r.ingest) lines.push(`ingest    ${r.ingest.inserted} new events from ${r.ingest.files} session files`);
  if (r.extract) {
    const stop = r.extract.stopped ? " (stopped at the LLM call limit)" : "";
    lines.push(`extract   ${r.extract.candidates} candidates from ${r.extract.chunks} chunks${stop}`);
  }
  if (r.dream) {
    const d = r.dream;
    lines.push(
      `dream     ${d.candidates} candidates: ${d.add} added, ${d.duplicate} duplicate, ${d.supersede} superseded, ` +
        `${d.temporal_update} rewritten, ${d.expire} expired, ${d.reject} rejected`,
    );
  }
  if (r.reindexed) lines.push(`reindex   ${r.reindexed} vectors`);
  for (const e of r.errors) lines.push(`error     ${e}`);
  return lines.join("\n") || "nothing to do";
}
