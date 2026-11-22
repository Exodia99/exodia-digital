// POST /api/chat: answers visitor questions with Workers AI (free allocation only).
//
// Order of checks (any failure stops before the AI is called):
//   same-origin -> body size/shape -> AI switch + cap -> visitor hash -> rate limits
//   -> Turnstile or signed session -> atomic neuron reservation -> AI call -> settle real usage.

import { MODEL, MAX_OUTPUT_TOKENS, aiSwitchOn, dailyCap, utcDay, worstCaseNeurons, actualNeurons, reserve, settle, releaseFailed } from "../lib/budget.js";
import { json, sameOrigin, readJson, clean, visitorKey, allow, verifyTurnstile, createSession, checkSession } from "../lib/guard.js";
import { SYSTEM_PROMPT } from "../lib/knowledge.js";

const MAX_USER_CHARS = 500;
const MAX_ASSISTANT_CHARS = 1500;
const MAX_HISTORY = 12; // last 6 visitor turns plus replies

const OFFLINE = {
  status: "offline",
  reply:
    "Our assistant is resting for now. You can still send us your details with the \"Request a free consultation\" button, and we'll reply soon.",
};

function parseMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_HISTORY) return null;
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (!m || typeof m !== "object") return null;
    // History must alternate user/assistant and end with the visitor's new message.
    const expected = (input.length - 1 - i) % 2 === 0 ? "user" : "assistant";
    if (m.role !== expected) return null;
    const content = clean(m.content, expected === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS);
    if (!content) return null;
    out.push({ role: expected, content });
  }
  return out;
}

function replyText(result) {
  const text = result?.choices?.[0]?.message?.content ?? result?.response;
  if (typeof text !== "string") return "";
  return text.replace(/\*\*/g, "").trim().slice(0, MAX_ASSISTANT_CHARS);
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ status: "error", reply: "Method not allowed." }, 405);
  if (!sameOrigin(request)) return json({ status: "error", reply: "Request not allowed." }, 403);

  const body = await readJson(request);
  const messages = body && parseMessages(body.messages);
  if (!messages) return json({ status: "error", reply: "Please send a shorter message (up to 500 characters)." }, 400);

  if (!aiSwitchOn(env) || !env.AI || !env.DB) return json(OFFLINE, 503);

  const db = env.DB;
  let visitor;
  try {
    visitor = await visitorKey(request, env);
    const okShort = await allow(db, `chat10m:${visitor}`, 600, 15);
    const okDay = okShort && (await allow(db, `chatday:${visitor}`, 86400, 50));
    if (!okShort || !okDay) {
      return json(
        { status: "limited", reply: "You've sent a lot of messages. Please wait a few minutes, or use \"Request a free consultation\" to reach us directly." },
        429
      );
    }
  } catch {
    return json(OFFLINE, 503); // fail closed
  }

  // Human check: a valid signed session, or a fresh Turnstile token that starts a new session.
  let session = null;
  try {
    if (!(await checkSession(env, body.session, visitor))) {
      if (!(await verifyTurnstile(body.turnstile, "chat", request, env))) {
        return json({ status: "verify", reply: "Please complete the quick security check, then send your message again." }, 403);
      }
      session = await createSession(env, visitor);
    }
  } catch {
    return json(OFFLINE, 503);
  }

  const aiMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
  const day = utcDay();
  const worst = worstCaseNeurons(aiMessages);

  try {
    if (!(await reserve(db, day, worst, dailyCap(env)))) return json({ ...OFFLINE, session }, 503);
  } catch {
    return json(OFFLINE, 503);
  }

  let result;
  try {
    result = await env.AI.run(MODEL, {
      messages: aiMessages,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      chat_template_kwargs: { enable_thinking: false },
    });
  } catch {
    try {
      await releaseFailed(db, day, worst);
    } catch {
      /* the reservation stays counted, which is the safe direction */
    }
    return json({ ...OFFLINE, session }, 503);
  }

  const actual = actualNeurons(result?.usage);
  try {
    await settle(db, day, worst, actual);
  } catch {
    /* settle failed: the worst case stays reserved, which over-counts (safe) */
  }

  const reply = replyText(result);
  if (!reply) return json({ ...OFFLINE, session }, 503);
  return json({ status: "ok", reply, session });
}
