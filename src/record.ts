import type pg from 'pg';
import type { ScreenItem, ScreenResult } from './types.ts';
import { contentHash, screen, type ScreenOptions } from './screen.ts';

type Db = pg.Pool;

async function targetIds(db: pg.PoolClient | Db, items: ScreenItem[]): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const { target } of items) {
    const k = `${target.table}\u0000${target.column}`;
    if (ids.has(k)) continue;
    const { rows } = await db.query('SELECT shadowmod.target_id($1, $2) AS id', [target.table, target.column]);
    ids.set(k, rows[0].id);
  }
  return ids;
}

/**
 * Append check + check_score rows for screen() results, in one transaction.
 * Call this after (and outside) the user's own save transaction: a moderation
 * failure must never roll back or block a save.
 */
export async function recordChecks(db: Db, results: ScreenResult[] | null): Promise<number[]> {
  if (!results?.length) return [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ids = await targetIds(client, results.map((r) => r.item));
    const checkIds: number[] = [];
    for (const r of results) {
      const { rows } = await client.query(
        `INSERT INTO shadowmod.check
           (target_id, row_key, author_key, status, content_hash, content_snapshot,
            provider, model, latency_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          ids.get(`${r.item.target.table}\u0000${r.item.target.column}`),
          r.item.rowKey,
          r.item.authorKey ?? null,
          r.status,
          r.contentHash,
          r.item.body,
          r.provider,
          r.model,
          r.latencyMs,
          r.error ? JSON.stringify(r.error) : null,
        ],
      );
      const checkId = Number(rows[0].id);
      checkIds.push(checkId);
      const entries = Object.entries(r.probabilities);
      if (entries.length) {
        await client.query(
          `INSERT INTO shadowmod.check_score (check_id, question, probability)
           SELECT $1, q, p FROM unnest($2::text[], $3::numeric[]) AS t(q, p)`,
          [checkId, entries.map(([q]) => q), entries.map(([, p]) => Math.round(p * 1e4) / 1e4)],
        );
      }
    }
    await client.query('COMMIT');
    return checkIds;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Drop items whose exact content was already screened (same content_hash with a
 * scored, refused or override result). Items whose last attempt was an error
 * are kept, so they get retried.
 */
export async function filterUnscreened(db: Db, items: ScreenItem[]): Promise<ScreenItem[]> {
  if (!items.length) return [];
  const ids = await targetIds(db, items);
  const { rows } = await db.query(
    `SELECT DISTINCT c.target_id, c.row_key, c.content_hash
     FROM shadowmod.check c
     JOIN unnest($1::smallint[], $2::text[], $3::text[]) AS i(target_id, row_key, content_hash)
       ON c.target_id = i.target_id AND c.row_key = i.row_key AND c.content_hash = i.content_hash
     WHERE c.status IN ('scored', 'refused', 'override')`,
    [
      items.map((i) => ids.get(`${i.target.table}\u0000${i.target.column}`)),
      items.map((i) => i.rowKey),
      items.map((i) => contentHash(i)),
    ],
  );
  const seen = new Set(rows.map((r) => `${r.target_id}\u0000${r.row_key}\u0000${r.content_hash}`));
  return items.filter(
    (i) => !seen.has(`${ids.get(`${i.target.table}\u0000${i.target.column}`)}\u0000${i.rowKey}\u0000${contentHash(i)}`),
  );
}

/**
 * The usual call after a save: skip unchanged text, screen the rest, record.
 * Never throws for model problems; returns the results (or null on timeout).
 */
export async function screenAndRecord(db: Db, items: ScreenItem[], opts: ScreenOptions) {
  const todo = await filterUnscreened(db, items);
  if (!todo.length) return [];
  const results = await screen(todo, opts);
  await recordChecks(db, results);
  return results;
}
