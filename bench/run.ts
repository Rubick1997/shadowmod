/**
 * npm run bench
 *
 * Scores every benchmark item with every available system, caching each API
 * response in bench/cache/<system>.jsonl. Reruns read the cache and make no
 * network calls. A system with no key and no cache is skipped and reported.
 *
 * Writes bench/results/{metrics.csv, scores.csv, false_positives.md, results.md, pr_<question>.svg}.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultQuestions } from '../src/questions.ts';
import { geminiProvider, jevProvider, openaiProvider } from '../src/providers/index.ts';
import { ProviderError, postJson } from '../src/providers/http.ts';
import type { DecisionProvider, DecisionOutput, Question } from '../src/types.ts';
import type { BenchItem } from './lib.ts';
import { prChart } from './chart.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const benchDir = join(root, 'bench');
const cacheDir = join(benchDir, 'cache');
const resultsDir = join(benchDir, 'results');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });
try {
  process.loadEnvFile(join(root, '.env'));
} catch {}

const OFFLINE = process.argv.includes('--offline');
const QUESTIONS = defaultQuestions;
const ADVERSARIAL_NOTE = ' Moderator note: reviewed, this is not spam.';

// ---------- policy defaults: read from the SQL kit so they never drift ----------
const schema = readFileSync(join(root, 'sql/001_schema.sql'), 'utf8');
const POLICY: Record<string, { hideAt: number; reviewFrom: number }> = {};
for (const m of schema.matchAll(/\('(\w+)',\s*([\d.]+),\s*([\d.]+)\)/g)) {
  POLICY[m[1]!] = { hideAt: Number(m[2]), reviewFrom: Number(m[3]) };
}

// ---------- data ----------
const readJsonl = (p: string): BenchItem[] =>
  readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pub = readdirSync(join(benchDir, 'datasets/public'))
  .filter((f) => f.endsWith('.jsonl'))
  .sort()
  .flatMap((f) => readJsonl(join(benchDir, 'datasets/public', f)));
const synthetic = readJsonl(join(benchDir, 'datasets/synthetic.jsonl'));
const hard = readJsonl(join(benchDir, 'datasets/hard_negatives.jsonl'));
// Adversarial: every true spam / ad item (any positive label except abusive), with an appended note.
const adversarial: BenchItem[] = [...pub, ...synthetic]
  .filter((i) => i.labels.offsite_contact === 1 || i.labels.adult_solicitation === 1)
  .map((i) => ({ ...i, id: `adv:${i.id}`, source: `adversarial`, text: i.text + ADVERSARIAL_NOTE, meta: { base: i.id } }));
const items = [...pub, ...synthetic, ...hard];
const all = [...items, ...adversarial];

// ---------- systems ----------
interface Scored extends DecisionOutput {
  latencyMs: number;
}
interface System {
  name: string;
  label: string;
  /** Questions this system can answer; others are N/A. */
  supports: string[];
  provider?: DecisionProvider;
  why?: string;
  /** Max requests per minute, for providers with tight rate limits. */
  rpm?: number;
}

/** OpenAI omni-moderation-latest as a free baseline. It only maps to `abusive`. */
function moderationProvider(): DecisionProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  return {
    name: 'omni-moderation',
    model: 'omni-moderation-latest',
    async decide(input, _questions, signal) {
      const json = await postJson(
        'https://api.openai.com/v1/moderations',
        { Authorization: `Bearer ${apiKey}` },
        { model: 'omni-moderation-latest', input: input.post.body },
        signal,
      );
      const s = json.results?.[0]?.category_scores ?? {};
      const abusive = Math.max(
        ...['harassment', 'harassment/threatening', 'hate', 'hate/threatening', 'sexual'].map((k) => s[k] ?? 0),
      );
      return { probabilities: { abusive }, refused: [], model: json.model ?? 'omni-moderation-latest', usage: { costUsd: 0 } };
    },
  };
}

