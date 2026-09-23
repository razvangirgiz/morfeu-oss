import { writeFileSync } from "node:fs";
import { MEMORY_TYPES, type MemoryType, parseScope } from "../../core/types.js";
import { correctMemory } from "../../memory/correct.js";
import { explainMemory } from "../../memory/explain.js";
import { exportMarkdown } from "../../memory/export.js";
import { forgetMemory } from "../../memory/forget.js";
import { listPinned, pinMemory, unpinMemory } from "../../memory/pins.js";
import { saveMemory } from "../../memory/save.js";
import { CHANGE_KINDS, type ChangeKind, listChanges } from "../../retrieve/changes.js";
import { compileContext } from "../../retrieve/context.js";
import { presentMemory } from "../../retrieve/present.js";
import { search } from "../../retrieve/search.js";
import { localTimeZone } from "../../retrieve/when.js";
import {
  type Command,
  type CommandGroup,
  dateValue,
  intValue,
  JSON_OPTION,
  listValue,
  print,
  requireArg,
  stringValue,
  type Values,
  withApp,
} from "../command.js";

const SCOPE_OPTION = { scope: { type: "string", short: "s", multiple: true } } as const;
const TYPE_OPTION = { type: { type: "string", short: "t", multiple: true } } as const;

function scopes(values: Values) {
  return listValue(values, "scope")?.map(parseScope);
}

function types(values: Values): MemoryType[] | undefined {
  return listValue(values, "type")?.map((t) => {
    if (!(MEMORY_TYPES as readonly string[]).includes(t))
      throw new Error(`unknown type ${t}; use one of ${MEMORY_TYPES.join(", ")}`);
    return t as MemoryType;
  });
}

function line(m: ReturnType<typeof presentMemory>): string {
  return `${m.id}  ${m.content}\n    ${m.type} · ${m.scope} · ${m.when}${m.status === "active" ? "" : ` · ${m.status}`}`;
}

const saveCommand: Command = {
  name: "save",
  summary: "Save a memory you state yourself",
  usage: "save <content> --type <type> [--scope user:me] [--supersedes <id>] [--from <date>] [--until <date>]",
  options: {
    ...JSON_OPTION,
    type: { type: "string", short: "t" },
    scope: { type: "string", short: "s" },
    supersedes: { type: "string" },
    from: { type: "string" },
    until: { type: "string" },
    importance: { type: "string" },
  },
  async run(ctx) {
    const content = requireArg(ctx, 0, "content");
    const type = stringValue(ctx.values, "type");
    if (!type || !(MEMORY_TYPES as readonly string[]).includes(type))
      throw new Error(`--type is required: ${MEMORY_TYPES.join(", ")}`);
    const importance = stringValue(ctx.values, "importance");
    const result = await withApp(ctx, (app) =>
      saveMemory(
        app,
        {
          content,
          type: type as MemoryType,
          scope: parseScope(stringValue(ctx.values, "scope") ?? "user:me"),
          supersedes: stringValue(ctx.values, "supersedes"),
          valid_from: dateValue(ctx.values, "from"),
          valid_until: dateValue(ctx.values, "until"),
          importance: importance === undefined ? undefined : Number(importance),
          origin: "owner",
          source: "cli",
        },
        ctx.now(),
      ),
    );
    print(ctx, { id: result.memory.id, deduplicated: result.deduplicated, superseded_id: result.superseded_id }, () =>
      result.deduplicated ? `already remembered: ${result.memory.id}` : `saved ${result.memory.id}`,
    );
    return 0;
  },
};

