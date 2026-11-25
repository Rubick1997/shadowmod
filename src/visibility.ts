import type pg from 'pg';

const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(s)) {
    throw new Error(`shadowmod: unsafe SQL identifier ${JSON.stringify(s)}`);
  }
  return s;
};
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface VisibleToOptions {
  /** Content table name as registered in shadowmod.target (e.g. 'guestbook_post'). */
  table: string;
  /** Alias or table name used in your FROM clause. Default: table. */
  alias?: string;
  rowKeyColumn: string;
  authorColumn: string;
  /** Placeholder number for the viewer parameter. Default 1 ($1). */
  paramIndex?: number;
}

/**
 * SQL fragment for every public read:
 *   author = viewer OR (not hidden AND author not held)
 * The viewer is passed as a bind parameter, never interpolated.
 *
 *   const v = visibleTo(viewer, { table: 'guestbook_post', rowKeyColumn: 'id', authorColumn: 'author' });
 *   db.query(`SELECT * FROM guestbook_post WHERE ${v.sql} ORDER BY id DESC`, v.values);
 *
 * A row is hidden if any moderated column of that table is hidden.
 */
export function visibleTo(viewerKey: string | null, opts: VisibleToOptions): { sql: string; values: unknown[] } {
  const a = ident(opts.alias ?? opts.table);
  const key = `${a}.${ident(opts.rowKeyColumn)}`;
  const author = `${a}.${ident(opts.authorColumn)}`;
  const p = `$${opts.paramIndex ?? 1}`;
  const sql = `(${author}::text = ${p}::text OR (
    NOT EXISTS (
      SELECT 1 FROM shadowmod.hidden h
      WHERE h.row_key = ${key}::text
        AND h.target_id IN (SELECT t.id FROM shadowmod.target t WHERE t.table_name = ${literal(opts.table)}))
    AND NOT EXISTS (
      SELECT 1 FROM shadowmod.held_author ha WHERE ha.author_key = ${author}::text)))`;
  return { sql, values: [viewerKey] };
}

/**
 * For ORM queries that can't take raw SQL: which of these ids are hidden from
 * people other than their author. Filter them out unless the viewer wrote them.
 * Pass authorColumn/rowKeyColumn to also apply held_author using the real author
 * column; otherwise the author recorded on the latest check is used.
 */
export async function hiddenIds(
  db: pg.Pool | pg.PoolClient,
  table: string,
  ids: Array<string | number>,
  opts: { rowKeyColumn?: string; authorColumn?: string } = {},
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const keys = ids.map(String);
  const { rows } = await db.query(
    `SELECT h.row_key FROM shadowmod.hidden h
     JOIN shadowmod.target t ON t.id = h.target_id
     WHERE t.table_name = $1 AND h.row_key = ANY($2::text[])
     UNION
     SELECT c.row_key FROM shadowmod.check c
     JOIN shadowmod.target t ON t.id = c.target_id
     JOIN shadowmod.held_author ha ON ha.author_key = c.author_key
     WHERE t.table_name = $1 AND c.row_key = ANY($2::text[])`,
    [table, keys],
  );
  const out = new Set<string>(rows.map((r) => r.row_key));
  if (opts.authorColumn) {
    const t = ident(table);
    const k = ident(opts.rowKeyColumn ?? 'id');
    const au = ident(opts.authorColumn);
    const held = await db.query(
      `SELECT ${k}::text AS row_key FROM ${t}
       WHERE ${k}::text = ANY($1::text[])
         AND ${au}::text IN (SELECT author_key FROM shadowmod.held_author)`,
      [keys],
    );
    for (const r of held.rows) out.add(r.row_key);
  }
  return out;
}
