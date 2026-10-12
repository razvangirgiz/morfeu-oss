# morfeu

Long-term memory for AI agents over MCP, on Postgres. TypeScript strict, Node ≥22, pnpm (via corepack). Start with `README.md`; rules live in `CONTRIBUTING.md` and `docs/architecture.md`.

```sh
pnpm install
pnpm run build            # dist/ — what runs
pnpm run test:unit        # no database, about a second
pnpm run test:integration # throwaway Postgres; starts it if needed
pnpm run check            # typecheck, lint, knip, file size, all tests — what CI runs
```

- Layers import downward only; pass `now` down instead of reading the clock below CLI/MCP.
- Memories and events are append-only — a change is a new row.
- Keep files under 400 lines (`pnpm run check:size`). No `any`; no new dependencies without discussing first.
- A release is a version bump plus a tag; CI publishes. Do not publish by hand.
