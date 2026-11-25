import type { DecisionProvider, DecisionOutput } from '../types.ts';
import { clamp01, postJson } from './http.ts';

/**
 * OpenAI Decisions API: POST /v1/decisions, model gpt-6-luna.
 * Questions are an ordered array of `predicate` questions; the `name` is echoed back.
 * A refused question comes back as { type: "refusal", name } and the rest still count.
 * See docs/providers.md.
 */
export function openaiProvider(opts: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** USD per 1M input tokens, for cost reporting. Output tokens are not billed. */
  inputPricePerMTok?: number;
} = {}): DecisionProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('openaiProvider: OPENAI_API_KEY is not set');
  const model = opts.model ?? 'gpt-6-luna';
  const url = `${opts.baseUrl ?? 'https://api.openai.com'}/v1/decisions`;
  const price = opts.inputPricePerMTok ?? 0.1;

  return {
    name: 'openai',
    model,
    async decide(input, questions, signal): Promise<DecisionOutput> {
      const json = await postJson(
        url,
        { Authorization: `Bearer ${apiKey}` },
        {
          model,
          input: [{ role: 'user', content: [{ type: 'input_json', data: input }] }],
          questions: questions.map((q) => ({ type: 'predicate', name: q.key, instructions: q.text })),
        },
        signal,
      );
      const probabilities: Record<string, number> = {};
      const refused: string[] = [];
      const answers: any[] = Array.isArray(json?.answers) ? json.answers : [];
      questions.forEach((q, i) => {
        // Answers come back in question order and echo the name; prefer the name.
        const a = answers.find((x) => x?.name === q.key) ?? answers[i];
        const p = a?.type === 'predicate' ? clamp01(a.probability) : undefined;
        if (p === undefined) refused.push(q.key);
        else probabilities[q.key] = p;
      });
      const inputTokens = json?.usage?.input_tokens;
      return {
        probabilities,
        refused,
        model: json?.model ?? model,
        usage: {
          inputTokens,
          outputTokens: json?.usage?.output_tokens,
          costUsd: typeof inputTokens === 'number' ? (inputTokens * price) / 1e6 : undefined,
        },
      };
    },
  };
}