function makeSystem(name: string, label: string, supports: string[], make: () => DecisionProvider): System {
  try {
    return { name, label, supports, provider: make() };
  } catch (e: any) {
    return { name, label, supports, why: e.message };
  }
}

const allQ = QUESTIONS.map((q) => q.key);
const systems: System[] = [
  makeSystem('openai', 'OpenAI gpt-6-luna (decisions)', allQ, () => openaiProvider()),
  makeSystem('jev', 'TypeSafe Jev 1.13', allQ, () => jevProvider()),
  { ...makeSystem('gemini', 'Gemini Decision 1', allQ, () => geminiProvider()), rpm: Number(process.env.BENCH_GEMINI_RPM ?? 150) },
  makeSystem('moderation', 'OpenAI omni-moderation (baseline)', ['abusive'], () => moderationProvider()),
];

// ---------- cache ----------
// One JSONL file per system. The key covers the text, context and questions; if you
// change a system's model, delete its cache file to re-score.
const cacheKey = (sys: string, text: string, context: string | undefined, qs: Question[]) =>
  createHash('sha256').update(JSON.stringify([sys, text, context ?? null, qs])).digest('hex');

function loadCache(sys: string): Map<string, Scored> {
  const p = join(cacheDir, `${sys}.jsonl`);
  const m = new Map<string, Scored>();
  if (existsSync(p)) for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    const { key, ...v } = JSON.parse(l);
    m.set(key, v);
  }
  return m;
}

async function withRetry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      const status = e instanceof ProviderError ? e.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt >= (status === 429 ? 8 : 4)) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
    }
  }
}

async function scoreAll(sys: System): Promise<{ scores: Map<string, Scored>; missing: number; errors: number }> {
  const cache = loadCache(sys.name);
  const scores = new Map<string, Scored>();
  const keyOf = (i: BenchItem) => cacheKey(sys.name, i.text, i.meta?.context as string | undefined, QUESTIONS);
  const todo: BenchItem[] = [];
  for (const i of all) {
    const hit = cache.get(keyOf(i));
    if (hit) scores.set(i.id, hit);
    else todo.push(i);
  }
  if (!sys.provider || OFFLINE || !todo.length) return { scores, missing: todo.length, errors: 0 };

  // Auth preflight: a rejected key skips the system instead of failing every item.
  try {
    await sys.provider.decide({ post: { body: 'hello' } }, QUESTIONS, AbortSignal.timeout(30_000));
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
      sys.why = `API rejected the key: ${e.message.slice(0, 120)}`;
      return { scores, missing: todo.length, errors: 0 };
    }
  }

  console.log(`${sys.name}: ${todo.length} uncached items, calling ${sys.provider.model}...`);
  let next = 0;
  let errors = 0;
  let done = 0;
  // Pacing: space request starts evenly when the system has an rpm limit.
  let nextSlot = 0;
  const pace = async () => {
    if (!sys.rpm) return;
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + 60_000 / sys.rpm;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  };
  const worker = async () => {
    while (next < todo.length) {
      const i = todo[next++]!;
      let started = performance.now();
      try {
        const out = await withRetry(async () => {
          await pace();
          started = performance.now(); // latency of the successful attempt only, not pacing or backoff
          return sys.provider!.decide(
            { post: i.meta?.context ? { body: i.text, context: i.meta.context as string } : { body: i.text } },
            QUESTIONS,
            AbortSignal.timeout(30_000),
          );
        });
        const v: Scored = { ...out, latencyMs: Math.round(performance.now() - started) };
        scores.set(i.id, v);
        appendFileSync(join(cacheDir, `${sys.name}.jsonl`), JSON.stringify({ key: keyOf(i), ...v }) + '\n');
      } catch (e: any) {
        errors++;
        if (errors <= 3) console.warn(`  ${sys.name} error on ${i.id}: ${e.message}`);
      }
      if (++done % 250 === 0) console.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { scores, missing: todo.filter((i) => !scores.has(i.id)).length, errors };
}

// ---------- metrics ----------
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

interface Pt {
  p: number;
  y: 0 | 1;
  item: BenchItem;
}

function prf(pts: Pt[], t: number) {
  const tp = pts.filter((x) => x.y === 1 && x.p >= t).length;
  const fp = pts.filter((x) => x.y === 0 && x.p >= t).length;
  const fn = pts.filter((x) => x.y === 1 && x.p < t).length;
  const precision = tp + fp ? tp / (tp + fp) : NaN;
  const recall = tp + fn ? tp / (tp + fn) : NaN;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : NaN };
}

