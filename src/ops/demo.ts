import { randomUUID } from "node:crypto";
import pg from "pg";
import { type App, closeApp, createApp } from "../app.js";
import type { Config } from "../config/config.js";
import { silentLogger } from "../core/log.js";
import { createPool, quoteIdent } from "../db/client.js";
import { applyLanguage } from "../db/language.js";
import { migrate } from "../db/migrate.js";
import { dream } from "../dream/dream.js";
import { extract } from "../extract/extract.js";
import { appendEvent } from "../ledger/events.js";
import { correctMemory } from "../memory/correct.js";
import { saveMemory } from "../memory/save.js";
import { FakeEmbeddings, FakeLLM } from "../providers/fake.js";
import { listChanges } from "../retrieve/changes.js";
import { search } from "../retrieve/search.js";

const DEMO_DB = "morfeu_demo";
const DAY = 86_400_000;
const start = new Date("2026-01-05T09:00:00Z");
const day = (n: number) => new Date(start.getTime() + n * DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A scripted tour on a throwaway database (`morfeu_demo`), with deterministic
 * stand-ins for the LLM and embedder: no API key, nothing touches your memory.
 */
export async function runDemo(config: Config, out: (line: string) => void): Promise<void> {
  const adminUrl = config.databaseUrl;
  const demoUrl = withDatabase(adminUrl, DEMO_DB);
  await recreate(adminUrl, DEMO_DB);
  const llm = scriptedLlm();
  const app = createApp({
    config: { ...config, databaseUrl: demoUrl, userId: "alex", semanticFloor: 0 },
    pool: createPool(demoUrl),
    embedder: new FakeEmbeddings(),
    llm,
    log: silentLogger,
  });
  try {
    await migrate(app.pool);
    await applyLanguage(app.pool, "english");
    await tour(app, out);
  } finally {
    await closeApp(app);
    await drop(adminUrl, DEMO_DB);
  }
}

async function tour(app: App, out: (line: string) => void): Promise<void> {
  const me = { type: "user" as const, id: "me" };
  const alex = [{ name: "Alex", type: "person" as const }];
  let first = true;
  const say = (text: string) => {
    out(first ? text : `\n${text}`);
    first = false;
  };
  const show = async (query: string, asOf?: Date) => {
    const r = await search(app, query, { now: day(60), asOf, limit: 1 });
    out(`  → ${r.hits[0]?.memory.content ?? "(nothing)"}`);
  };

  say(`${iso(day(0))}  Alex tells an agent where they live and what they drink.`);
  await saveMemory(app, { content: "Alex lives in Lisbon", type: "fact", scope: me, entities: alex }, day(0));
  await saveMemory(
    app,
    { content: "Alex drinks green tea in the morning", type: "routine", scope: me, entities: alex },
    day(0),
  );

  say(`${iso(day(20))}  In a later conversation Alex mentions a sister. morfeu extracts it on its nightly run.`);
  await conversation(app, day(20), "My sister Ana is visiting next week.");
  await extract(app, { now: day(21) });
  await dream(app, { now: day(21) });
  await show("alex sister");

  say(`${iso(day(30))}  Alex moves. The nightly consolidation sees that this replaces the old fact.`);
  await conversation(app, day(30), "Big news: I moved to Berlin this week.");
  await extract(app, { now: day(31) });
  await dream(app, { now: day(31) });

  say(`${iso(day(35))}  Alex corrects a mistake: the sister is called Ioana, not Ana.`);
  const sister = await search(app, "alex sister", { now: day(35), limit: 1 });
  if (sister.hits[0])
    await correctMemory(app, { memoryId: sister.hits[0].memory.id, content: "Alex's sister is called Ioana" }, day(35));

  say(`${iso(day(60))}  Where does Alex live?`);
  await show("where does alex live");
  say(`Where did Alex live on ${iso(day(10))}? (valid time: what was true then)`);
  await show("where does alex live", day(10));
  say(`What was Alex's sister called on ${iso(day(25))}? The wrong name was retracted, so the past is fixed too.`);
  await show("alex sister", day(25));

  say("What changed since the first week?");
  const changes = await listChanges(app, { since: day(7), now: day(60) });
  for (const c of changes.changes) out(`  ${iso(c.at)} ${c.kind.padEnd(9)} ${c.memory.content}`);
  out("\nNothing was deleted: every step above is still in the ledger. Run `morfeu setup` to use it for real.");
}

async function conversation(app: App, at: Date, text: string): Promise<void> {
  await appendEvent(app.pool, {
    occurred_at: at,
    ingested_at: at,
    source: "demo",
    external_id: randomUUID(),
    session_id: `demo-${at.getTime()}`,
    type: "user_message",
    content_text: text,
  });
}

/** Answers the demo's two extractions and two consolidations the way a real model would. */
function scriptedLlm(): FakeLLM {
  const candidate = (content: string, entities: { name: string; type: string }[]) => ({
    memories: [
      {
        content,
        type: "fact",
        scope_type: "user",
        entities,
        importance: 0.6,
        confidence: 0.9,
        volatility: "slow",
        valid_from: null,
        valid_until: null,
        source_event_indices: [0],
      },
    ],
  });
  return new FakeLLM()
    .on(
      (p) => p.schemaName === "extracted_memories" && p.user.includes("sister"),
      candidate("Alex's sister is called Ana", [
        { name: "Alex", type: "person" },
        { name: "Ana", type: "person" },
      ]),
    )
    .on(
      (p) => p.schemaName === "extracted_memories" && p.user.includes("Berlin"),
      candidate("Alex lives in Berlin", [
        { name: "Alex", type: "person" },
        { name: "Berlin", type: "place" },
      ]),
    )
    .on(
      (p) => p.schemaName === "dream_decisions" && p.user.includes("Alex lives in Berlin"),
      (p: { user: string }) => {
        const target = /- ([0-9a-f-]{36}) \([^)]*\): Alex lives in Lisbon/.exec(p.user)?.[1] ?? null;
        return {
          decisions: [
            {
              candidate_index: 0,
              action: target ? "supersede" : "add",
              target_id: target,
              reason: "Alex moved",
              content: null,
              valid_from: null,
              valid_until: null,
            },
          ],
        };
      },
    )
    .on((p) => p.schemaName === "dream_decisions", { decisions: [] });
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function recreate(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } catch (err) {
    throw new Error(`the demo needs permission to create a database (${(err as Error).message})`);
  } finally {
    await client.end();
  }
}

async function drop(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