const correctCommand: Command = {
  name: "correct",
  summary: "Replace a wrong memory; the old claim is retracted, also for the past",
  usage: "correct <id> <content> [--from <date>] [--until <date>]",
  options: { ...JSON_OPTION, from: { type: "string" }, until: { type: "string" } },
  async run(ctx) {
    const result = await withApp(ctx, (app) =>
      correctMemory(
        app,
        {
          memoryId: requireArg(ctx, 0, "id"),
          content: requireArg(ctx, 1, "content"),
          ...(ctx.values.from !== undefined ? { valid_from: dateValue(ctx.values, "from") ?? null } : {}),
          ...(ctx.values.until !== undefined ? { valid_until: dateValue(ctx.values, "until") ?? null } : {}),
          source: "cli",
        },
        ctx.now(),
      ),
    );
    print(
      ctx,
      { id: result.memory.id, retracted_id: result.retracted_id },
      () => `corrected: ${result.retracted_id} → ${result.memory.id}`,
    );
    return 0;
  },
};

const forgetCommand: Command = {
  name: "forget",
  summary: "Stop serving a memory (kept in the ledger, never shown again)",
  usage: "forget <id> --reason <text>",
  options: { reason: { type: "string", short: "r" } },
  async run(ctx) {
    const reason = stringValue(ctx.values, "reason");
    if (!reason) throw new Error("--reason is required");
    const result = await withApp(ctx, (app) => forgetMemory(app, requireArg(ctx, 0, "id"), reason, ctx.now()));
    ctx.out(result.already ? `${result.id} was already forgotten` : `forgot ${result.id}`);
    return 0;
  },
};

const pinCommand: Command = {
  name: "pin",
  summary: "Always include a memory in context",
  usage: "pin <id>",
  async run(ctx) {
    const m = await withApp(ctx, (app) => pinMemory(app, requireArg(ctx, 0, "id"), ctx.now()));
    ctx.out(`pinned ${m.id}`);
    return 0;
  },
};

const unpinCommand: Command = {
  name: "unpin",
  summary: "Stop always including a memory",
  usage: "unpin <id>",
  async run(ctx) {
    const m = await withApp(ctx, (app) => unpinMemory(app, requireArg(ctx, 0, "id")));
    ctx.out(`unpinned ${m.id}`);
    return 0;
  },
};

const pinsCommand: Command = {
  name: "pins",
  summary: "List pinned memories",
  usage: "pins [--json]",
  options: JSON_OPTION,
  async run(ctx) {
    const now = ctx.now();
    const tz = localTimeZone();
    const pinned = (await withApp(ctx, (app) => listPinned(app.pool, now))).map((m) => presentMemory(m, now, tz));
    print(ctx, pinned, () => pinned.map((m) => line(m)).join("\n") || "nothing pinned");
    return 0;
  },
};

const searchCommand: Command = {
  name: "search",
  summary: "Search memories",
  usage: "search <query> [--scope s]... [--type t]... [--as-of <date>] [--limit n] [--json]",
  options: {
    ...JSON_OPTION,
    ...SCOPE_OPTION,
    ...TYPE_OPTION,
    "as-of": { type: "string" },
    limit: { type: "string", short: "n" },
  },
  async run(ctx) {
    const now = ctx.now();
    const tz = localTimeZone();
    const result = await withApp(ctx, (app) =>
      search(app, requireArg(ctx, 0, "query"), {
        now,
        scopes: scopes(ctx.values),
        types: types(ctx.values),
        asOf: dateValue(ctx.values, "as-of"),
        limit: intValue(ctx.values, "limit"),
        recordUsage: true,
      }),
    );
    const hits = result.hits.map((h) => ({ ...presentMemory(h.memory, now, tz), score: Number(h.score.toFixed(3)) }));
    print(
      ctx,
      { hits, warnings: result.warnings },
      () => [...hits.map((h) => line(h)), ...result.warnings.map((w) => `(${w})`)].join("\n") || "no memories found",
    );
    return 0;
  },
};

const contextCommand: Command = {
  name: "context",
  summary: "Show the context an agent would get for a task",
  usage: "context <task> [--scope s]... [--type t]... [--budget tokens]",
  options: { ...SCOPE_OPTION, ...TYPE_OPTION, budget: { type: "string", short: "b" } },
  async run(ctx) {
    const result = await withApp(ctx, (app) =>
      compileContext(app, requireArg(ctx, 0, "task"), {
        now: ctx.now(),
        scopes: scopes(ctx.values),
        types: types(ctx.values),
        tokenBudget: intValue(ctx.values, "budget"),
      }),
    );
    ctx.out(result.markdown);
    return 0;
  },
};