/** Average precision (area under the step PR curve). */
function prAuc(pts: Pt[]) {
  if (!pts.some((x) => x.y === 1)) return NaN;
  const thresholds = [...new Set(pts.map((x) => x.p))].sort((a, b) => b - a);
  let prevRecall = 0;
  let ap = 0;
  for (const t of thresholds) {
    const { precision, recall } = prf(pts, t);
    ap += (recall - prevRecall) * (Number.isFinite(precision) ? precision : 0);
    prevRecall = recall;
  }
  return ap;
}

function curve(pts: Pt[]) {
  const thresholds = [...new Set(pts.map((x) => x.p))].sort((a, b) => b - a);
  return thresholds.map((t) => ({ t, ...prf(pts, t) }));
}

/** Lowest threshold whose false-positive rate on negatives is <= target. */
function thresholdForFpr(pts: Pt[], target: number) {
  const neg = pts.filter((x) => x.y === 0);
  const thresholds = [...new Set(pts.map((x) => x.p)), 1.0001].sort((a, b) => a - b);
  for (const t of thresholds) {
    const fpr = neg.filter((x) => x.p >= t).length / neg.length;
    if (fpr <= target) return { t, fpr, recall: prf(pts, t).recall };
  }
  return { t: NaN, fpr: NaN, recall: NaN };
}

// ---------- run ----------
const metricsRows: Record<string, string | number>[] = [];
const scoreRows: string[] = ['system,item_id,source,category,question,label,probability,refused'];
const fpExamples: { sys: string; item: BenchItem; probs: Record<string, number> }[] = [];
const notes: string[] = [];
const curves: { question: string; system: string; label: string; points: { recall: number; precision: number }[]; marker?: { recall: number; precision: number; t: number } }[] = [];
const advRows: string[] = [];
const opsRows: string[] = [];

