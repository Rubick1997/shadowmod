# Benchmark datasets

| File | Source | Items | Labels |
|---|---|---|---|
| `public/youtube.jsonl` | [UCI YouTube Spam Collection](https://archive.ics.uci.edu/dataset/380/youtube+spam+collection) (CC BY 4.0) | 200 spam + 200 ham, seeded sample | `offsite_contact` (spam = 1) |
| `public/sms.jsonl` | [UCI SMS Spam Collection](https://archive.ics.uci.edu/dataset/228/sms+spam+collection) (CC BY 4.0) | 200 spam + 200 ham, seeded sample | `offsite_contact` (spam = 1) |
| `public/civil_comments.jsonl` | [Jigsaw Civil Comments](https://huggingface.co/datasets/google/civil_comments), test split (CC0) | 500 toxic + 500 non-toxic | `abusive` (toxicity ≥ 0.5 = 1) |
| `synthetic.jsonl` | **Synthetic**, `make-synthetic.ts` | 100 clean, 100 contact spam, 100 escort-style ads | all three questions |
| `hard_negatives.jsonl` | **Synthetic**, `make-synthetic.ts` | 200 clean posts built to look risky | all three = 0 |

**Oversampling.** About 8% of Civil Comments test comments are toxic. The sample is stratified to 50% toxic, and the spam sets to 50% spam. Precision and review-band counts are therefore higher than they would be on real traffic. False-positive *rates* are unaffected by the class balance.

**Label mapping.** The questions don't line up exactly with the datasets' labels. UCI "spam" is mostly advertising or self-promotion, which `offsite_contact` covers ("…or advertise something"). Civil Comments "toxic" covers rude and disrespectful comments, which is broader than `abusive`. Some of the measured false negatives are this mismatch rather than model error.

**Synthetic data.** `synthetic.jsonl` and `hard_negatives.jsonl` are written by hand-made templates with a seeded RNG, and regenerate identically with `npm run bench:synthetic`. Phone numbers use the 555-01xx fiction range. Names, handles, sites and places are invented. Hard-negative categories: `legit_contact`, `quoted_insult`, `sarcasm`, `reclaimed_slang`, `medical_sex_ed`, `civil_disagreement`. Some hard negatives carry a `context` (thread title) to test whether context reduces false positives.

The hard-negative labels are a judgement call. "Tickets at the door or call the venue" mentions an event and a phone number. We label it clean because a community guestbook wants it, and a model that hides it is making exactly the silent mistake this repo is about.

**Regenerating.** `npm run bench:download` re-downloads the public data into `raw/` (gitignored) and rewrites the samples deterministically.