const explainCommand: Command = {
  name: "explain",
  summary: "Show a memory's history and where it came from",
  usage: "explain <id> [--json]",
  options: JSON_OPTION,
  async run(ctx) {
    const now = ctx.now();
    const tz = localTimeZone();
    const e = await withApp(ctx, (app) => explainMemory(app.pool, requireArg(ctx, 0, "id")));
    const view = {
      history: e.chain.map((m) => presentMemory(m, now, tz)),
      entities: e.entities,
      sources: e.sources,
      decisions: e.decisions,
    };
    print(ctx, view, () =>
      [
        "history:",
        ...view.history.map((m) => `  ${m.id === e.memory.id ? "→" : " "} ${line(m).replace(/\n/g, "\n    ")}`),
        "sources:",
        ...e.sources.map(
          (s) =>
            `    ${s.occurred_at.toISOString()} ${s.source} ${s.type}: ${s.text.slice(0, 160).replace(/\s+/g, " ")}`,
        ),
        ...(e.decisions.length ? ["decisions:", ...e.decisions.map((d) => `    ${d.action}: ${d.reason}`)] : []),
      ].join("\n"),
    );
    return 0;
  },
};

const changesCommand: Command = {
  name: "changes",
  summary: "What changed since a date",
  usage: `changes --since <date> [--kind ${CHANGE_KINDS.join("|")}] [--scope s]... [--json]`,
  options: {
    ...JSON_OPTION,
    ...SCOPE_OPTION,
    ...TYPE_OPTION,
    since: { type: "string" },
    kind: { type: "string" },
    limit: { type: "string", short: "n" },
  },
  async run(ctx) {
    const since = dateValue(ctx.values, "since");
    if (!since) throw new Error("--since is required");
    const kind = stringValue(ctx.values, "kind");
    if (kind && !(CHANGE_KINDS as readonly string[]).includes(kind))
      throw new Error(`--kind must be one of ${CHANGE_KINDS.join(", ")}`);
    const now = ctx.now();
    const tz = localTimeZone();
    const result = await withApp(ctx, (app) =>
      listChanges(app, {
        since,
        now,
        scopes: scopes(ctx.values),
        types: types(ctx.values),
        kind: kind as ChangeKind | undefined,
        limit: intValue(ctx.values, "limit"),
      }),
    );
    const changes = result.changes.map((c) => ({
      kind: c.kind,
      at: c.at.toISOString(),
      ...presentMemory(c.memory, now, tz),
    }));
    print(ctx, { summary: result.summary, changes }, () =>
      [
        Object.entries(result.summary)
          .map(([k, n]) => `${k} ${n}`)
          .join(", "),
        ...changes.map((c) => `${c.at.slice(0, 10)} ${c.kind.padEnd(9)} ${c.content}`),
      ].join("\n"),
    );
    return 0;
  },
};

const exportCommand: Command = {
  name: "export",
  summary: "Export memories as markdown",
  usage: "export [--scope s]... [--all] [--out file]",
  options: { ...SCOPE_OPTION, all: { type: "boolean" }, out: { type: "string", short: "o" } },
  async run(ctx) {
    const md = await withApp(ctx, (app) =>
      exportMarkdown(app.pool, { scopes: scopes(ctx.values), all: Boolean(ctx.values.all) }),
    );
    const out = stringValue(ctx.values, "out");
    if (out) {
      writeFileSync(out, `${md}\n`, { mode: 0o600, flag: "wx" });
      ctx.out(`wrote ${out}`);
    } else ctx.out(md);
    return 0;
  },
};

export const memoryCommands: CommandGroup = {
  title: "Memory",
  commands: [
    searchCommand,
    contextCommand,
    saveCommand,
    correctCommand,
    forgetCommand,
    pinCommand,
    unpinCommand,
    pinsCommand,
    explainCommand,
    changesCommand,
    exportCommand,
  ],
};