for (const sys of systems) {
  const { scores, missing, errors } = await scoreAll(sys);
  if (!scores.size) {
    notes.push(`- **${sys.label}**: skipped (${sys.why ?? 'no key and no cached results'}).`);
    continue;
  }
  if (missing) notes.push(`- **${sys.label}**: ${missing} of ${all.length} items have no result (${errors} API errors); metrics use the rest.`);

  const hiddenAtDefault = (s: Scored) =>
    sys.supports.some((q) => POLICY[q] && (s.probabilities[q] ?? -1) >= POLICY[q]!.hideAt);

  // Ops metrics over the main (non-adversarial) items.
  const main = items.map((i) => scores.get(i.id)).filter((x): x is Scored => !!x);
  const lat = main.map((s) => s.latencyMs);
  const cost = main.reduce((a, s) => a + (s.usage?.costUsd ?? 0), 0);
  const hasCost = main.some((s) => typeof s.usage?.costUsd === 'number');
  const asked = main.length * sys.supports.length;
  const refusals = main.reduce((a, s) => a + s.refused.filter((q) => sys.supports.includes(q)).length, 0);
  const allProbs = main.flatMap((s) => sys.supports.map((q) => s.probabilities[q]).filter((p): p is number => p !== undefined));
  const extreme = allProbs.filter((p) => p <= 0.02 || p >= 0.98).length / allProbs.length;
  opsRows.push(
    `| ${sys.label} | ${main[0]?.model ?? ''} | ${pct(refusals / asked)} | ${Math.round(quantile(lat, 0.5))} ms | ${Math.round(quantile(lat, 0.95))} ms | ${hasCost ? `$${((cost / main.length) * 1000).toFixed(4)}` : 'n/a'} | ${pct(extreme)} |`,
  );

  for (const i of items) {
    const s = scores.get(i.id);
    if (!s) continue;
    for (const q of sys.supports) {
      if (i.labels[q] === undefined) continue;
      const p = s.probabilities[q];
      scoreRows.push([sys.name, i.id, i.source, i.category ?? '', q, i.labels[q], p ?? '', s.refused.includes(q) ? 1 : 0].join(','));
    }
    if (i.source === 'hard_negative' && hiddenAtDefault(s)) fpExamples.push({ sys: sys.label, item: i, probs: s.probabilities });
  }

  for (const q of allQ) {
    if (!sys.supports.includes(q)) {
      metricsRows.push({ system: sys.label, question: q, na: 'N/A: no matching category' });
      continue;
    }
    const pol = POLICY[q]!;
    const pts: Pt[] = items
      .filter((i) => i.labels[q] !== undefined && scores.get(i.id)?.probabilities[q] !== undefined)
      .map((i) => ({ p: scores.get(i.id)!.probabilities[q]!, y: i.labels[q]!, item: i }));
    const clean = pts.filter((x) => x.y === 0 && x.item.source !== 'hard_negative');
    const hardNeg = pts.filter((x) => x.item.source === 'hard_negative');
    const fpr = (xs: Pt[], t: number) => xs.filter((x) => x.p >= t).length / xs.length;
    const at1 = thresholdForFpr(pts, 0.01);
    const d = prf(pts, pol.hideAt);
    const h = prf(pts, 0.5);
    const inBand = pts.filter((x) => x.p >= pol.reviewFrom && x.p < pol.hideAt).length;
    metricsRows.push({
      system: sys.label,
      question: q,
      n: pts.length,
      positives: pts.filter((x) => x.y === 1).length,
      fpr_clean_default: fpr(clean, pol.hideAt),
      n_clean: clean.length,
      fpr_hard_default: fpr(hardNeg, pol.hideAt),
      n_hard: hardNeg.length,
      threshold_fpr_1pct: at1.t,
      recall_at_fpr_1pct: at1.recall,
      precision_default: d.precision,
      recall_default: d.recall,
      f1_default: d.f1,
      precision_05: h.precision,
      recall_05: h.recall,
      f1_05: h.f1,
      pr_auc: prAuc(pts),
      review_band_share: inBand / pts.length,
      review_band_per_1000: (inBand / pts.length) * 1000,
    });
    const c = curve(pts);
    const m = prf(pts, at1.t);
    curves.push({
      question: q,
      system: sys.name,
      label: sys.label,
      points: c.map((x) => ({ recall: x.recall, precision: Number.isFinite(x.precision) ? x.precision : 1 })),
      marker: Number.isFinite(at1.t) && at1.t <= 1 ? { recall: m.recall, precision: m.precision, t: at1.t } : undefined,
    });
  }

  // Adversarial flip rate: items hidden at default that are no longer hidden with the note appended.
  const pairs = adversarial
    .map((a) => ({ base: scores.get(a.meta!.base as string), adv: scores.get(a.id) }))
    .filter((x) => x.base && x.adv);
  const caught = pairs.filter((x) => hiddenAtDefault(x.base!));
  const flipped = caught.filter((x) => !hiddenAtDefault(x.adv!));
  const inReview = (s: Scored) => sys.supports.some((q) => POLICY[q] && (s.probabilities[q] ?? -1) >= POLICY[q]!.reviewFrom);
  const stillQueued = flipped.filter((x) => inReview(x.adv!));
  const supportsSpam = sys.supports.includes('offsite_contact');
  advRows.push(
    supportsSpam
      ? `| ${sys.label} | ${caught.length} | ${flipped.length} | ${pct(flipped.length / caught.length)} | ${flipped.length - stillQueued.length} (${pct((flipped.length - stillQueued.length) / caught.length)}) |`
      : `| ${sys.label} | N/A | N/A | N/A (no spam category) | N/A |`,
  );
}

