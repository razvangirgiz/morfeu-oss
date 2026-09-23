# Architecture

## The pipeline

```text
ingest ──► events ──► extract ──► candidates ──► dream ──► memories ──► search / context
```

**Ingest** (`src/ingest/claude-code.ts`) reads Claude Code transcripts line by line. A cursor per file remembers the last complete line, so a run only reads what was appended since, and a line still being written is left for next time. User and assistant prose is kept; thinking, tool calls, tool results and slash commands are not. The project is the last segment of the session's working directory. Agents can add events directly with `morfeu_log_event`.

**Events** (`src/ledger`) are the append-only record. Every event and every memory passes through secret redaction on the way in, and `(source, external_id)` makes ingestion idempotent.

**Extract** (`src/extract`) groups unprocessed events by session into chunks (at most 100 events or 50,000 characters) and asks the LLM for durable, atomic claims with a JSON schema. Model output is treated as untrusted: types and dates are validated, scope ids come from the session rather than the model, instructions are never extracted, and a claim must cite at least one event of its chunk. With `MORFEU_NEVER_EXTRACT` set, a second call filters forbidden subjects. A chunk's candidates and the "processed" mark on its events commit in one transaction.

**Dream** (`src/dream`) consolidates candidates per scope, 20 per LLM call. Each candidate is shown with its neighborhood: active memories in the same scope that are similar (cosine > 0.75) or share an entity. The model picks one action per candidate; `src/dream/apply.ts` applies each in its own transaction:

| Action | Effect |
|---|---|
| add | The candidate becomes active. |
| duplicate | The candidate is dropped; the existing memory gains confidence (up to 0.95) and leaves the archive. |
| supersede | The candidate becomes active; the target ends where the candidate starts. |
| temporal_update | A rewritten claim with dates replaces the candidate (and the target, if any). |
| expire | The target, or the candidate itself, stops being valid at the given date. |
| reject | The candidate is dropped. |

The model may only name targets it was shown, in the candidate's scope, via the chain's current head, and never a memory with origin `owner`. Anything else falls back to `add`, with the reason logged. Candidates the model skipped become active.

Before consolidating, the dream marks memories whose `valid_until` has passed as expired, and (with `MORFEU_DECAY=on`) archives stale ones.

**Search** (`src/retrieve/search.ts`) runs three candidate passes under the same serving filter (see [data-model.md](data-model.md)):

1. vector similarity against the query's embedding, using the model's HNSW index;
2. keywords, through the `morfeu_fts` text search configuration (unaccent plus the configured language's stemmer): a lenient pass on any content word, ranked by `ts_rank_cd` normalised by length, and a strict pass on all words that adds a bonus;
3. memories linked to entities named in the query.

The union is scored on relevance (semantic 0.30, keyword 0.20, entity 0.20) and priors (recency 0.15, importance 0.10, confidence 0.05). Recency decays with a half-life that depends on volatility (14, 90 or 365 days), and a recent retrieval counts as fresh. When a query cannot produce a signal (no embedder, no content words, no entities), its weight goes to the other relevance signals, never to the priors.

**Context** (`src/retrieve/context.ts`) assembles the markdown an agent reads at the start of a task: the clock, instructions, pinned memories, project state, the top search hits and the last week's memories, each memory once, within a token budget.

## Code layout

Layers import downward only:

```text
core            types, logging                       (no I/O)
config          settings, platform directories
db              pool, migrations, text search language
providers       LLM and embedding clients (OpenAI-compatible, Ollama, fake)
ledger          events, secret redaction, run log
memory          write, save, correct, forget, pins, chains, entities, vectors
extract, dream  the two LLM stages
retrieve        search, context, changes, time formatting
ingest          transcript readers
mcp, cli        the two interfaces
ops             setup, doctor, docker, backup, schedule, client connections, the nightly run
```

`App` (`src/app.ts`) bundles config, pool, providers and logger; every function that needs them takes it as its first argument. Nothing reads the clock below the interfaces: `now` is passed down, which keeps time-dependent behaviour testable.

## Tests

- `test/unit`: pure logic, no database. Runs anywhere in about a second.
- `test/integration`: against Postgres with pgvector. Each worker gets its own database cloned from a migrated template, and tables are emptied before every test. Providers are fakes with scripted answers.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to run them.
