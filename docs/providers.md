# Decision-model providers: what the APIs actually do

Checked 2026-11-24 against current docs, plus live calls where a key was available. These APIs are new and change often. Re-check before you rely on a detail.

shadowmod only uses **yes/no questions** and needs, from every provider: a probability per question, a way to tell "refused" apart from "answered", and token usage. Everything below is mapped into one internal shape (`DecisionOutput` in `src/types.ts`):

```ts
{ probabilities: { [questionKey]: number }, refused: string[], model: string, usage?: { inputTokens, outputTokens, costUsd } }
```

## OpenAI Decisions API: `POST /v1/decisions`

- **Model:** `gpt-6-luna` is the only supported model.
- **Request:** `{ model, input, questions }`. `input` is a string or an array of message items; message content can carry `input_text`, `input_image` or `input_json` parts (`input_json` only in the `user` role). We send the structured `{ post: { body, context } }` as one `input_json` part, so questions can refer to `post.body` by name.
- **Questions:** an **ordered array**, 1–400 per request (it was 200 during the beta). Each has an optional `name`, which is echoed back. Types:
  - `predicate`: `{ type, name, instructions }` → answer `{ type: "predicate", name, probability }`. **We use this one.**
  - `choice`: `choices: [{ value, description }]`, 2–255 → `{ choice, confidence, probabilities: [{ value, probability }] }`
  - `score`: `levels: [{ label, description }]`, 2–10 → `{ score, confidence, probabilities: [...] }`
- **Refusal:** per question. That question's answer is `{ type: "refusal", name }` and the other questions are still answered. There is no documented whole-request refusal.
- **Usage:** `input_tokens` (includes cached), `input_tokens_details.{cached_tokens, cache_write_tokens}`, `output_tokens` (not billed), `total_tokens`. Price: $0.10 per 1M uncached input tokens.
- **Errors:** the docs give no error body shape or status codes. We treat any non-2xx as an `error` check.
- **Verified live** on the full benchmark (2,900 calls, no refusals, no errors). An invalid key returns HTTP 401, and the benchmark skips the system when it sees one.
- **Observed:** scores are strongly binary (84% are ≤0.02 or ≥0.98), and many are exactly `1.0`, including on clean posts that contain a phone number or link.

## TypeSafe Jev: `POST /v1/systemone`

- **Model:** `jev-1.13` directly, or `typesafe/jev-1.13` via OpenRouter (`https://openrouter.ai/api/v1/systemone`, OpenRouter key as Bearer). Gateways also host it: DigitalOcean (`typesafe-jev-1.13.0`) and AIML API (on its own `/v1/decisions` route).
- **Request:** `{ model, state, questions }`. `state` is a string, a JSON object, or an array of texts. We send `{ post: { body, context } }`.
- **Questions:** a **map** of key → question. There is no documented maximum; DigitalOcean caps a request at 64K tokens. Types:
  - `noul` (yes/no): `{ type: "noul", instructions, criteria?: { true, false } }` → `answers[key] = { type: "noul", noul: <P(yes)> }`. **We use this one.**
  - `choice` (criteria: option map, 1–255 options), `score` (criteria: 2–10 levels), `box` (experimental, images only).
- **Refusal:** none is documented. Every key is supposed to come back. If a key is missing or malformed, we treat that question as refused.
- **Errors:** unknown question type → HTTP 400 with `error.message` holding a zod-style validation list (seen live). OpenRouter documents 400/401/402/403/404/413/429/5xx/524/529.
- **Usage (live via OpenRouter):** `usage.input_tokens`, `usage.output_tokens`, `usage.cost` (USD). The response also carries `model` (e.g. `typesafe/jev-1.13-20260917`), `id` and `provider`.
- **Verified live** while building this repo, and used for the benchmark.

## Gemini Decisions API: `POST v1beta/decisions`

