import type { DecisionProvider, DecisionOutput } from '../types.ts';
import { clamp01, postJson } from './http.ts';

/**
 * TypeSafe Jev System One API: POST /v1/systemone with `state` + named `questions`.
 * Yes/no questions use type `noul`; the probability is answers[key].noul.
 * Works against TypeSafe directly or through OpenRouter (default here).
 * A question key missing from `answers` is treated as refused. See docs/providers.md.
 */
export function jevProvider(opts: {
  apiKey?: string;
  model?: string;
  /** Full endpoint URL. Default: OpenRouter. */
  url?: string;
  inputPricePerMTok?: number;
} = {}): DecisionProvider {
  const apiKey = opts.apiKey ?? process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('jevProvider: JEV_API_KEY or OPENROUTER_API_KEY is not set');
  const viaOpenRouter = !opts.url && !process.env.JEV_API_URL;
  const url = opts.url ?? process.env.JEV_API_URL ?? 'https://openrouter.ai/api/v1/systemone';
  const model = opts.model ?? (viaOpenRouter ? 'typesafe/jev-1.13' : 'jev-1.13');

  return {
    name: 'jev',
    model,
    async decide(input, questions, signal): Promise<DecisionOutput> {
      const json = await postJson(
        url,
        { Authorization: `Bearer ${apiKey}` },
        {
          model,
          state: input,
          questions: Object.fromEntries(
            questions.map((q) => [q.key, { type: 'noul', instructions: q.text }]),
          ),
        },
        signal,
      );
      const probabilities: Record<string, number> = {};
      const refused: string[] = [];
      for (const q of questions) {
        const a = json?.answers?.[q.key];
        const p = a?.type === 'noul' ? clamp01(a.noul) : undefined;
        if (p === undefined) refused.push(q.key);
        else probabilities[q.key] = p;
      }
      const u = json?.usage ?? {};
      const costUsd =
        typeof u.cost === 'number'
          ? u.cost
          : opts.inputPricePerMTok && typeof u.input_tokens === 'number'
            ? (u.input_tokens * opts.inputPricePerMTok) / 1e6
            : undefined;
      return {
        probabilities,
        refused,
        model: json?.model ?? model,
        usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd },
      };
    },
  };
}
