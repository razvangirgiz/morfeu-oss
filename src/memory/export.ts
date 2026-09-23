import { MEMORY_TYPES, type Scope } from "../core/types.js";
import { type Db, Params } from "../db/client.js";
import { forgottenSql } from "./forget.js";
import { mapMemory, memoryColumns } from "./row.js";
import { scopeSql } from "./serving.js";

export type ExportOptions = {
  scopes?: readonly Scope[];
  /** Include superseded, expired, invalidated and candidate memories too. */
  all?: boolean;
};

/**
 * Everything morfeu remembers, as markdown grouped by scope and type. The
 * format is for people to read (and to leave with); it is not an import format.
 */
export async function exportMarkdown(db: Db, options: ExportOptions = {}): Promise<string> {
  const p = new Params();
  const where = [
    scopeSql(options.scopes, (v) => p.add(v), "m"),
    options.all ? `NOT ${forgottenSql("m")}` : "m.status = 'active' AND m.archived_at IS NULL",
  ].join(" AND ");
  const res = await db.query(
    `SELECT ${memoryColumns("m")} FROM memories m WHERE ${where}
     ORDER BY m.scope_type, m.scope_id, m.observed_at DESC, m.id`,
    p.values,
  );
  const memories = res.rows.map(mapMemory);
  const lines: string[] = [];
  const scopes = [...new Set(memories.map((m) => `${m.scope_type}:${m.scope_id}`))];
  for (const scope of scopes) {
    lines.push(`# ${scope}`, "");
    const inScope = memories.filter((m) => `${m.scope_type}:${m.scope_id}` === scope);
    for (const type of MEMORY_TYPES) {
      const ofType = inScope.filter((m) => m.type === type);
      if (ofType.length === 0) continue;
      lines.push(`## ${type}`, "");
      for (const m of ofType) {
        const facts = [`observed ${m.observed_at.toISOString().slice(0, 10)}`, m.origin];
        if (m.valid_from) facts.push(`from ${m.valid_from.toISOString().slice(0, 10)}`);
        if (m.valid_until) facts.push(`until ${m.valid_until.toISOString().slice(0, 10)}`);
        if (m.status !== "active") facts.push(m.status);
        if (m.retracted_at) facts.push("retracted");
        if (m.pinned_at) facts.push("pinned");
        lines.push(`- ${m.content.replace(/\s*\n\s*/g, " ")} (${facts.join(", ")}) \`${m.id}\``);
      }
      lines.push("");
    }
  }
  const counts = await db.query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM memories GROUP BY status ORDER BY status",
  );
  lines.push("---", counts.rows.map((r) => `${r.status} ${r.n}`).join(", ") || "no memories yet");
  return lines.join("\n");
}
