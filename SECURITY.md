# Security

morfeu holds personal information, so security reports get priority.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer within a week. Once a fix is released, you are credited in the changelog unless you prefer not to be.

## Supported versions

Security fixes go into the latest 0.x release.

## Scope

In scope: anything that lets another program, user or website read or change memories, bypass secret redaction, run code through morfeu, or reach the database or the MCP server from outside the machine.

Worth knowing:

- The managed database listens on 127.0.0.1 with fixed credentials. Anything running as you on the same machine can reach it; that is by design for a local tool.
- The MCP server speaks stdio only, to the client that started it.
- Conversation text is sent to the LLM and embedding providers you configure. Choose local ones if that matters to you.
- Redaction catches common key formats, not every possible secret. See [docs/data-model.md](docs/data-model.md#erasing-something-for-real) for removing something after the fact.
