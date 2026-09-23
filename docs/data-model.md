# Data model

morfeu stores two kinds of rows: **events**, the raw record of what was said, and **memories**, atomic claims distilled from events. Both are append-only: the database rejects deletes, and a memory's claim (its text, type, scope and dates) never changes after it is written. Change always means a new row linked to the old one. The rule is enforced by a trigger (`morfeu_append_only` in `migrations/0001_initial.sql`), not by convention.

## Two clocks

Every memory carries two independent kinds of time.

| | Columns | Question it answers |
|---|---|---|
| Valid time | `valid_from`, `valid_until` | When is the claim true in the world? `NULL` means "as far back as we know" and "still true". |
| Record time | `recorded_at`, `retracted_at` | When did morfeu learn it, and when did it learn it was wrong? |

There is a third timestamp, `observed_at`: when the claim was stated in its source (the time of the conversation).

The distinction matters because things change for two different reasons:

- **The world changed.** Alex lived in Lisbon and now lives in Berlin. Both claims were true, at different times. The Lisbon memory gets `valid_until` = the day of the move and status `superseded`; the Berlin memory starts that day. A question about January still gets Lisbon.
- **morfeu was wrong.** It recorded that Alex's sister is Ana; she is Ioana. The Ana memory was never true. It gets `retracted_at` = now and status `superseded`, and the correction covers the same period. A question about January now gets Ioana.

## Which memories answer a question

One predicate decides this everywhere (`src/memory/serving.ts`):

- **Now:** status `active`, not archived, and valid at the current time.
- **As of a past time *t*:** valid at *t*, status `active`, `superseded` or `expired`, and never retracted. Past answers use today's knowledge: a correction made yesterday also fixes last year.

Candidates (not yet consolidated) can be included in present-time searches on request, never in historical ones.

## Statuses

| Status | Meaning | Served now | Served in the past |
|---|---|---|---|
| `candidate` | Extracted, waiting for the dream | on request | no |
| `active` | Current | yes | yes, within its validity |
| `superseded` | Replaced; `superseded_by_id` points to the successor | no | yes, unless retracted |
| `expired` | Stopped being true (`valid_until` passed) | no | yes, within its validity |
| `invalidated` | Rejected, a duplicate, or forgotten | no | no |

## Chains

`supersedes_id` and `superseded_by_id` link a memory to the one it replaced and the one that replaced it. `morfeu explain <id>` walks the chain in both directions. Commands that change a memory (correct, forget, pin) follow the chain from any row to its current head, so an old id still reaches the current claim.

## Origins

| Origin | Written by | The dream may change it |
|---|---|---|
| `extracted` | The extractor, from conversations | yes |
| `saved` | An agent through `morfeu_save` | yes |
| `owner` | You, through the CLI or a correction | no |

Extracted and saved memories are capped at importance 0.8, so they never outrank what you stated yourself.

## Scopes

A scope says whom or what a memory is about: `user:<id>` (you; `user:me` is an alias for `MORFEU_USER_ID`), `project:<name>` (a project; for Claude Code sessions, the last directory of the session's working directory), and `agent:<name>` (standing instructions for one agent). Searches and context can be limited to a list of scopes; an empty list matches nothing.

## Everything else

- `memory_sources` links each memory to the events it came from. Every memory has at least one; an explicit save writes a note event.
- `entities` and `memory_entities` hold the people, projects, organisations, technologies and places memories mention. Names match case- and accent-insensitively, and aliases accumulate.
- `memory_embeddings` stores vectors per memory and model, so changing the embedding model never touches memories. Each model gets its own HNSW index, created the first time it writes a vector.
- `memory_usage` counts retrievals. Recently used memories rank as fresher, and are spared by decay.
- `runs` and `dream_decisions` are the audit trail: every extraction, consolidation and forget, and every decision the dream made with its reason.
- `settings` holds state about the database itself: the keyword search language and each embedding model's dimension.

## Erasing something for real

`forget` stops serving a memory everywhere, but its text stays on disk, as do the events it came from. That is the point of an append-only store. If something must be removed (a secret the redaction missed, for example), stop morfeu and run, as the database owner:

```sql
BEGIN;
ALTER TABLE memories DISABLE TRIGGER memories_append_only;
ALTER TABLE events DISABLE TRIGGER events_append_only;
-- inspect first: SELECT id, content_text FROM events WHERE content_text LIKE '%needle%';
UPDATE events SET content_text = '[erased]', content = '{}' WHERE id = '<event id>';
UPDATE memories SET content = '[erased]' WHERE id = '<memory id>';
DELETE FROM memory_embeddings WHERE memory_id = '<memory id>';
ALTER TABLE events ENABLE TRIGGER events_append_only;
ALTER TABLE memories ENABLE TRIGGER memories_append_only;
COMMIT;
```

Backups taken before that still contain the original text.
