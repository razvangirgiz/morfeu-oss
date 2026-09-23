-- morfeu schema, version 1.
--
-- Two rules shape it:
--   1. Nothing is deleted. Events are an append-only ledger; a memory's text is
--      never rewritten. Change means a new row linked to the old one.
--   2. Two clocks. valid_from/valid_until say when a claim holds in the world;
--      recorded_at/retracted_at say when morfeu learned it and when it learned
--      the claim was wrong. "What was true in June" reads valid time and skips
--      retracted rows.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Case-, accent- and whitespace-insensitive form of a text, for exact
-- duplicate and entity-name matching. unaccent() itself is not immutable.
CREATE FUNCTION morfeu_fold(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent', regexp_replace(btrim($1), '\s+', ' ', 'g'))) $$;

-- Keyword search runs on this configuration. It starts language-neutral;
-- morfeu points it at the configured language's stemmer on startup
-- (src/retrieve/language.ts) and rebuilds the index when that changes.
CREATE TEXT SEARCH CONFIGURATION morfeu_fts (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION morfeu_fts
  ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
  WITH unaccent, simple;

-- Small key/value store for state morfeu keeps about the database itself.
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL,
  ingested_at  timestamptz NOT NULL,
  source       text NOT NULL,
  external_id  text,
  session_id   text,
  agent_id     text,
  type         text NOT NULL CHECK (type IN ('user_message', 'assistant_message', 'note')),
  content      jsonb NOT NULL DEFAULT '{}',
  content_text text NOT NULL,
  -- NULL until extraction has read the event.
  processed_at timestamptz,
  UNIQUE (source, external_id)
);
CREATE INDEX events_session ON events (session_id, occurred_at);
CREATE INDEX events_unprocessed ON events (occurred_at) WHERE processed_at IS NULL;

CREATE TABLE memories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type       text NOT NULL CHECK (scope_type IN ('user', 'agent', 'project')),
  scope_id         text NOT NULL,
  type             text NOT NULL CHECK (type IN (
                     'fact', 'preference', 'relationship', 'event', 'goal',
                     'decision', 'routine', 'project_state', 'instruction')),
  content          text NOT NULL,
  attrs            jsonb NOT NULL DEFAULT '{}',
  importance       real NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  confidence       real NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
  volatility       text NOT NULL DEFAULT 'slow' CHECK (volatility IN ('stable', 'slow', 'fast')),
  origin           text NOT NULL CHECK (origin IN ('extracted', 'saved', 'owner')),
  status           text NOT NULL CHECK (status IN ('candidate', 'active', 'superseded', 'expired', 'invalidated')),
  -- When the claim was stated in its source.
  observed_at      timestamptz NOT NULL,
  -- Valid time: NULL valid_from means "as far back as we know"; NULL valid_until means "still true".
  valid_from       timestamptz,
  valid_until      timestamptz,
  -- Record time.
  recorded_at      timestamptz NOT NULL,
  retracted_at     timestamptz,
  supersedes_id    uuid REFERENCES memories (id),
  superseded_by_id uuid REFERENCES memories (id),
  -- Serving flags; neither changes what is true.
  pinned_at        timestamptz,
  archived_at      timestamptz,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
CREATE INDEX memories_scope ON memories (scope_type, scope_id, status);
CREATE INDEX memories_status ON memories (status, observed_at);
CREATE INDEX memories_pinned ON memories (pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX memories_fts ON memories USING gin (to_tsvector('morfeu_fts', content));

-- The events a memory was distilled from.
CREATE TABLE memory_sources (
  memory_id uuid NOT NULL REFERENCES memories (id),
  event_id  uuid NOT NULL REFERENCES events (id),
  PRIMARY KEY (memory_id, event_id)
);
CREATE INDEX memory_sources_event ON memory_sources (event_id);

CREATE TABLE entities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  type           text NOT NULL CHECK (type IN ('person', 'project', 'organization', 'technology', 'place', 'other')),
  aliases        text[] NOT NULL DEFAULT '{}',
  UNIQUE (canonical_name, type)
);

CREATE TABLE memory_entities (
  memory_id uuid NOT NULL REFERENCES memories (id),
  entity_id uuid NOT NULL REFERENCES entities (id),
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX memory_entities_entity ON memory_entities (entity_id);

-- Vectors live apart from memories so the embedding model can change without
-- touching them. Dimensions depend on the model; morfeu creates one HNSW
-- index per model when it first writes that model's vectors.
CREATE TABLE memory_embeddings (
  memory_id uuid NOT NULL REFERENCES memories (id),
  model     text NOT NULL,
  embedding vector NOT NULL,
  PRIMARY KEY (memory_id, model)
);

-- Cached query vectors for fixed prompts (the session-start hook).
CREATE TABLE query_embeddings (
  model      text NOT NULL,
  text_hash  text NOT NULL,
  embedding  vector NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (model, text_hash)
);

CREATE TABLE memory_usage (
  memory_id         uuid PRIMARY KEY REFERENCES memories (id),
  retrieval_count   integer NOT NULL DEFAULT 0,
  last_retrieved_at timestamptz NOT NULL
);

-- Audit trail of background work: extraction, consolidation, maintenance.
CREATE TABLE runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  stats       jsonb NOT NULL DEFAULT '{}',
  error       text
);
CREATE INDEX runs_kind ON runs (kind, started_at DESC);

CREATE TABLE dream_decisions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id    uuid NOT NULL REFERENCES runs (id),
  memory_id uuid NOT NULL REFERENCES memories (id),
  action    text NOT NULL CHECK (action IN ('add', 'duplicate', 'supersede', 'temporal_update', 'expire', 'reject')),
  target_id uuid REFERENCES memories (id),
  reason    text NOT NULL
);
CREATE INDEX dream_decisions_memory ON dream_decisions (memory_id);

-- How far ingestion has read each source file.
CREATE TABLE ingest_cursors (
  source     text NOT NULL,
  ref        text NOT NULL,
  last_line  bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source, ref)
);

-- Rule 1, enforced by the database rather than by convention: events and
-- memories are never deleted, and only bookkeeping columns may change.
CREATE FUNCTION morfeu_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- Bookkeeping columns. valid_from may still be settled while a row is a
  -- candidate (consolidation dates a successor from its predecessor's end).
  mutable text[] := ARRAY['status', 'valid_until', 'retracted_at', 'supersedes_id', 'superseded_by_id',
                          'confidence', 'pinned_at', 'archived_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'morfeu: % rows are never deleted', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'events' THEN
    IF (to_jsonb(NEW) - 'processed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'processed_at') THEN
      RAISE EXCEPTION 'morfeu: only events.processed_at may change';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'candidate' THEN
    mutable := array_append(mutable, 'valid_from');
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'morfeu: a memory''s claim is immutable; write a new memory instead';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION morfeu_append_only();
CREATE TRIGGER memories_append_only BEFORE UPDATE OR DELETE ON memories
  FOR EACH ROW EXECUTE FUNCTION morfeu_append_only();
