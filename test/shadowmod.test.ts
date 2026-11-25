import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applySchema,
  fakeProvider,
  hiddenIds,
  recordChecks,
  screen,
  screenAndRecord,
  visibleTo,
  type DecisionProvider,
  type ScreenItem,
} from '../src/index.ts';

let container: StartedPostgreSqlContainer;
let db: pg.Pool;
let target: number;

const TABLE = { table: 'guestbook_post', column: 'body' };

/** A provider that returns whatever you tell it to. */
function scripted(
  fn: (body: string) => { probabilities?: Record<string, number>; refused?: string[]; throws?: boolean },
  calls: string[] = [],
): DecisionProvider {
  return {
    name: 'scripted',
    model: 'test',
    async decide(input) {
      calls.push(input.post.body);
      const r = fn(input.post.body);
      if (r.throws) throw new Error('provider exploded');
      return { probabilities: r.probabilities ?? {}, refused: r.refused ?? [], model: 'test' };
    },
  };
}

async function save(author: string, body: string): Promise<string> {
  const { rows } = await db.query(
    'INSERT INTO guestbook_post (author, body) VALUES ($1, $2) RETURNING id::text',
    [author, body],
  );
  return rows[0].id;
}

async function edit(id: string, body: string) {
  await db.query('UPDATE guestbook_post SET body = $2 WHERE id = $1', [id, body]);
}

function item(id: string, author: string, body: string): ScreenItem {
  return { target: TABLE, rowKey: id, authorKey: author, body };
}

async function saveAndScreen(author: string, body: string, provider: DecisionProvider = fakeProvider()) {
  const id = await save(author, body);
  await screenAndRecord(db, [item(id, author, body)], { provider });
  return id;
}

async function visibleIds(viewer: string | null): Promise<string[]> {
  const v = visibleTo(viewer, { table: 'guestbook_post', rowKeyColumn: 'id', authorColumn: 'author' });
  const { rows } = await db.query(`SELECT id::text FROM guestbook_post WHERE ${v.sql} ORDER BY id`, v.values);
  return rows.map((r) => r.id);
}

async function isHidden(id: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM shadowmod.hidden WHERE target_id = $1 AND row_key = $2', [target, id]);
  return rows.length > 0;
}

const SPAM = 'Earn $$$ fast!! Text me at 555-0199 on WhatsApp';
const CLEAN = 'Lovely evening, thanks for hosting everyone!';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new pg.Pool({ connectionString: container.getConnectionUri() });
  // Test 11 relies on this: applying twice on a fresh container must succeed.
  await applySchema(db, { demo: true });
  await applySchema(db, { demo: true });
  target = (await db.query("SELECT shadowmod.target_id('guestbook_post', 'body') AS id")).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.query(
    'TRUNCATE shadowmod.check_score, shadowmod.check, shadowmod.held_author, guestbook_post RESTART IDENTITY',
  );
  await db.query(`UPDATE shadowmod.policy SET hide_at = 0.95, review_from = 0.5, enabled = true`);
});

