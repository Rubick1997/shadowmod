/**
 * Writes two SYNTHETIC datasets (hand-written templates, seeded, reproducible):
 *
 *  synthetic.jsonl       ~300 posts: clean, contact-info spam (incl. obfuscated
 *                        numbers), and non-explicit escort-style ads.
 *  hard_negatives.jsonl  ~200 clean posts built to look risky. Every label is 0.
 *                        This is the false-positive set.
 *
 * All phone numbers use the 555-01xx fiction range; all names, handles, sites
 * and places are invented. Nothing here is real user content.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pick, rng, type BenchItem } from '../lib.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const r = rng(42);

const names = ['Maya', 'Tom', 'Priya', 'Jonas', 'Aisha', 'Leo', 'Sofia', 'Ken', 'Rosa', 'Dev', 'Hannah', 'Omar'];
const places = ['the library', 'Elm Street hall', 'the community centre', 'Riverside park', 'the old mill', 'St. Brigid hall'];
const digits = () => `555-01${String(Math.floor(r() * 100)).padStart(2, '0')}`;
const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const spelled = (n: string) => n.replace(/\D/g, '').split('').map((d) => words[+d]).join(' ');
const spaced = (n: string) => n.replace(/\D/g, '').split('').join(' ');
const mixed = (n: string) => n.replace(/\D/g, '').split('').map((d, i) => (i % 2 ? words[+d] : d)).join(' ');
const anyNumber = () => {
  const n = digits();
  return pick([n, n, spelled(n), spaced(n), mixed(n), n.replace('-', '.'), `(${n.slice(0, 3)}) ${n.slice(4)}`], r);
};
const handle = () => `@${pick(['quickcash', 'glowdeals', 'luxe_nights', 'promo_kim', 'free_followers', 'bizopp'], r)}${Math.floor(r() * 90 + 10)}`;
const site = () => `${pick(['bestdealz', 'easy-income', 'followboost', 'cheapmeds', 'winbig'], r)}${pick(['.com', '.net', '.io', ' dot com'], r)}`;
const app = () => pick(['WhatsApp', 'Telegram', 'Snapchat', 'Kik', 'Signal'], r);

function many(n: number, f: () => string): string[] {
  const out = new Set<string>();
  for (let i = 0; out.size < n && i < n * 50; i++) out.add(f());
  return [...out];
}

// ----- synthetic.jsonl --------------------------------------------------------

const clean = many(100, () =>
  pick(
    [
      () => `Thanks ${pick(names, r)} for organising the picnic at ${pick(places, r)}, the kids loved it.`,
      () => `Does anyone know if ${pick(places, r)} is open on Sunday mornings?`,
      () => `Great write-up. I tried the ${pick(['sourdough', 'lentil soup', 'banana bread', 'chili'], r)} recipe and it worked first time.`,
      () => `Signing the guestbook from ${pick(['Lisbon', 'Leeds', 'Osaka', 'Denver', 'Nairobi'], r)}. Lovely site, keep it up!`,
      () => `I disagree a little about ${pick(['the parking plan', 'the new schedule', 'the route change'], r)}, but I see why you chose it.`,
      () => `Happy birthday ${pick(names, r)}! Hope the year is kind to you.`,
      () => `The ${pick(['choir', 'chess club', 'book group', 'running club'], r)} meets again next ${pick(['Tuesday', 'Thursday', 'Saturday'], r)}. New faces welcome.`,
      () => `Sorry I missed the meeting, ${pick(names, r)}. Could someone post the notes here?`,
    ],
    r,
  )(),
).map((text, i): BenchItem => ({ id: `syn:clean:${i}`, source: 'synthetic', category: 'clean', text, labels: { abusive: 0, offsite_contact: 0, adult_solicitation: 0 } }));

const contactSpam = many(100, () =>
  pick(
    [
      () => `Make $500 a day from home!! Text ${anyNumber()} now`,
      () => `Want 10k followers fast? DM ${handle()} on ${app()}`,
      () => `Best prices on watches, visit ${site()} before the sale ends`,
      () => `I made so much money with crypto signals, add me on ${app()} ${anyNumber()}`,
      () => `Need a loan today? No credit check. Call ${anyNumber()}`,
      () => `Great post! Btw check my page ${site()} for free gift cards`,
      () => `Message me on ${app()}: ${anyNumber()} for wholesale deals`,
      () => `Work from home opportunity, reply to ${pick(['jobs', 'hiring', 'cashnow'], r)}${Math.floor(r() * 90 + 10)} at gmail dot com`,
      () => `Cheap meds without prescription. Order at ${site()} or text ${anyNumber()}`,
      () => `Follow ${handle()} for daily giveaways!!!`,
    ],
    r,
  )(),
).map((text, i): BenchItem => ({ id: `syn:contact:${i}`, source: 'synthetic', category: 'contact_spam', text, labels: { abusive: 0, offsite_contact: 1, adult_solicitation: 0 } }));

const escortAds = many(100, () =>
  pick(
    [
      () => `Lonely tonight? Discreet company available, incall or outcall. ${app()} ${anyNumber()}`,
      () => `New in town, sweet and fun. Generous gentlemen only, text ${anyNumber()}`,
      () => `Looking for a sugar daddy, serious offers only. Snap ${handle()}`,
      () => `VIP companions for dinner and more, ${pick(['roses', 'donations'], r)} required. Book at ${site()}`,
      () => `Hookups in your area tonight, no strings. Visit ${site()}`,
      () => `Relaxing massage with happy ending, call ${anyNumber()} for rates`,
      () => `Young and playful, available 24/7 for private meetings. Message ${handle()}`,
    ],
    r,
  )(),
).map((text, i): BenchItem => ({ id: `syn:adult:${i}`, source: 'synthetic', category: 'adult_ad', text, labels: { abusive: 0, offsite_contact: 1, adult_solicitation: 1 } }));

// ----- hard_negatives.jsonl ---------------------------------------------------

const legitContact = [
  () => `Lost dog near ${pick(places, r)}: brown terrier, answers to Biscuit. If you see him please call ${pick(names, r)} on ${digits()}.`,
  () => `For the charity night, tickets are at the door or call the venue at ${digits()}.`,
  () => `The pharmacy on Main St changed its hours, their number is ${digits()} if you need to check.`,
  () => `Minutes from last week's meeting are on the council site: https://example.org/minutes`,
  () => `The bug I mentioned is tracked here: https://github.com/example/project/issues/${Math.floor(r() * 900 + 100)}`,
  () => `If you are struggling, the crisis line is ${digits()} and it is free and confidential.`,
  () => `Volunteers for the clean-up can email the coordinator at cleanup@example.org.`,
  () => `My shop's hours changed for the holidays, it's on the sign out front and at example.com/hours.`,
  () => `Found a wallet at ${pick(places, r)}. Ring the front desk at ${digits()} to describe it and pick it up.`,
  () => `The recipe is from a book I love, it's at the library under 641.5 if anyone wants it.`,
  () => `I'm ${pick(['@maya_reads', '@tomcooks', '@priya.draws'], r)} on the forum too if you want to see the rest of the photos.`,
  () => `Reminder: the food bank needs volunteers Saturday, sign-up sheet is pinned in the thread.`,
];

const quotedInsult = [
  () => `Someone called my neighbour a "worthless idiot" at the meeting. That's not okay and I said so.`,
  () => `The comment above calling ${pick(names, r)} a "loser" breaks the rules, please don't talk to people like that.`,
  () => `My kid came home saying a classmate told him "nobody likes you, go kill yourself". We've talked to the school.`,
  () => `Reporting this: the troll in the other thread keeps writing "scum" under every post. Mods, please look.`,
  () => `In the book the villain sneers "you're nothing but trash", and it's the moment you start rooting for the hero.`,
  () => `People used to shout "moron" at my brother because of his stutter. Words stick, be kind.`,
  () => `The article quotes the slur the attacker used, which I think was necessary to show how ugly it was.`,
  () => `"Stupid" is a word my teacher banned in class and honestly I think she was right.`,
  () => `Calling people "trash" for liking a different team is how threads like this go downhill.`,
  () => `A stranger yelled "I hate you people" at us at the bus stop. Still shaking a bit, but we're fine.`,
];

const sarcasm = [
  () => `Oh great, another Monday. Just what I needed.`,
  () => `Wow, the bus was only 40 minutes late today, truly a miracle of modern engineering.`,
  () => `Yes, because what this town really needs is a fourth parking garage.`,
  () => `Love how the "quick five minute" meeting took two hours. Brilliant.`,
  () => `Sure, I'll just learn to play the violin by Friday, no problem at all.`,
  () => `Nothing says summer like the neighbour's leaf blower at 7am.`,
  () => `My cat knocked the plant over again. Truly a criminal mastermind.`,
  () => `Ten out of ten, would get lost in the parking lot again.`,
  () => `Oh sure, the weather app said sunny. My soaked socks disagree.`,
  () => `Can't wait to pay more for less, my favourite hobby.`,
];

const reclaimed = [
  () => `As a queer woman I'm so happy the pride picnic is back at ${pick(places, r)}.`,
  () => `My crip friends and I are making a list of step-free cafes in town.`,
  () => `Yo that skate trick was sick, my dude, absolutely filthy.`,
  () => `We fat folks at the gym deserve equipment that fits us too.`,
  () => `Me and my old ladies from book club are going to that concert, wish us luck.`,
  () => `This song slaps so hard, the bass is nasty in the best way.`,
  () => `Shout out to all the nerds in the robotics club, you killed it at the regional.`,
  () => `As a deaf person, captions on the community videos would help a lot.`,
  () => `My Black-owned bakery list is updated, three new spots this month.`,
  () => `Us autistic folks appreciate the quiet hour at the supermarket, thank you.`,
];

const medical = [
  () => `Reminder that free STI testing is available at the clinic on Thursdays, no appointment needed.`,
  () => `Our sex-ed class used the correct words for anatomy and honestly the kids handled it better than the parents.`,
  () => `After my vasectomy I was back at work in two days. Happy to answer questions about recovery.`,
  () => `Breast self-exams take two minutes. My friend caught her lump early because of one.`,
  () => `Talking to teens about consent: what worked for us was being direct and not embarrassed.`,
  () => `The pharmacist explained emergency contraception clearly and without judgement, which I appreciated.`,
  () => `Menopause hot flashes are no joke. Anyone tried the cooling pillows?`,
  () => `Erectile dysfunction can be an early sign of heart disease, worth mentioning to your GP.`,
  () => `The midwife said bleeding after birth is normal for a few weeks but call if it gets heavy.`,
  () => `Our support group for survivors of sexual assault meets monthly; it's confidential and free.`,
];

const disagreement = [
  () => `I strongly disagree with the council's decision. It ignores everyone who actually lives on that street.`,
  () => `With respect, ${pick(names, r)}, your numbers are wrong. The survey had 40 replies, not 400.`,
  () => `This policy is a mistake and I'll be voting against it, but thanks for laying out the reasoning.`,
  () => `I think the new schedule is badly thought out and unfair to night-shift workers.`,
  () => `Frankly the plan is a waste of money, and I'd say the same to the mayor's face.`,
  () => `You're entitled to your opinion but I think it's completely wrong, and here's why.`,
  () => `The referee's call was terrible. I'm still annoyed, but fair play to the other team.`,
  () => `I'm furious about the price rise. It hits pensioners hardest and nobody asked us.`,
  () => `Honestly this review is unfair to the chef, the food was good and the service was slow, that's all.`,
  () => `No, I don't agree, and repeating it louder doesn't make it more true.`,
];

const categories: Array<[string, Array<() => string>, number]> = [
  ['legit_contact', legitContact, 40],
  ['quoted_insult', quotedInsult, 32],
  ['sarcasm', sarcasm, 32],
  ['reclaimed_slang', reclaimed, 32],
  ['medical_sex_ed', medical, 32],
  ['civil_disagreement', disagreement, 32],
];

const contexts = ['Community board', 'Guestbook', 'Town news: comments', 'Neighbourhood forum', ''];
const hard: BenchItem[] = [];
for (const [category, templates, n] of categories) {
  // Each template appears at least once; the rest vary slots and context.
  const texts = new Set<string>(templates.map((t) => t()));
  for (let i = 0; texts.size < n && i < n * 50; i++) {
    const base = pick(templates, r)();
    texts.add(pick([base, base, `${base} ${pick(['Thoughts?', 'Just my two cents.', 'Anyway.', '🙂'], r)}`], r));
  }
  [...texts].slice(0, n).forEach((text, i) =>
    hard.push({
      id: `hard:${category}:${i}`,
      source: 'hard_negative',
      category,
      text,
      labels: { abusive: 0, offsite_contact: 0, adult_solicitation: 0 },
      meta: { context: pick(contexts, r) || undefined },
    }),
  );
}

const write = (name: string, items: BenchItem[]) => {
  writeFileSync(`${here}${name}.jsonl`, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  console.log(`${name}: ${items.length}`);
};
write('synthetic', [...clean, ...contactSpam, ...escortAds]);
write('hard_negatives', hard);
