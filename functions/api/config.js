// GET /api/config: public settings the chat widget needs (no secrets).

import { aiSwitchOn, dailyCap } from "../lib/budget.js";
import { json } from "../lib/guard.js";
import { emailSettings } from "../lib/notify.js";

// Setup diagnostics are shown only when BOTH are true:
//   1. EXODIA_SETUP_DIAGNOSTICS is exactly "true" (set in the Preview environment only), and
//   2. the request is for a pages.dev preview address of this project.
// Production never sets the variable, so its deployment URLs and any custom domain never show it.
const PREVIEW_SUFFIX = ".exodia-digital.pages.dev";

const isSet = (v) => typeof v === "string" && v.trim().length > 0;

function diagnosticsAllowed(request, env) {
  const flag = typeof env.EXODIA_SETUP_DIAGNOSTICS === "string" && env.EXODIA_SETUP_DIAGNOSTICS.trim() === "true";
  if (!flag) return false;
  try {
    return new URL(request.url).hostname.endsWith(PREVIEW_SUFFIX);
  } catch {
    return false;
  }
}

export function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ status: "error" }, 405);
  const siteKey = isSet(env.TURNSTILE_SITE_KEY) ? env.TURNSTILE_SITE_KEY.trim() : "";
  const data = {
    siteKey,
    ai: Boolean(siteKey) && aiSwitchOn(env) && Boolean(env.AI) && Boolean(env.DB),
    leads: Boolean(siteKey) && Boolean(env.DB),
  };

  // Which settings are present: true/false only, never any value.
  if (diagnosticsAllowed(request, env)) {
    const email = emailSettings(env);
    data.setup = {
      aiBinding: Boolean(env.AI),
      dbBinding: Boolean(env.DB),
      aiEnabled: isSet(env.AI_ENABLED) && env.AI_ENABLED.trim().toLowerCase() === "true",
      neuronCapSet: dailyCap(env) > 0,
      turnstileSiteKey: Boolean(siteKey),
      turnstileSecretKey: isSet(env.TURNSTILE_SECRET_KEY),
      sessionSecret: isSet(env.SESSION_SECRET) && env.SESSION_SECRET.length >= 32,
      ipHashSalt: isSet(env.IP_HASH_SALT) && env.IP_HASH_SALT.length >= 16,
      emailEnabled: email.enabled,
      appsScriptUrl: email.urlOk,
      appsScriptSecret: email.secretOk,
    };
  }
  return json(data);
}