describe('shadowmod', () => {
  it('1. a refusal on one question leaves that score missing; other questions still count', async () => {
    const provider = scripted(() => ({ probabilities: { offsite_contact: 0.99 }, refused: ['abusive'] }));
    const id = await saveAndScreen('bob', SPAM, provider);
    const { rows } = await db.query(
      `SELECT s.question, s.probability::float AS p, c.status FROM shadowmod.check c
       LEFT JOIN shadowmod.check_score s ON s.check_id = c.id WHERE c.row_key = $1`,
      [id],
    );
    expect(rows).toEqual([{ question: 'offsite_contact', p: 0.99, status: 'scored' }]);
    expect(await isHidden(id)).toBe(true);
  });

  it('2. a whole-call timeout records nothing, the save succeeds, nothing is hidden', async () => {
    const id = await save('bob', SPAM);
    const results = await screenAndRecord(db, [item(id, 'bob', SPAM)], {
      provider: fakeProvider({ delayMs: 500 }),
      timeoutMs: 50,
    });
    expect(results).toBeNull();
    expect((await db.query('SELECT count(*)::int AS n FROM shadowmod.check')).rows[0].n).toBe(0);
    expect(await visibleIds('alice')).toEqual([id]);
  });

  it('3. an error check after a hiding check does not un-hide; an error on clean content does not hide', async () => {
    const failing = scripted(() => ({ throws: true }));
    const spam = await saveAndScreen('bob', SPAM);
    expect(await isHidden(spam)).toBe(true);
    await recordChecks(db, await screen([item(spam, 'bob', SPAM)], { provider: failing }));
    expect(await isHidden(spam)).toBe(true);

    const clean = await save('alice', CLEAN);
    const res = await screen([item(clean, 'alice', CLEAN)], { provider: failing });
    expect(res?.[0]?.status).toBe('error');
    await recordChecks(db, res);
    expect(await isHidden(clean)).toBe(false);
    const statuses = (await db.query('SELECT status::text FROM shadowmod.check ORDER BY id')).rows.map((r) => r.status);
    expect(statuses).toEqual(['scored', 'error', 'error']);
  });

  it('4. a new scored clean check after an edit un-hides', async () => {
    const id = await saveAndScreen('bob', SPAM);
    expect(await isHidden(id)).toBe(true);
    await edit(id, CLEAN);
    await screenAndRecord(db, [item(id, 'bob', CLEAN)], { provider: fakeProvider() });
    expect(await isHidden(id)).toBe(false);
  });

  it('5. override show beats a high score; override hide beats a low one', async () => {
    const spam = await saveAndScreen('bob', SPAM);
    const clean = await saveAndScreen('alice', CLEAN);
    await db.query("SELECT shadowmod.override($1::smallint, $2, 'show', 'mod', 'false positive')", [target, spam]);
    await db.query("SELECT shadowmod.override($1::smallint, $2, 'hide', 'mod', 'context the model missed')", [target, clean]);
    expect(await isHidden(spam)).toBe(false);
    expect(await isHidden(clean)).toBe(true);

    // A re-score of the same text (e.g. a model upgrade) does not undo a human decision.
    await recordChecks(db, await screen([item(spam, 'bob', SPAM)], { provider: fakeProvider() }));
    expect(await isHidden(spam)).toBe(false);
  });

  it('6. a score inside the review band is in needs_review and is not hidden', async () => {
    const id = await saveAndScreen('alice', 'call the venue at 555-0100 to book tickets for the charity night');
    expect(await isHidden(id)).toBe(false);
    const { rows } = await db.query('SELECT row_key, scores FROM shadowmod.needs_review');
    expect(rows.map((r) => r.row_key)).toEqual([id]);
    expect(Number(rows[0].scores.offsite_contact)).toBeGreaterThanOrEqual(0.5);
    expect(await visibleIds('bob')).toEqual([id]);

    // Once a human decides, it leaves the queue.
    await db.query("SELECT shadowmod.override($1::smallint, $2, 'show', 'mod')", [target, id]);
    expect((await db.query('SELECT 1 FROM shadowmod.needs_review')).rows).toHaveLength(0);
  });

  it('7. the author sees their hidden post; another viewer does not', async () => {
    const spam = await saveAndScreen('bob', SPAM);
    const clean = await saveAndScreen('alice', CLEAN);
    expect(await visibleIds('bob')).toEqual([spam, clean]);
    expect(await visibleIds('alice')).toEqual([clean]);
    expect(await visibleIds(null)).toEqual([clean]);
    expect([...(await hiddenIds(db, 'guestbook_post', [spam, clean]))]).toEqual([spam]);
  });

  it('8. held author: all their posts hidden from others, visible to them', async () => {
    const a = await saveAndScreen('carol', CLEAN);
    const b = await save('carol', 'Another perfectly nice post'); // never screened at all
    const c = await saveAndScreen('alice', CLEAN);
    await db.query("INSERT INTO shadowmod.held_author (author_key, reason) VALUES ('carol', 'ban evasion')");
    expect(await visibleIds('alice')).toEqual([c]);
    expect(await visibleIds('carol')).toEqual([a, b, c]);
    const held = await hiddenIds(db, 'guestbook_post', [a, b, c], { authorColumn: 'author' });
    expect([...held].sort()).toEqual([a, b]);
  });

  it('9. changing policy.hide_at changes hidden without re-scoring; simulate_policy predicts it', async () => {
    const calls: string[] = [];
    const provider = scripted((body) => ({ probabilities: { offsite_contact: Number(body) } }), calls);
    for (const p of ['0.10', '0.70', '0.80', '0.96', '0.99']) await saveAndScreen('x', p, provider);
    const hiddenCount = async () => (await db.query('SELECT count(*)::int AS n FROM shadowmod.hidden')).rows[0].n;
    expect(await hiddenCount()).toBe(2);

    const sim = (await db.query("SELECT * FROM shadowmod.simulate_policy('offsite_contact', 0.75)")).rows[0];
    expect(sim).toEqual({ currently_hidden: '2', would_hide: '3', newly_hidden: '1', newly_unhidden: '0' });

    await db.query("UPDATE shadowmod.policy SET hide_at = 0.75 WHERE question = 'offsite_contact'");
    expect(await hiddenCount()).toBe(3);

    const back = (await db.query("SELECT * FROM shadowmod.simulate_policy('offsite_contact', 0.97)")).rows[0];
    expect(back.newly_unhidden).toBe('2');
    await db.query("UPDATE shadowmod.policy SET hide_at = 0.97 WHERE question = 'offsite_contact'");
    expect(await hiddenCount()).toBe(1);
    expect(calls).toHaveLength(5);
  });

  it('10. unchanged text is not re-screened', async () => {
    const calls: string[] = [];
    const provider = scripted(() => ({ probabilities: { abusive: 0.01 } }), calls);
    const id = await saveAndScreen('alice', CLEAN, provider);
    await screenAndRecord(db, [item(id, 'alice', CLEAN)], { provider });
    expect(calls).toHaveLength(1);
    await screenAndRecord(db, [item(id, 'alice', CLEAN + ' Edited.')], { provider });
    expect(calls).toHaveLength(2);
  });

  it('10b. an error is retried on the next save of the same text', async () => {
    const calls: string[] = [];
    let fail = true;
    const provider = scripted(() => (fail ? { throws: true } : { probabilities: { abusive: 0.01 } }), calls);
    const id = await saveAndScreen('alice', CLEAN, provider);
    fail = false;
    await screenAndRecord(db, [item(id, 'alice', CLEAN)], { provider });
    expect(calls).toHaveLength(2);
  });

  it('11. the schema applies twice on a fresh Postgres 16 container', async () => {
    const { rows } = await db.query('SHOW server_version');
    expect(rows[0].server_version).toMatch(/^16\./);
    await applySchema(db, { demo: true }); // third time, with data present
    const policy = (await db.query('SELECT count(*)::int AS n FROM shadowmod.policy')).rows[0].n;
    expect(policy).toBe(3);
  });

  it('the check log is append-only', async () => {
    const id = await saveAndScreen('bob', SPAM);
    await expect(db.query("UPDATE shadowmod.check SET note = 'x' WHERE row_key = $1", [id])).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM shadowmod.check_score')).rejects.toThrow(/append-only/);
  });

  it('a batch with one bad item still scores the others', async () => {
    const provider = scripted((body) => (body === 'boom' ? { throws: true } : { probabilities: { abusive: 0.02 } }));
    const res = await screen(
      [item('1', 'a', 'fine'), item('2', 'a', 'boom'), item('3', 'a', 'also fine')],
      { provider, concurrency: 2 },
    );
    expect(res?.map((r) => r.status)).toEqual(['scored', 'error', 'scored']);
  });

  it('all questions refused records a refused check that never hides', async () => {
    const provider = scripted(() => ({ refused: ['abusive', 'offsite_contact', 'adult_solicitation'] }));
    const id = await saveAndScreen('bob', SPAM, provider);
    const s = (await db.query('SELECT status::text FROM shadowmod.check WHERE row_key = $1', [id])).rows[0].status;
    expect(s).toBe('refused');
    expect(await isHidden(id)).toBe(false);
  });
});
