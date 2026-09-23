# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change commands, settings or tool arguments; each such change is listed with what to do.

## [Unreleased]

## [0.1.0]

First public release.

- Append-only event ledger with secret redaction, enforced by the database.
- Ingestion of Claude Code transcripts.
- LLM extraction into candidate memories, and consolidation ("dream") that adds, deduplicates, supersedes, rewrites, expires or rejects them.
- Bitemporal memories: valid time and record time, so past questions exclude corrected claims.
- Hybrid search: vectors, full-text search in any Postgres language, and entities.
- MCP server with ten tools, and a CLI.
- `morfeu setup`, `doctor`, `demo`, daily schedule (launchd, systemd), backups, and connection to Claude Code, Claude Desktop and Codex.
- OpenAI-compatible LLMs (OpenAI, Ollama, LM Studio, OpenRouter) and OpenAI or Ollama embeddings.
