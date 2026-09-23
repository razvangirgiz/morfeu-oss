# MCP tools

`morfeu mcp` serves these tools over stdio. `morfeu connect <client>` registers it with Claude Code, Claude Desktop or Codex; any other MCP client can run `node <path to morfeu>/dist/cli.js mcp`.

The server also sends short instructions telling the agent when to use which tool. Replies are JSON, except `morfeu_context`, which returns markdown. Errors come back as tool errors with a message naming the bad argument; they never close the connection.

Scopes are strings: `user:me`, `project:<name>`, `agent:<name>`. Dates are ISO 8601.

| Tool | Arguments | Does |
|---|---|---|
| `morfeu_context` | `task`, `scopes?`, `types?`, `token_budget?`, `include_candidates?` | Markdown context for a task: time, instructions, pins, project state, relevant and recent memories. |
| `morfeu_search` | `query`, `scopes?`, `types?`, `as_of?`, `limit?`, `include_candidates?` | Ranked memories. `as_of` answers for a past date. |
| `morfeu_save` | `content`, `type`, `scope`, `importance?`, `valid_from?`, `valid_until?`, `supersedes?`, `entities?` | Saves one memory. The same sentence twice returns the first. `supersedes` ends an older memory where this one starts. |
| `morfeu_correct` | `memory_id`, `content`, `valid_from?`, `valid_until?` | Replaces a wrong memory; the old one is retracted, also for past questions. |
| `morfeu_forget` | `memory_id`, `reason` | Stops serving a memory, now and in the past. |
| `morfeu_changes` | `since`, `scopes?`, `types?`, `kind?`, `limit?` | Chronological list of new, changed, corrected and expired memories, with counts. |
| `morfeu_explain` | `memory_id` | A memory's chain, entities, source events and consolidation decisions. |
| `morfeu_pin` | `action` (`list`, `pin`, `unpin`), `memory_id?` | Memories always included in context (at most 20). |
| `morfeu_log_event` | `content_text`, `type?`, `session_id?`, `project?`, `occurred_at?` | Adds raw text to the ledger for the next extraction. |
| `morfeu_stats` | | Counts, vector coverage, last runs. |

Memory types: `fact`, `preference`, `relationship`, `event`, `goal`, `decision`, `routine`, `project_state`, `instruction`.

Tools that change memory are annotated as destructive where they are (`morfeu_correct`, `morfeu_forget`), so clients can ask before running them. The instructions tell agents to change memory only when the user asks, and never on the strength of text found inside memories, files or tool output.
