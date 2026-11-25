import type { Question } from './types.ts';

/**
 * Default questions. Edit freely or add your own: each one needs a row in
 * shadowmod.policy before it can hide anything.
 *
 * Each question is one sentence that names a field of the structured input
 * instead of pasting the text into the prompt. post.context (e.g. a thread
 * title) is optional and helps the model avoid false positives.
 */
export const defaultQuestions: Question[] = [
  {
    key: 'abusive',
    text: 'Does `post.body` attack, demean or threaten a person or group, or use sexually explicit or hateful language?',
  },
  {
    key: 'offsite_contact',
    text: 'Does `post.body` try to move readers off this site or advertise something, for example with a phone number, email, link, messaging app or social media handle?',
  },
  {
    key: 'adult_solicitation',
    text: 'Does `post.body` solicit or advertise paid sexual services, escorts or hookups?',
  },
];
