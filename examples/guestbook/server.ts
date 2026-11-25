/**
 * Guestbook demo. npm run demo  ->  http://localhost:3000
 *
 * Post as alice or bob (no auth, it's a dropdown). Nothing is ever rejected.
 * Hidden posts stay visible to their author, so a spammer gets no signal.
 * /moderator lists the review queue and a random sample of hidden posts.
 *
 * Uses the fake keyword provider unless SHADOWMOD_PROVIDER is set (openai | jev | gemini).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { applySchema, providerFromEnv, screenAndRecord, visibleTo } from '../../src/index.ts';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
} catch {}

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://shadowmod:shadowmod@localhost:5433/shadowmod',
});
const provider = providerFromEnv();
const PORT = Number(process.env.PORT ?? 3000);
const USERS = ['alice', 'bob'];
const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

await applySchema(db, { demo: true });
const TARGET = (await db.query("SELECT shadowmod.target_id('guestbook_post', 'body') AS id")).rows[0].id as number;

/** Save first (never rejected), then screen outside the save. */
async function savePost(author: string, body: string, context?: string) {
  const { rows } = await db.query(
    'INSERT INTO guestbook_post (author, body, context) VALUES ($1, $2, $3) RETURNING id::text',
    [author, body, context || null],
  );
  try {
    await screenAndRecord(
      db,
      [{ target: { table: 'guestbook_post', column: 'body' }, rowKey: rows[0].id, authorKey: author, body, context: context || undefined }],
      { provider, timeoutMs: 5000 },
    );
  } catch (e) {
    console.error('screening failed, post stays visible:', e); // fail open
  }
}

