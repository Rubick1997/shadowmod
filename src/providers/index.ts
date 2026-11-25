import type { DecisionProvider } from '../types.ts';
import { fakeProvider } from './fake.ts';
import { geminiProvider } from './gemini.ts';
import { jevProvider } from './jev.ts';
import { openaiProvider } from './openai.ts';

export { fakeProvider, geminiProvider, jevProvider, openaiProvider };

/** Pick a provider by name, or from SHADOWMOD_PROVIDER. Defaults to the fake provider. */
export function providerFromEnv(name = process.env.SHADOWMOD_PROVIDER ?? 'fake'): DecisionProvider {
  switch (name) {
    case 'openai':
      return openaiProvider();
    case 'jev':
      return jevProvider();
    case 'gemini':
      return geminiProvider();
    case 'fake':
      return fakeProvider();
    default:
      throw new Error(`Unknown SHADOWMOD_PROVIDER ${name}`);
  }
}
