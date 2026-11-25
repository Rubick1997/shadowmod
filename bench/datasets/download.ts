/**
 * Downloads the public datasets and writes fixed, stratified samples to
 * bench/datasets/public/*.jsonl (committed, so the benchmark is reproducible
 * without the network). Raw downloads go to bench/datasets/raw/ (gitignored).
 *
 *  - UCI YouTube Spam Collection (CC BY 4.0)  -> 200 spam + 200 ham, label: offsite_contact
 *  - UCI SMS Spam Collection (CC BY 4.0)      -> 200 spam + 200 ham, label: offsite_contact
 *  - Jigsaw Civil Comments, test split (CC0)  -> 500 toxic + 500 non-toxic, label: abusive
 *    toxic = toxicity >= 0.5 (the dataset's usual cut-off). The natural toxic rate
 *    is ~8%, so this sample oversamples toxic comments to ~50%.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng, shuffle, type BenchItem } from '../lib.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const raw = join(here, 'raw');
const out = join(here, 'public');
mkdirSync(raw, { recursive: true });
mkdirSync(out, { recursive: true });

async function download(url: string, file: string) {
  const dest = join(raw, file);
  if (existsSync(dest)) return dest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

function unzip(zip: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
}

/** Minimal RFC 4180 CSV parser (handles quotes, commas and newlines in fields). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.length > 1);
}

function stratified(pos: BenchItem[], neg: BenchItem[], n: number, seed: number) {
  const r = rng(seed);
  return [...shuffle(pos, r).slice(0, n), ...shuffle(neg, r).slice(0, n)];
}

function write(name: string, items: BenchItem[]) {
  writeFileSync(join(out, `${name}.jsonl`), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  console.log(`${name}: ${items.length} items`);
}

async function youtube() {
  const zip = await download('https://archive.ics.uci.edu/static/public/380/youtube+spam+collection.zip', 'youtube.zip');
  const dir = join(raw, 'youtube');
  unzip(zip, dir);
  const items: BenchItem[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.csv')).sort()) {
    const [header, ...rows] = parseCsv(readFileSync(join(dir, f), 'utf8'));
    const ci = header!.indexOf('CONTENT');
    const li = header!.indexOf('CLASS');
    const idi = header!.indexOf('COMMENT_ID');
    for (const r of rows) {
      const text = r[ci]?.replace(/<br\s*\/?>/g, '\n').trim();
      if (!text) continue;
      items.push({ id: `yt:${r[idi]}`, source: 'youtube', text, labels: { offsite_contact: r[li] === '1' ? 1 : 0 } });
    }
  }
  const pos = items.filter((i) => i.labels.offsite_contact === 1);
  const neg = items.filter((i) => i.labels.offsite_contact === 0);
  write('youtube', stratified(pos, neg, 200, 1));
}

async function sms() {
  const zip = await download('https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip', 'sms.zip');
  const dir = join(raw, 'sms');
  unzip(zip, dir);
  const lines = readFileSync(join(dir, 'SMSSpamCollection'), 'utf8').split('\n').filter(Boolean);
  const items: BenchItem[] = lines.map((l, i) => {
    const [label, ...rest] = l.split('\t');
    return { id: `sms:${i}`, source: 'sms', text: rest.join('\t').trim(), labels: { offsite_contact: label === 'spam' ? 1 : 0 } };
  });
  const pos = items.filter((i) => i.labels.offsite_contact === 1);
  const neg = items.filter((i) => i.labels.offsite_contact === 0);
  write('sms', stratified(pos, neg, 200, 2));
}

async function civil() {
  const base = 'https://datasets-server.huggingface.co/filter?dataset=google/civil_comments&config=default&split=test';
  const fetchWhere = async (where: string, n: number, seed: number) => {
    const first = await (await fetch(`${base}&where=${encodeURIComponent(where)}&offset=0&length=1`)).json();
    const total: number = first.num_rows_total;
    const r = rng(seed);
    const rows: any[] = [];
    // 5 pages of 100 at fixed pseudo-random offsets across the filtered set.
    const pages = Math.ceil(n / 100);
    for (let p = 0; p < pages; p++) {
      const offset = Math.floor(((p + r() * 0.9) * (total - 100)) / pages);
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${base}&where=${encodeURIComponent(where)}&offset=${offset}&length=100`);
        if (res.ok) {
          rows.push(...(await res.json()).rows);
          break;
        }
        if (attempt > 4) throw new Error(`civil_comments: ${res.status}`);
        await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
      }
    }
    return { rows: rows.slice(0, n), total };
  };
  const toxic = await fetchWhere('"toxicity">=0.5', 500, 3);
  const clean = await fetchWhere('"toxicity"<0.5', 500, 4);
  const toItem = (x: any): BenchItem => ({
    id: `civil:${x.row_idx}`,
    source: 'civil_comments',
    text: x.row.text,
    labels: { abusive: x.row.toxicity >= 0.5 ? 1 : 0 },
    meta: { toxicity: Math.round(x.row.toxicity * 1000) / 1000 },
  });
  console.log(`civil_comments test split: ${toxic.total} toxic, ${clean.total} non-toxic`);
  write('civil_comments', [...toxic.rows.map(toItem), ...clean.rows.map(toItem)]);
}

await youtube();
await sms();
await civil();
