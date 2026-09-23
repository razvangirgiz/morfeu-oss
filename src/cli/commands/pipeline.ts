import { parseScope } from "../../core/types.js";
import { dream } from "../../dream/dream.js";
import { extract } from "../../extract/extract.js";
import { ingestClaudeCode } from "../../ingest/claude-code.js";
import { reindexVectors } from "../../memory/reindex.js";
import { formatRunReport, runAll } from "../../ops/run.js";
import { type Command, type CommandGroup, intValue, JSON_OPTION, print, stringValue, withApp } from "../command.js";

const ingestCommand: Command = {
  name: "ingest",
  summary: "Read new Claude Code sessions into the event ledger",
  usage: "ingest [--project <text>] [--limit n] [--json]",
  options: { ...JSON_OPTION, project: { type: "string", short: "p" }, limit: { type: "string", short: "n" } },
  async run(ctx) {
    const r = await withApp(ctx, (app) =>
      ingestClaudeCode(app, {
        now: ctx.now(),
        project: stringValue(ctx.values, "project"),
        limit: intValue(ctx.values, "limit"),
      }),
    );
    print(
      ctx,
      r,
      () =>
        `${r.inserted} new events from ${r.files} session files (${r.duplicates} already known, ${r.skipped} skipped lines)`,
    );
    return 0;
  },
};

const extractCommand: Command = {
  name: "extract",
  summary: "Turn new events into candidate memories (calls the LLM)",
  usage: "extract [--estimate] [--limit sessions] [--session id] [--json]",
  options: {
    ...JSON_OPTION,
    estimate: { type: "boolean" },
    limit: { type: "string", short: "n" },
    session: { type: "string" },
  },
  async run(ctx) {
    const r = await withApp(ctx, (app) =>
      extract(app, {
        now: ctx.now(),
        estimate: Boolean(ctx.values.estimate),
        limit: intValue(ctx.values, "limit"),
        session: stringValue(ctx.values, "session"),
      }),
    );
    print(ctx, r, () =>
      ctx.values.estimate
        ? `${r.sessions} sessions, ${r.chunks} LLM calls, about ${r.approx_input_tokens} input tokens`
        : `${r.candidates} candidates from ${r.chunks} chunks (${r.rejected} rejected, ${r.forbidden} never-extract)${r.stopped ? "; stopped at the LLM call limit" : ""}`,
    );
    return 0;
  },
};

const dreamCommand: Command = {
  name: "dream",
  summary: "Consolidate candidates into memory (calls the LLM)",
  usage: "dream [--scope s] [--json]",
  options: { ...JSON_OPTION, scope: { type: "string", short: "s" } },
  async run(ctx) {
    const scope = stringValue(ctx.values, "scope");
    const r = await withApp(ctx, (app) => dream(app, { now: ctx.now(), scope: scope ? parseScope(scope) : undefined }));
    print(
      ctx,
      r,
      () =>
        `${r.candidates} candidates: ${r.add} added, ${r.duplicate} duplicate, ${r.supersede} superseded, ${r.temporal_update} rewritten, ` +
        `${r.expire} expired, ${r.reject} rejected; ${r.expired} memories reached their end date${r.stopped ? "; stopped at the LLM call limit" : ""}`,
    );
    return 0;
  },
};

const runCommand: Command = {
  name: "run",
  summary: "Everything the daily schedule does: backup, ingest, extract, dream, reindex",
  usage: "run [--no-backup] [--json]",
  options: { ...JSON_OPTION, "no-backup": { type: "boolean" } },
  async run(ctx) {
    const report = await withApp(ctx, (app) => runAll(app, ctx.now(), { backup: !ctx.values["no-backup"] }));
    print(ctx, report, () => formatRunReport(report));
    return report.errors.length ? 1 : 0;
  },
};

const reindexCommand: Command = {
  name: "reindex",
  summary: "Embed memories that have no vector for the current embedding model",
  usage: "reindex [--limit n]",
  options: { limit: { type: "string", short: "n" } },
  async run(ctx) {
    const r = await withApp(ctx, (app) => reindexVectors(app, intValue(ctx.values, "limit")));
    ctx.out(`embedded ${r.embedded} memories${r.error ? `; stopped: ${r.error}` : ""}`);
    return r.error ? 1 : 0;
  },
};

export const pipelineCommands: CommandGroup = {
  title: "Background work",
  commands: [runCommand, ingestCommand, extractCommand, dreamCommand, reindexCommand],
};