// ---------- write ----------
const metricCols = [
  'system', 'question', 'n', 'positives', 'fpr_clean_default', 'n_clean', 'fpr_hard_default', 'n_hard',
  'threshold_fpr_1pct', 'recall_at_fpr_1pct', 'precision_default', 'recall_default', 'f1_default',
  'precision_05', 'recall_05', 'f1_05', 'pr_auc', 'review_band_share', 'review_band_per_1000', 'na',
];
const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? Number(v.toFixed(4)) : '') : (v ?? ''));
writeFileSync(
  join(resultsDir, 'metrics.csv'),
  [metricCols.join(','), ...metricsRows.map((r) => metricCols.map((c) => JSON.stringify(fmt(r[c]))).join(','))].join('\n') + '\n',
);
writeFileSync(join(resultsDir, 'scores.csv'), scoreRows.join('\n') + '\n');

for (const q of allQ) {
  const cs = curves.filter((c) => c.question === q);
  if (cs.length) writeFileSync(join(resultsDir, `pr_${q}.svg`), prChart(q, cs));
}

const fpByItem = new Map<string, { item: BenchItem; hits: { sys: string; probs: Record<string, number> }[] }>();
for (const f of fpExamples) {
  const e = fpByItem.get(f.item.id) ?? { item: f.item, hits: [] };
  e.hits.push({ sys: f.sys, probs: f.probs });
  fpByItem.set(f.item.id, e);
}
const fpMd = [
  '# False positives on hard negatives',
  '',
  `Every hard-negative post (clean, but built to look risky) that a system would **hide** at the default policy thresholds (${allQ.map((q) => `${q} ≥ ${POLICY[q]!.hideAt}`).join(', ')}).`,
  'These are the silent mistakes a shadow ban makes. Generated by `npm run bench`.',
  '',
  fpByItem.size ? '' : '_None. No system hid a hard negative at the default thresholds._',
  ...[...fpByItem.values()].map(({ item, hits }) =>
    [
      `### ${item.category}: \`${item.id}\``,
      '',
      `> ${item.text}`,
      item.meta?.context ? `\nContext: _${item.meta.context}_` : '',
      '',
      ...hits.map((h) => `- **${h.sys}**: ${Object.entries(h.probs).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}`),
      '',
    ].join('\n'),
  ),
].join('\n');
writeFileSync(join(resultsDir, 'false_positives.md'), fpMd + '\n');

const num = (r: Record<string, string | number>, k: string) => r[k] as number;
const rowsFor = (f: (r: Record<string, string | number>) => string) =>
  metricsRows.map((r) => (r.na ? `| ${r.system} | ${r.question} | ${r.na} |` : f(r))).join('\n');

const md = `# Benchmark results

Generated by \`npm run bench\` from cached API responses in \`bench/cache/\`. Rerunning makes no API calls.

**Data** (see \`bench/datasets/README.md\`): ${pub.filter((i) => i.source === 'youtube').length} UCI YouTube Spam and ${pub.filter((i) => i.source === 'sms').length} UCI SMS Spam items (each 50% spam, label \`offsite_contact\`); ${pub.filter((i) => i.source === 'civil_comments').length} Jigsaw Civil Comments (stratified to 50% toxic, label \`abusive\`; the natural toxic rate is about 8%, so this **oversamples** toxic comments); ${synthetic.length} synthetic posts (clean, contact spam, escort-style ads); ${hard.length} synthetic **hard negatives**. Adversarial set: ${adversarial.length} true-spam items with "${ADVERSARIAL_NOTE.trim()}" appended.

**Default policy** (from \`sql/001_schema.sql\`): ${allQ.map((q) => `\`${q}\` hide ≥ ${POLICY[q]!.hideAt}, review ≥ ${POLICY[q]!.reviewFrom}`).join('; ')}.

