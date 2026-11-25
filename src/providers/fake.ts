import type { DecisionProvider, DecisionOutput } from '../types.ts';

/**
 * Deterministic keyword scorer. For tests and the demo when no API key is set.
 * It is deliberately crude: contact details alone land in the review band,
 * contact details plus promotional language cross the hide threshold.
 * Unknown questions get 0.01.
 */
const CONTACT = [
  /\b\d{3}[-.\s]?\d{4}\b/, // 555-0100
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email
  /https?:\/\/|www\.|\b\w+\.(com|net|io|ly)\b/i, // link
  /(^|\s)@\w{3,}/, // handle
  /\b(whatsapp|telegram|snapchat|kik|signal)\b/i,
];
const PROMO = /\b(earn|cash|cheap|free|discount|deal|\$\$+|dm me|text me|click|crypto|followers|promo|limited offer)\b|\$\$/i;
const ABUSE = /\b(idiot|moron|stupid|loser|trash|scum|kill yourself|hate you|worthless)\b/i;
const ADULT = /\b(escort|hookup|hook up|sugar daddy|incall|outcall|adult fun|discreet fun)\b/i;

export function fakeProvider(opts: { delayMs?: number } = {}): DecisionProvider {
  return {
    name: 'fake',
    model: 'keywords-v1',
    async decide(input, questions, signal): Promise<DecisionOutput> {
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason);
          });
        });
      }
      const text = input.post.body;
      const contact = CONTACT.some((r) => r.test(text));
      const scores: Record<string, number> = {
        abusive: ABUSE.test(text) ? 0.97 : 0.02,
        offsite_contact: contact ? (PROMO.test(text) ? 0.97 : 0.62) : PROMO.test(text) ? 0.3 : 0.02,
        adult_solicitation: ADULT.test(text) ? 0.97 : 0.01,
      };
      const probabilities: Record<string, number> = {};
      for (const q of questions) probabilities[q.key] = scores[q.key] ?? 0.01;
      return { probabilities, refused: [], model: 'keywords-v1', usage: { costUsd: 0 } };
    },
  };
}
