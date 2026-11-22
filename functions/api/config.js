// GET /api/config: public settings the chat widget needs (no secrets).

import { aiSwitchOn } from "../lib/budget.js";
import { json } from "../lib/guard.js";

export function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ status: "error" }, 405);
  const siteKey = typeof env.TURNSTILE_SITE_KEY === "string" ? env.TURNSTILE_SITE_KEY : "";
  return json({
    siteKey,
    ai: Boolean(siteKey) && aiSwitchOn(env) && Boolean(env.AI) && Boolean(env.DB),
    leads: Boolean(siteKey) && Boolean(env.DB),
  });
}
