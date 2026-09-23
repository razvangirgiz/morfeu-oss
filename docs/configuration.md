# Configuration

morfeu reads settings from environment variables, over a config file. `morfeu setup` writes the file; `morfeu doctor` prints its location:

| Platform | Config file |
|---|---|
| macOS | `~/Library/Application Support/morfeu/config.env` |
| Linux | `$XDG_CONFIG_HOME/morfeu/config.env` (default `~/.config/morfeu/config.env`) |
| Windows | `%APPDATA%\morfeu\config.env` |

The file has one `KEY=value` per line and is readable only by you (mode 600), because it may hold API keys. Set `MORFEU_CONFIG_FILE` to an absolute path to use another file; MCP clients started by `morfeu connect` read the default one.

## Database

| Setting | Default | |
|---|---|---|
| `MORFEU_DATABASE_URL` | `postgres://morfeu:morfeu@127.0.0.1:5433/morfeu` | Any Postgres 17 or 18 with the `vector` and `unaccent` extensions available. |
| `MORFEU_MANAGED_DB` | `docker` when no URL is set, else `off` | `docker`: morfeu runs its own `pgvector/pgvector` container (`morfeu-db`, volume `morfeu-db-data`, bound to 127.0.0.1). `off`: you run Postgres. |
| `MORFEU_BACKUP_DIR` | `<data dir>/backups` | Where `morfeu backup` writes; the newest 14 dumps are kept. With your own Postgres, `pg_dump` must be on the PATH. |

## Language

| Setting | Default | |
|---|---|---|
| `MORFEU_LANGUAGE` | `english` | Stemming and stopwords for keyword search. Any Postgres text search language (`arabic`, `danish`, `dutch`, `finnish`, `french`, `german`, `greek`, `hungarian`, `italian`, `norwegian`, `portuguese`, `romanian`, `russian`, `spanish`, `swedish`, `turkish`, and more), or `simple` for none. `morfeu init` applies a change and rebuilds the index. |

Memories keep the language they were written in; this setting only affects how keywords match.

## Language model

Used by extraction and consolidation. Search never calls it.

| Setting | Default | |
|---|---|---|
| `MORFEU_LLM_PROVIDER` | `openai` | `openai` (any OpenAI-compatible chat completions API) or `none`. |
| `MORFEU_LLM_MODEL` | `gpt-5-mini` | Must support structured output (JSON schema). |
| `MORFEU_LLM_BASE_URL` | OpenAI | e.g. `http://127.0.0.1:11434/v1` for Ollama, `http://127.0.0.1:1234/v1` for LM Studio, `https://openrouter.ai/api/v1`. |
| `MORFEU_LLM_API_KEY` | `OPENAI_API_KEY` | Not needed for local servers. |
| `MORFEU_MAX_LLM_CALLS` | `100` | Ceiling per extract or dream run. The rest waits for the next run. |

## Embeddings

Used when memories are written and when searching.

| Setting | Default | |
|---|---|---|
| `MORFEU_EMBEDDING_PROVIDER` | `openai` | `openai` (any OpenAI-compatible embeddings API), `ollama`, or `none` (keyword and entity search only). |
| `MORFEU_EMBEDDING_MODEL` | `text-embedding-3-small`, or `qwen3-embedding:0.6b` with Ollama | Changing it is safe: run `morfeu reindex` to embed existing memories with the new model. |
| `MORFEU_EMBEDDING_BASE_URL` | OpenAI, or `http://127.0.0.1:11434` with Ollama | |
| `MORFEU_EMBEDDING_API_KEY` | `OPENAI_API_KEY` | |
| `MORFEU_SEMANTIC_FLOOR` | `0.3` | Cosine similarity below which a vector match counts as noise. Tune it if a model returns too much or too little. |

## Ingestion and extraction

| Setting | Default | |
|---|---|---|
| `MORFEU_USER_ID` | `me` | What `user:me` resolves to. |
| `MORFEU_CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where Claude Code keeps session transcripts. |
| `MORFEU_INGEST_EXCLUDE` | | Comma-separated. Session folders whose name contains any of these are never read. |
| `MORFEU_NEVER_EXTRACT` | | Semicolon-separated subjects never turned into memories, e.g. `health; my employer's clients`. Checked twice: in the extraction prompt and by a separate filter. |
| `MORFEU_DECAY` | `off` | `on` archives extracted memories that are unimportant and unused for a long time (30 days to a year, by volatility). Archived memories stay in history. |

## Diagnostics

| Setting | Default | |
|---|---|---|
| `MORFEU_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Logs go to stderr. |
