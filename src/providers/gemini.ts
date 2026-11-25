import type { DecisionProvider, DecisionOutput } from '../types.ts';
import { ProviderError, clamp01, postJson } from './http.ts';

/** error.code values for a whole-request input block (AI Studio Decisions API docs). */
const SAFETY_CODES = new Set(['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked']);

/**
 * Gemini Decisions API: POST v1beta/decisions, model gemini-decision-1.
 * Same `noul` question type as Jev, keyed map of questions, answers[key].noul.
 * A safety block is an HTTP 400 with one of SAFETY_CODES in error.code; we map
 * it to "every question refused" rather than an error, so it never hides anything.
 * Note: probabilities are clamped by the API to 0.01..0.99. See docs/providers.md.
 */
export function geminiProvider(opts: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  inputPricePerMTok?: number;
} = {}): DecisionProvider {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('geminiProvider: GEMINI_API_KEY is not set');
  const model = opts.model ?? 'gemini-decision-1';
  const url = `${opts.baseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/decisions`;
  const price = opts.inputPricePerMTok ?? 0.1;

  return {
    name: 'gemini',
    model,
    async decide(input, questions, signal): Promise<DecisionOutput> {
      let json: any;
      try {
        json = await postJson(
          url,
          { 'x-goog-api-key': apiKey },
          {
            model,
            input: [{ type: 'text', text: JSON.stringify(input) }],
            questions: Object.fromEntries(
              questions.map((q) => [q.key, { type: 'noul', instructions: q.text }]),
            ),
          },
          signal,
        );
      } catch (e) {
        if (e instanceof ProviderError && e.status === 400 && SAFETY_CODES.has((e.body as any)?.error?.code)) {
          return { probabilities: {}, refused: questions.map((q) => q.key), model };
        }
        throw e;
      }
      const probabilities: Record<string, number> = {};
      const refused: string[] = [];
      for (const q of questions) {
        const a = json?.answers?.[q.key];
        const p = a?.type === 'noul' ? clamp01(a.noul) : undefined;
        if (p === undefined) refused.push(q.key);
        else probabilities[q.key] = p;
      }
      const inputTokens = json?.usage?.total_input_tokens;
      return {
        probabilities,
        refused,
        model,
        usage: {
          inputTokens,
          outputTokens: json?.usage?.total_output_tokens,
          costUsd: typeof inputTokens === 'number' ? (inputTokens * price) / 1e6 : undefined,
        },
      };
    },
  };
}
