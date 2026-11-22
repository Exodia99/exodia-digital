// Workers AI daily neuron budget for the EXODIA DIGITAL chatbot.
//
// Cloudflare reports exact token counts in each reply (`usage`) but not neurons, so neurons are
// computed as: actual tokens x Cloudflare's published per-model rate.
// Before every AI call the worst possible cost is reserved in D1 with one atomic UPDATE. The call
// only happens if that reservation fits under the daily cap. Afterwards the reservation is replaced
// by the real cost. Any doubt (missing counter, missing usage, D1 error) keeps AI replies off.

// The ONLY model this chatbot may call. It is free-eligible on Workers Free and is not on
// Cloudflare's "requires a paid billing method" list. There is deliberately no fallback model.
export const MODEL = "@cf/google/gemma-4-26b-a4b-it";

// Neurons per 1,000,000 tokens, from https://developers.cloudflare.com/workers-ai/platform/pricing/
// (checked 2026-11-23). If Cloudflare changes these, update them here.
const NEURONS_PER_M_INPUT = 9091;
const NEURONS_PER_M_OUTPUT = 27273;

// Longest reply the model may write, in tokens.
export const MAX_OUTPUT_TOKENS = 350;

// The free allowance is 10,000 neurons/day. Preview + production caps together must stay at or
// below this ceiling, whatever the dashboard variables say.
const HARD_CEILING = 9000;

// Extra tokens assumed per message for the chat template (role markers etc.), plus a fixed overhead.
const TEMPLATE_TOKENS_PER_MESSAGE = 16;
const TEMPLATE_TOKENS_FIXED = 64;

const encoder = new TextEncoder();

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10); // Cloudflare resets the free allowance at 00:00 UTC
}

// Daily cap from the DAILY_NEURON_CAP variable. Missing or invalid => 0 => AI stays off.
export function dailyCap(env) {
  const raw = Number.parseInt(env.DAILY_NEURON_CAP ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, HARD_CEILING);
}

export function aiSwitchOn(env) {
  return env.AI_ENABLED === "true" && dailyCap(env) > 0;
}

function neurons(inputTokens, outputTokens) {
  return (inputTokens * NEURONS_PER_M_INPUT + outputTokens * NEURONS_PER_M_OUTPUT) / 1_000_000;
}

// Upper bound for one request. A token is never shorter than one byte, so UTF-8 bytes >= tokens.
export function worstCaseNeurons(messages) {
  let inputTokens = TEMPLATE_TOKENS_FIXED;
  for (const m of messages) {
    inputTokens += encoder.encode(m.content).length + TEMPLATE_TOKENS_PER_MESSAGE;
  }
  return Math.ceil(neurons(inputTokens, MAX_OUTPUT_TOKENS) * 1000) / 1000;
}

// Real cost from the reply's `usage`. Returns null when the numbers cannot be trusted.
// Reasoning tokens are added on top of completion tokens: if they are already included this
// over-counts, which is the safe direction.
export function actualNeurons(usage) {
  if (!usage || typeof usage !== "object") return null;
  const p = usage.prompt_tokens;
  const c = usage.completion_tokens;
  if (!Number.isInteger(p) || !Number.isInteger(c) || p <= 0 || c < 0) return null;
  const r = usage.completion_tokens_details?.reasoning_tokens;
  const reasoning = Number.isInteger(r) && r > 0 ? r : 0;
  return Math.ceil(neurons(p, c + reasoning) * 1000) / 1000;
}

// Atomically reserve `amount` neurons for today. Returns true only if it fits under the cap
// and today's counter is not locked. Throws on D1 errors (callers treat that as "AI off").
export async function reserve(db, day, amount, cap) {
  await db.prepare("INSERT OR IGNORE INTO ai_usage (day) VALUES (?1)").bind(day).run();
  const row = await db
    .prepare(
      `UPDATE ai_usage
         SET reserved = reserved + ?1, requests = requests + 1
       WHERE day = ?2 AND locked = 0 AND used + reserved + ?1 <= ?3
       RETURNING day`
    )
    .bind(amount, day, cap)
    .first();
  return row !== null;
}

// Replace the reservation with the real cost. If the real cost is unknown, the full worst case
// stays charged and the day is locked: AI replies stay off until the next UTC day.
export async function settle(db, day, reserved, actual) {
  if (actual === null) {
    await db
      .prepare(
        `UPDATE ai_usage
           SET reserved = MAX(reserved - ?1, 0), used = used + ?1, unverified = unverified + 1, locked = 1
         WHERE day = ?2`
      )
      .bind(reserved, day)
      .run();
    return;
  }
  await db
    .prepare("UPDATE ai_usage SET reserved = MAX(reserved - ?1, 0), used = used + ?2 WHERE day = ?3")
    .bind(reserved, actual, day)
    .run();
}

// Release a reservation when the AI call itself failed. The attempt may still have used neurons,
// so the worst case is kept as used (safe direction).
export async function releaseFailed(db, day, reserved) {
  await db
    .prepare("UPDATE ai_usage SET reserved = MAX(reserved - ?1, 0), used = used + ?1 WHERE day = ?2")
    .bind(reserved, day)
    .run();
}
