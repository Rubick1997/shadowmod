/** A yes/no question asked of each piece of content. */
export interface Question {
  /** Stable key, stored in shadowmod.check_score.question and shadowmod.policy.question. */
  key: string;
  /** One sentence that refers to the structured input fields (post.body, post.context). */
  text: string;
}

/** The structured input every provider receives. Questions refer to these fields by name. */
export interface DecisionInput {
  post: { body: string; context?: string };
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Cost in USD, if the provider returns it or it can be computed from tokens. */
  costUsd?: number;
}

/** What a provider returns for one item. */
export interface DecisionOutput {
  /** Probability per answered question key, 0..1. */
  probabilities: Record<string, number>;
  /** Question keys the model refused to answer. They get no score row. */
  refused: string[];
  model: string;
  usage?: Usage;
}

/** The one interface the rest of the code knows about. */
export interface DecisionProvider {
  name: string;
  model: string;
  decide(input: DecisionInput, questions: Question[], signal: AbortSignal): Promise<DecisionOutput>;
}

/** A piece of user content to screen. */
export interface ScreenItem {
  /** Which table and column the text comes from (a row in shadowmod.target). */
  target: { table: string; column: string };
  /** Primary key of the content row, as text (int or uuid). */
  rowKey: string;
  authorKey?: string;
  body: string;
  /** Optional context, e.g. the thread title. Reduces false positives. */
  context?: string;
}

export type ScreenStatus = 'scored' | 'refused' | 'error';

export interface ScreenResult {
  item: ScreenItem;
  status: ScreenStatus;
  probabilities: Record<string, number>;
  refused: string[];
  contentHash: string;
  provider: string;
  model: string;
  latencyMs: number;
  usage?: Usage;
  error?: { message: string; name?: string; status?: number };
}
