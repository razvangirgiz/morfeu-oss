# morfeu

Long-term memory for AI agents that knows what was true when.

morfeu reads your conversations with coding agents, distills them into small, atomic memories, and serves the relevant ones back to any agent over [MCP](https://modelcontextprotocol.io). It runs on your machine, on Postgres, and never deletes anything.

Most memory layers treat memory as a pile of facts to search. That breaks as soon as something changes:

- *"Alex lives in Lisbon"* and *"Alex lives in Berlin"* are both relevant to "where does Alex live?". Only one is current.
- *"Alex's sister is Ana"* turns out to be wrong; it's Ioana. Ask what was true last month, and the wrong name should not come back.

morfeu keeps two clocks for every claim: **when it holds in the world** and **when morfeu learned it**. A move ends the old claim's validity; a correction retracts the old claim entirely. So a search `--as-of` a past date answers what was true then, by what morfeu knows now.

From `morfeu demo`:

```text
2026-03-06  Where does Alex live?
  → Alex lives in Berlin

Where did Alex live on 2026-01-15? (valid time: what was true then)
  → Alex lives in Lisbon

What was Alex's sister called on 2026-01-30? The wrong name was retracted, so the past is fixed too.
  → Alex's sister is called Ioana

What changed since the first week?
  2026-02-04 new       Alex lives in Berlin
  2026-02-05 changed   Alex lives in Lisbon
  2026-02-09 corrected Alex's sister is called Ana
  2026-02-09 new       Alex's sister is called Ioana
```

## Try it

You need Node 22 or newer and Docker (or your own Postgres with [pgvector](https://github.com/pgvector/pgvector)).

```sh
npm install --global morfeu
morfeu demo     # a two-minute tour on a throwaway database, no API key needed
morfeu setup    # configure providers, prepare the database, connect your agents
```

`morfeu setup` asks where to keep the database, which model turns conversations into memories, and which embeddings power semantic search. It then connects the MCP clients it finds (Claude Code, Claude Desktop, Codex) and installs a daily run. Everything it writes goes to one config file; `morfeu doctor` shows where, and checks that each piece works.

Fully local works too: an [Ollama](https://ollama.com) model through its OpenAI-compatible API for extraction, and Ollama embeddings for search. Nothing leaves your machine.

## How it works

```text
Claude Code transcripts, notes, agent saves
        │ ingest
        ▼
events            append-only ledger, secrets redacted on the way in
        │ extract   (LLM: conversation → atomic candidate claims)
        ▼
candidates        each linked to the events it came from
        │ dream     (LLM: add, duplicate, supersede, rewrite, expire, reject)
        ▼
memories          active, superseded, expired; history kept, nothing deleted
        │ search / context   (vectors + keywords in your language + entities)
        ▼
your agent        over MCP, or the CLI
```

- **Ingest** reads Claude Code session files (`~/.claude/projects`) and keeps the prose: tool calls, tool output and slash commands are dropped. Agents can also log raw text or save finished memories themselves.
- **Extract** asks the LLM for durable, self-contained claims, each pointing at the events that state it. Claims without a source are dropped, and so are subjects you list in `MORFEU_NEVER_EXTRACT`.
- **Dream** consolidates candidates against similar memories already stored: a restated fact becomes a duplicate, a changed one supersedes its predecessor, a stale tense is rewritten with dates. The model can only touch memories it was shown, in the same scope, and never one you stated yourself.
- **Search** combines vector similarity, full-text search with your language's stemmer (English, Romanian, German, Spanish and about 25 more), and entities named in the query, then ranks by relevance, recency, importance and confidence.

`morfeu run` does ingest, extract and dream in one pass; the installed schedule runs it every night. [docs/architecture.md](docs/architecture.md) has the details.

## Using it from an agent

Once connected, an agent gets ten tools. The two it uses most:

- `morfeu_context`: at the start of a task, a compact block with the current time, standing instructions, pinned memories, project state, relevant memories and recent ones.
- `morfeu_save`: when the user states something worth keeping.

The rest: `morfeu_search` (with `as_of` for the past), `morfeu_correct`, `morfeu_forget`, `morfeu_changes`, `morfeu_explain` (where a memory came from), `morfeu_pin`, `morfeu_log_event` and `morfeu_stats`. See [docs/mcp.md](docs/mcp.md).

Memories live in scopes: `user:me` for you, `project:<name>` for a project (derived from the directory a session runs in), `agent:<name>` for instructions to one agent.

For Claude Code, `morfeu connect claude-code --hook` also loads context automatically when a session starts.

## The command line

```text
morfeu search <query> [--as-of date] [--scope s] [--type t]
morfeu context <task>                 what an agent would see
morfeu save <text> --type fact        state something yourself
morfeu correct <id> <text>            fix a wrong memory, past included
morfeu forget <id> --reason <why>     stop serving it, keep the record
morfeu changes --since <date>         what is new, changed, corrected, expired
morfeu explain <id>                   history and sources of one memory
morfeu export [--all]                 everything, as markdown
morfeu run                            backup, ingest, extract, dream, reindex
morfeu doctor [--probe]               check the setup
```

`morfeu help` lists everything; `morfeu help <command>` shows a command's options. Commands that print data accept `--json`.

## Your data

- Everything stays in your Postgres. The managed container listens on 127.0.0.1 only.
- Text reaches an LLM or embedding provider only for extraction, consolidation and search, and only the providers you configure.
- API keys, tokens, private keys and passwords are redacted before anything is stored (patterns in [src/ledger/redact.ts](src/ledger/redact.ts)).
- Nothing is deleted. The database refuses deletes and rewrites of a memory's text; `forget` stops serving a memory now and in the past, and keeps the reason.
- `morfeu backup` (also part of the nightly run) writes a `pg_dump` you can restore with `pg_restore`. `morfeu export` gives you all of it as markdown.

## Status

morfeu is at 0.1. The storage model and the MCP tools are the part designed to last. Command flags, settings and tool arguments may still change before 1.0; every change will be listed in the [changelog](CHANGELOG.md), and schema changes always come as migrations.

Supported: macOS and Linux, Node 22 and 24, Postgres 17 or 18 with pgvector. Windows works through WSL2.

## Documentation

- [Architecture](docs/architecture.md): the pipeline and the code layout
- [Data model](docs/data-model.md): the two clocks, statuses and chains
- [Configuration](docs/configuration.md): every setting
- [MCP tools](docs/mcp.md): what agents can call
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## License

[MIT](LICENSE)
