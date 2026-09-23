import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { saveMemory } from "../../src/memory/save.js";
import { T0, useTestApp } from "../support/app.js";

const app = useTestApp();

describe("schema", () => {
  it("is fully migrated and re-running migrate is a no-op", async () => {
    const result = await migrate(app.pool);
    expect(result.applied).toEqual([]);
    expect(result.current).toBe("0001_initial");
  });

  it("refuses to delete a memory or rewrite its claim", async () => {
    const { memory } = await saveMemory(
      app,
      { content: "Alex prefers tea to coffee", type: "preference", scope: { type: "user", id: "me" } },
      T0,
    );
    await expect(app.pool.query("DELETE FROM memories WHERE id = $1", [memory.id])).rejects.toThrow(/never deleted/);
    await expect(app.pool.query("UPDATE memories SET content = 'x' WHERE id = $1", [memory.id])).rejects.toThrow(
      /immutable/,
    );
    await expect(app.pool.query("DELETE FROM events")).rejects.toThrow(/never deleted/);
    // Bookkeeping columns stay writable.
    await app.pool.query("UPDATE memories SET confidence = 0.9 WHERE id = $1", [memory.id]);
  });

  it("lets a candidate's valid_from be settled, but not an active row's", async () => {
    const { memory } = await saveMemory(
      app,
      { content: "Alex works at Acme", type: "fact", scope: { type: "user", id: "me" } },
      T0,
    );
    await expect(app.pool.query("UPDATE memories SET valid_from = now() WHERE id = $1", [memory.id])).rejects.toThrow(
      /immutable/,
    );
  });
});