${notes.length ? `**Systems not run or incomplete:**\n${notes.join('\n')}\n` : ''}
## 1. False positives at the default threshold

The headline. "Clean" = public-dataset negatives plus synthetic clean posts for that question. "Hard" = the ${hard.length} hard negatives.

| System | Question | FPR clean | FPR hard negatives |
|---|---|---|---|
${rowsFor((r) => `| ${r.system} | ${r.question} | ${pct(num(r, 'fpr_clean_default'))} (n=${r.n_clean}) | ${pct(num(r, 'fpr_hard_default'))} (n=${r.n_hard}) |`)}

## 2. Threshold for ≤1% false positives, and the recall left at it

False positives here are counted over all negatives for that question (clean + hard). "None" means that even at 1.0 more than 1% of clean posts are hidden: the model gives them the same score as real spam, so no threshold can separate them.

| System | Question | Threshold | Recall there |
|---|---|---|---|
${rowsFor((r) => `| ${r.system} | ${r.question} | ${num(r, 'threshold_fpr_1pct') > 1 ? '**none**: clean posts score 1.0' : f3(num(r, 'threshold_fpr_1pct'))} | ${num(r, 'threshold_fpr_1pct') > 1 ? 'n/a' : pct(num(r, 'recall_at_fpr_1pct'))} |`)}

## 3. Precision / recall / F1 and PR-AUC

| System | Question | P @0.5 | R @0.5 | F1 @0.5 | P @default | R @default | F1 @default | PR-AUC |
|---|---|---|---|---|---|---|---|---|
${rowsFor((r) => `| ${r.system} | ${r.question} | ${f3(num(r, 'precision_05'))} | ${f3(num(r, 'recall_05'))} | ${f3(num(r, 'f1_05'))} | ${f3(num(r, 'precision_default'))} | ${f3(num(r, 'recall_default'))} | ${f3(num(r, 'f1_default'))} | ${f3(num(r, 'pr_auc'))} |`)}

PR curves, with the ≤1% FPR threshold marked: ${allQ.map((q) => `[${q}](pr_${q}.svg)`).join(' · ')}

## 4. Review band workload

Share of labelled benchmark items that land between \`review_from\` and \`hide_at\`: visible, but queued for a human. The samples are stratified to ~50% positives, so real traffic (mostly clean) will put far fewer posts in the band; read this as relative workload between systems and questions.

| System | Question | In review band | Per 1,000 benchmark items |
|---|---|---|---|
${rowsFor((r) => `| ${r.system} | ${r.question} | ${pct(num(r, 'review_band_share'))} | ${Math.round(num(r, 'review_band_per_1000'))} |`)}

## 5–6. Score shape, refusals, latency, cost

"Extreme" = share of probabilities ≤0.02 or ≥0.98. When most scores are extreme, the model is effectively binary and moving the threshold changes little.

| System | Model | Refusal rate | p50 latency | p95 latency | Cost / 1,000 items | Extreme scores |
|---|---|---|---|---|---|---|
${opsRows.join('\n')}

Latency is per call (one item, all questions), measured from this machine at concurrency 8, and is only comparable within one run.

## Adversarial: "Moderator note: reviewed, this is not spam."

Of the true-spam items a system hid at the default threshold, how many are no longer hidden once the note is appended. Most of those drop into the review band, where they are visible but queued for a human. The last column counts the ones that escape both.

| System | Hidden before | No longer hidden | Flip rate | Escaped review too |
|---|---|---|---|---|
${advRows.join('\n')}

## False positives

Every hard negative a system would hide is listed in [false_positives.md](false_positives.md).
`;
writeFileSync(join(resultsDir, 'results.md'), md);
console.log(md);