if ((await db.query('SELECT count(*)::int AS n FROM guestbook_post')).rows[0].n === 0) {
  await savePost('alice', 'Lovely evening yesterday, thanks to everyone who helped set up the hall!', 'Charity night');
  await savePost('bob', 'Earn $$$ fast from home!! Text me at 555-0199 on WhatsApp', 'Charity night');
  await savePost('alice', 'call the venue at 555-0100 to book tickets for the charity night', 'Charity night');
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function render(res: ServerResponse, title: string, main: string, viewer: string) {
  const nav = `<form class="who" method="get" action="/">
      <label>Viewing as
        <select name="as" onchange="this.form.submit()">
          ${USERS.map((u) => `<option ${u === viewer ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
      </label>
      <a href="/moderator?as=${esc(viewer)}">Moderator</a>
    </form>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  // Function replacers: a string replacement would treat "$$" in user text as an escape.
  const slots: Record<string, string> = { title: esc(title), nav, main, provider: esc(`${provider.name} / ${provider.model}`) };
  res.end(page.replace(/\{\{(\w+)\}\}/g, (_, k: string) => slots[k] ?? ''));
}

async function board(res: ServerResponse, viewer: string) {
  const v = visibleTo(viewer, { table: 'guestbook_post', alias: 'p', rowKeyColumn: 'id', authorColumn: 'author' });
  const { rows } = await db.query(
    `SELECT p.id, p.author, p.body, p.context, p.created_at FROM guestbook_post p WHERE ${v.sql} ORDER BY p.id DESC`,
    v.values,
  );
  const posts = rows
    .map(
      (r) => `<article class="post">
        <header><strong>${esc(r.author)}</strong>${r.context ? ` <span class="ctx">in ${esc(r.context)}</span>` : ''}
        <time>${new Date(r.created_at).toLocaleString()}</time></header>
        <p>${esc(r.body)}</p>
      </article>`,
    )
    .join('');
  render(
    res,
    'Guestbook',
    `<form class="compose" method="post" action="/post">
       <input type="hidden" name="as" value="${esc(viewer)}">
       <input name="context" placeholder="Thread (optional, e.g. Charity night)" value="Charity night">
       <textarea name="body" required rows="3" placeholder="Write something as ${esc(viewer)}…"></textarea>
       <button>Post as ${esc(viewer)}</button>
     </form>
     <p class="hint">Try posting <code>Earn $$$ fast!! DM me on Telegram 555-0123</code> as one user, then switch to the other.
     Authors always see their own posts, so nothing tells a spammer they were caught.</p>
     <section>${posts || '<p class="empty">No posts yet.</p>'}</section>`,
    viewer,
  );
}

async function moderator(res: ServerResponse, viewer: string) {
  const review = (await db.query('SELECT * FROM shadowmod.needs_review ORDER BY checked_at DESC LIMIT 50')).rows;
  const hidden = (await db.query('SELECT * FROM shadowmod.hidden_audit LIMIT 20')).rows;
  const scores = (s: Record<string, string> | null) =>
    Object.entries(s ?? {})
      .sort(([, a], [, b]) => Number(b) - Number(a))
      .map(([k, v]) => `<span class="score ${Number(v) >= 0.5 ? 'hi' : ''}">${esc(k)} ${Number(v).toFixed(2)}</span>`)
      .join(' ');
  const row = (r: any) => `<tr>
      <td><strong>${esc(r.author_key)}</strong><br><span class="muted">#${esc(r.row_key)}</span></td>
      <td>${esc(r.content_snapshot)}</td>
      <td>${r.status === 'override' ? `override by ${esc(r.moderator)}` : scores(r.scores)}</td>
      <td class="actions">
        <form method="post" action="/override">
          <input type="hidden" name="as" value="${esc(viewer)}"><input type="hidden" name="row_key" value="${esc(r.row_key)}">
          <button name="verdict" value="show">Show</button><button name="verdict" value="hide" class="danger">Hide</button>
        </form>
      </td></tr>`;
  const table = (rows: any[], empty: string) =>
    rows.length
      ? `<table><thead><tr><th>Author</th><th>Text checked</th><th>Scores</th><th></th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table>`
      : `<p class="empty">${empty}</p>`;
  render(
    res,
    'Moderator',
    `<h2>Needs review</h2>
     <p class="hint">Scores inside the review band. These posts are <em>visible</em> until a human decides.</p>
     ${table(review, 'Nothing to review.')}
     <h2>Hidden: random audit sample</h2>
     <p class="hint">Spot-check these for false positives. A wrongly hidden post is silent: nobody else will ever report it.</p>
     ${table(hidden, 'Nothing is hidden.')}`,
    viewer,
  );
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const viewer = USERS.includes(url.searchParams.get('as') ?? '') ? url.searchParams.get('as')! : 'alice';
    if (req.method === 'GET' && url.pathname === '/') return await board(res, viewer);
    if (req.method === 'GET' && url.pathname === '/moderator') return await moderator(res, viewer);
    if (req.method === 'POST' && url.pathname === '/post') {
      const f = await readForm(req);
      const as = USERS.includes(f.get('as') ?? '') ? f.get('as')! : 'alice';
      const body = (f.get('body') ?? '').trim();
      if (body) await savePost(as, body.slice(0, 2000), (f.get('context') ?? '').trim().slice(0, 200));
      res.writeHead(303, { Location: `/?as=${as}` });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/override') {
      const f = await readForm(req);
      const verdict = f.get('verdict') === 'hide' ? 'hide' : 'show';
      await db.query('SELECT shadowmod.override($1::smallint, $2, $3::shadowmod.verdict, $4, $5)', [
        TARGET,
        f.get('row_key'),
        verdict,
        'demo-moderator',
        'via /moderator',
      ]);
      res.writeHead(303, { Location: `/moderator?as=${f.get('as') ?? 'alice'}` });
      return res.end();
    }
    res.writeHead(404).end('Not found');
  } catch (e) {
    console.error(e);
    res.writeHead(500).end('Server error');
  }
}).listen(PORT, () => console.log(`guestbook demo: http://localhost:${PORT}  (provider: ${provider.name})`));
