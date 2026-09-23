import { type Db, quoteIdent } from "./client.js";

const TOKEN_TYPES = "asciiword, asciihword, hword_asciipart, word, hword, hword_part";

/**
 * Points the `morfeu_fts` text search configuration at the language's
 * stemmer (Postgres ships snowball stemmers with stopword lists for about 30
 * languages) and rebuilds the keyword index when the language changed.
 * `simple` means no stemming and no stopwords.
 */
export async function applyLanguage(db: Db, language: string): Promise<{ changed: boolean }> {
  const current = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'fts_language'");
  const previous = current.rows[0]?.value ?? "simple";
  if (previous === language) return { changed: false };
  const dictionary = language === "simple" ? "simple" : `${language}_stem`;
  const exists = await db.query("SELECT 1 FROM pg_ts_dict WHERE dictname = $1", [dictionary]);
  if (exists.rowCount === 0) {
    const available = await db.query<{ dictname: string }>(
      "SELECT dictname FROM pg_ts_dict WHERE dictname LIKE '%\\_stem' ORDER BY dictname",
    );
    const names = available.rows.map((r) => r.dictname.replace(/_stem$/, "")).join(", ");
    throw new Error(`MORFEU_LANGUAGE=${language} is not a Postgres text search language. Available: simple, ${names}`);
  }
  await db.query(
    `ALTER TEXT SEARCH CONFIGURATION morfeu_fts ALTER MAPPING FOR ${TOKEN_TYPES} WITH unaccent, ${quoteIdent(dictionary)}`,
  );
  await db.query("REINDEX INDEX memories_fts");
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('fts_language', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [language],
  );
  return { changed: true };
}
