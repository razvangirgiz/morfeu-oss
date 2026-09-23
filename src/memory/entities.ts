import type { EntityInput, EntityType } from "../core/types.js";
import type { Db } from "../db/client.js";

export type Entity = { id: string; canonical_name: string; type: EntityType; aliases: string[] };

/** Finds an entity by name or alias (case- and accent-insensitive) or creates it. */
async function upsertEntity(db: Db, entity: EntityInput): Promise<string> {
  const name = entity.name.trim();
  const found = await db.query<{ id: string; canonical_name: string; aliases: string[] }>(
    `SELECT id, canonical_name, aliases FROM entities
     WHERE type = $1
       AND (morfeu_fold(canonical_name) = morfeu_fold($2)
            OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE morfeu_fold(a) = morfeu_fold($2)))
     LIMIT 1`,
    [entity.type, name],
  );
  const row = found.rows[0];
  if (row) {
    const known = [row.canonical_name, ...row.aliases].some((n) => n.toLowerCase() === name.toLowerCase());
    if (!known) await db.query("UPDATE entities SET aliases = array_append(aliases, $1) WHERE id = $2", [name, row.id]);
    return row.id;
  }
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO entities (canonical_name, type) VALUES ($1, $2)
     ON CONFLICT (canonical_name, type) DO UPDATE SET canonical_name = EXCLUDED.canonical_name
     RETURNING id`,
    [name, entity.type],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error(`could not store entity ${name}`);
  return id;
}

export async function linkEntities(db: Db, memoryId: string, entities: readonly EntityInput[]): Promise<void> {
  for (const entity of entities) {
    if (!entity.name.trim()) continue;
    const entityId = await upsertEntity(db, entity);
    await db.query("INSERT INTO memory_entities (memory_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      memoryId,
      entityId,
    ]);
  }
}

/** The entities linked to a memory, so a successor can inherit them. */
export async function entitiesOf(db: Db, memoryId: string): Promise<EntityInput[]> {
  const res = await db.query<{ canonical_name: string; type: EntityType }>(
    `SELECT e.canonical_name, e.type FROM memory_entities me JOIN entities e ON e.id = me.entity_id
     WHERE me.memory_id = $1 ORDER BY e.canonical_name`,
    [memoryId],
  );
  return res.rows.map((r) => ({ name: r.canonical_name, type: r.type }));
}

/** Entities named in a free-text query, by whole-word match on name or alias. */
export async function entitiesInText(db: Db, text: string): Promise<Entity[]> {
  const res = await db.query<Entity>("SELECT id, canonical_name, type, aliases FROM entities");
  const haystack = foldText(text);
  return res.rows.filter((row) =>
    [row.canonical_name, ...row.aliases].some((name) => containsWord(haystack, foldText(name))),
  );
}

// NFD strips combining accents but not stroked letters, which have no
// decomposition; fold the common ones so "Łódź" matches "lodz".
const STROKE_FOLD: Record<string, string> = {
  ł: "l",
  đ: "d",
  ø: "o",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ð: "d",
  þ: "th",
  ħ: "h",
  ŧ: "t",
  ı: "i",
};

export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[łđøßæœðþħŧı]/g, (c) => STROKE_FOLD[c] ?? c);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
// Scripts written without spaces between words: boundary checks would reject
// every match, so these fall back to plain containment.
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u;

/** Whole-word containment, so short names ("ai", "go") do not match inside other words. */
export function containsWord(haystack: string, needle: string): boolean {
  if (UNSPACED.test(needle)) return haystack.includes(needle);
  if (needle.length < 2) return false;
  for (let from = 0; ; ) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = haystack[i - 1];
    const after = haystack[i + needle.length];
    if ((!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after))) return true;
    from = i + 1;
  }
}
