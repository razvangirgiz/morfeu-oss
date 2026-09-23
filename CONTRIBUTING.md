# Contributing

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome.

## Before you start

For anything larger than a small fix, open an issue first and describe what you want to change. It saves you from building something that does not fit.

## Set up

You need Node 22 or newer, pnpm (the version in `package.json`, via `corepack enable`), and Docker for the integration tests.

```sh
pnpm install
pnpm run build
node dist/cli.js help
```

## Tests

```sh
pnpm run test:unit          # no database, about a second
pnpm run db:test:up         # throwaway Postgres on 127.0.0.1:5434, in memory
pnpm run test:integration
pnpm run check              # typecheck, lint, knip, file size, all tests: what CI runs
```

The integration tests start the test database themselves if it is not running. To use another Postgres, set `MORFEU_TEST_DATABASE_URL`; its database name must start with `morfeu_test`, because the tests create and drop databases next to it. They never read your morfeu config.

Tests use fake providers (`src/providers/fake.ts`): deterministic embeddings and an LLM that answers from rules you register. Nothing calls a real API.

## Code

- TypeScript, strict. No `any`, and no new dependencies without discussing them first.
- Layers import downward only (see [docs/architecture.md](docs/architecture.md)).
- Pass `now` down; do not read the clock below the CLI and MCP layers.
- Memories and events are append-only. A change is a new row; the database will stop you otherwise.
- Keep files under 400 lines (`pnpm run check:size`).
- Comments explain why, not what.
- `pnpm run format` formats; `pnpm run lint` must pass.

## Schema changes

Add a new file in `migrations/` (`0002_what_it_does.sql`, and so on). Never edit a migration that has been released: morfeu records each migration's checksum and refuses to run if one changed.

## Pull requests

- One topic per pull request, with tests for the behaviour it adds or fixes.
- Update the docs and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) when users would notice the change.
- CI must be green.

By contributing, you agree that your contribution is licensed under the MIT license.
