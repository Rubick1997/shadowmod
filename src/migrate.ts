import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const sqlDir = fileURLToPath(new URL('../sql/', import.meta.url));

/** Apply sql/001_schema.sql (and optionally the demo table). Safe to run repeatedly. */
export async function applySchema(db: pg.Pool | pg.Client, opts: { demo?: boolean } = {}) {
  await db.query(await readFile(`${sqlDir}001_schema.sql`, 'utf8'));
  if (opts.demo) await db.query(await readFile(`${sqlDir}002_demo.sql`, 'utf8'));
}
