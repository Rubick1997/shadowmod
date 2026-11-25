import { createHash } from 'node:crypto';
import type { DecisionProvider, Question, ScreenItem, ScreenResult } from './types.ts';
import { defaultQuestions } from './questions.ts';

export interface ScreenOptions {
  provider: DecisionProvider;
  questions?: Question[];
  /** Deadline for the whole batch. On timeout screen() returns null and nothing should be recorded. */
  timeoutMs?: number;
  /** Max provider calls in flight. */
  concurrency?: number;
}

/** Hash of exactly what the model sees. Re-screen only when this changes. */
export function contentHash(item: Pick<ScreenItem, 'body' | 'context'>): string {
  return createHash('sha256')
    .update(item.body)
    .update('\u0000')
    .update(item.context ?? '')
    .digest('hex');
}

const TIMEOUT = Symbol('timeout');

/**
 * Score items with a decision model. Returns one result per item, in order:
 *  - `scored`  at least one question answered (refused questions are simply missing)
 *  - `refused` every question refused
 *  - `error`   the call for this item failed; other items are unaffected
 * If the whole batch misses its deadline, returns null. The caller records
 * nothing and the content stays visible (fail open).
 */
export async function screen(items: ScreenItem[], opts: ScreenOptions): Promise<ScreenResult[] | null> {
  const { provider, questions = defaultQuestions, timeoutMs = 5000, concurrency = 8 } = opts;
  const controller = new AbortController();
  const results: ScreenResult[] = new Array(items.length);
  let next = 0;

  const one = async (item: ScreenItem): Promise<ScreenResult> => {
    const started = performance.now();
    const base = {
      item,
      contentHash: contentHash(item),
      provider: provider.name,
      model: provider.model,
    };
    try {
      const out = await provider.decide(
        { post: item.context ? { body: item.body, context: item.context } : { body: item.body } },
        questions,
        controller.signal,
      );
      const answered = Object.keys(out.probabilities).length;
      return {
        ...base,
        model: out.model ?? provider.model,
        status: answered > 0 ? 'scored' : 'refused',
        probabilities: out.probabilities,
        refused: out.refused,
        latencyMs: Math.round(performance.now() - started),
        usage: out.usage,
      };
    } catch (e: any) {
      return {
        ...base,
        status: 'error',
        probabilities: {},
        refused: [],
        latencyMs: Math.round(performance.now() - started),
        error: { message: String(e?.message ?? e), name: e?.name, status: e?.status },
      };
    }
  };

  const worker = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const i = next++;
      results[i] = await one(items[i]!);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  const work = Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const outcome = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (outcome === TIMEOUT) {
    controller.abort(new Error('shadowmod: screen() timed out'));
    work.catch(() => {});
    return null;
  }
  return results;
}