Source: the official [AI Studio Decisions API guide](https://aistudio.google.com/docs/decisions-api), plus live calls.

- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/decisions`, header `x-goog-api-key`. Model `gemini-decision-1`. Gemini Developer API only (not Vertex). It is v1beta, so expect changes.
- **Request:** `{ model, input, questions }`. `input` is a string, a block, or an array of blocks (`text`, `image`, `audio`, `video`, `document`). Adjacent text blocks are joined with no separator. We send one `text` block holding the JSON `{ post: { body, context } }`.
- **Questions:** a **map**, 1–1,000 per request (also bounded by the 262,144-token context window). Keys are `[A-Za-z0-9_-]{1,64}`. Types: `noul` (no criteria needed, optional `criteria.{true_description,false_description}`), `choice` (option map, 2–255; keys are sorted by byte order), `score` (level array, 2–255).
- **Answer:** `answers[key] = { type: "noul", noul, confidence }`, where `confidence = max(noul, 1 − noul)`. `noul` lives in 0.01–0.99, so a threshold above 0.99 never matches, and "≥0.98" is effectively the maximum. Live answers are unrounded floats (e.g. `0.9496503722087116`).
- **Refusal:** there is no per-question refusal. An input safety block rejects the **whole request** with HTTP 400 and `error.code` set to one of `safety`, `prohibited_content`, `blocklist`, `image_safety` or `content_blocked`. We map all five to "every question refused", so a block never hides anything.
- **Errors:** `{ "error": { "code", "message" } }`. A bad question type returns 400 `invalid_request` (seen live). Rate and spend limits return 429 `RESOURCE_EXHAUSTED`.
- **Usage:** `total_input_tokens`, `input_tokens_by_modality`, `total_output_tokens` (always 0), `total_tokens`. Free tier costs nothing; paid tier is $0.10 per 1M input tokens. Our three-question call is about 250 input tokens.
- **Rate limits (per project):** free tier 200 RPM, 50,000 TPM and 10,000 requests per day; Tier 1 1,500 RPM and 1M TPM. The benchmark paces Gemini at 150 RPM (`BENCH_GEMINI_RPM`). There's no Batch API and no context caching.
- **Verified live** while building this repo.

## Vercel AI SDK: `experimental_decide`

- **Name and signature:** `experimental_decide({ model, state, questions, abortSignal, maxRetries, ... })` from `ai`. Questions are a map with types `boolean` (→ `probability`), `choice`, `score` and `box`.
- **Providers:** `openai.decisionModel('gpt-6-luna')`, `typeSafeAi.decisionModel('jev-latest')` (`@ai-sdk/typesafe-ai`), `google.decisionModel('gemini-decision-1')`, Perplexity, plus Anthropic through a structured-output adapter. OpenRouter is not listed.
- **Why shadowmod doesn't build on it:** a refusal on **any** question throws `Experimental_DecisionRefusalError` for the whole call, and partial results are not supported. shadowmod's core rule is that a refusal on one question leaves only that score missing and the other questions still count. With the SDK we would lose every score whenever one question is refused. The SDK also retries by default, which works against a hard save-path timeout.

So shadowmod uses three small `fetch` adapters (`src/providers/{openai,jev,gemini}.ts`) behind one `DecisionProvider` interface, plus a deterministic `fake` provider. Nothing outside `src/providers/` knows which one is in use. If the SDK later returns partial answers with per-question refusals, a fourth adapter wrapping `experimental_decide` would be about 30 lines.

## Sources

- OpenAI: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [create decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- Jev: [OpenRouter TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk.md), [OpenRouter systemone SDK](https://openrouter.ai/docs/client-sdks/typescript/sdks/systemone/README.md), [DigitalOcean System One API](https://docs.digitalocean.com/products/inference/how-to/use-system-one-api/), [AIML API Jev](https://docs.aimlapi.com/api-references/decision-models/typesafe/jev.md)
- Gemini: [AI Studio Decisions API guide](https://aistudio.google.com/docs/decisions-api), [rate limits](https://aistudio.google.com/docs/rate-limits), [Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/), [codelab](https://codelabs.developers.google.com/getting-started-with-gemini-decisions-api), [REST guide (third-party)](https://flaviocopes.com/gemini-decisions-api.md)
- AI SDK: [decide reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/decide), [decisions guide](https://ai-sdk.dev/docs/ai-sdk-core/decisions)
