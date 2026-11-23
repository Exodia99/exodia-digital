// POST /api/lead: saves an inquiry or a consultation REQUEST to D1.
// A preferred date/time is stored as a request only (status "requested"); nothing is booked.
// No endpoint returns lead data. Leads are viewed in the Cloudflare dashboard (D1 console).

import { json, sameOrigin, readJson, clean, visitorKey, allow, verifyTurnstile } from "../lib/guard.js";
import { notifyLead, EMAIL_CONSENT_VERSION } from "../lib/notify.js";

const SERVICES = [
  "New website",
  "Portfolio website",
  "Improve my existing website",
  "Automation or growth",
  "Not sure yet",
];
const TIMES = ["morning", "afternoon", "evening"];
const CONSENT_VERSION = EMAIL_CONSENT_VERSION; // privacy notice version "2026-11-draft-2"
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function manilaDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD
}

function validate(body) {
  const errors = [];
  const name = clean(body.name, 100);
  const email = clean(body.email, 254).toLowerCase();
  const businessType = clean(body.businessType, 100);
  const service = SERVICES.includes(body.service) ? body.service : "";
  const details = clean(body.details, 2000);
  let preferredDate = typeof body.preferredDate === "string" ? body.preferredDate.trim() : "";
  let preferredTime = typeof body.preferredTime === "string" ? body.preferredTime.trim() : "";

  if (!name) errors.push("name");
  if (!EMAIL_RE.test(email)) errors.push("email");
  if (!businessType) errors.push("businessType");
  if (!service) errors.push("service");
  if (details.length < 10) errors.push("details");
  if (body.consent !== true) errors.push("consent");

  if (preferredDate) {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(preferredDate) && preferredDate >= manilaDate(1) && preferredDate <= manilaDate(60);
    if (!ok) errors.push("preferredDate");
  }
  if (preferredTime && !TIMES.includes(preferredTime)) errors.push("preferredTime");
  if (!preferredDate) preferredTime = "";
  if (!preferredDate) preferredDate = "";

  return {
    errors,
    lead: { name, email, businessType, service, details, preferredDate: preferredDate || null, preferredTime: preferredTime || null },
  };
}

function newRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const tail = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `EXD-${manilaDate(0).slice(2).replace(/-/g, "")}-${tail}`;
}

// Optional Telegram alert. OFF unless TELEGRAM_ENABLED is exactly "true" (not set up by default).
// Sends only the reference, name and business type; all other details stay in D1.
async function notifyTelegram(env, ref, lead, isRequest) {
  if (env.TELEGRAM_ENABLED !== "true" || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const text = [
    isRequest ? "NEW CONSULTATION REQUEST (unconfirmed)" : "NEW INQUIRY",
    `Ref: ${ref}`,
    `Name: ${lead.name}`,
    `Business: ${lead.businessType}`,
    "Details: Cloudflare dashboard > D1",
  ].join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch {
    /* the lead is already saved; a failed alert is ignored */
  }
}

// Hand work to waitUntil() so it runs after the response. Errors, even immediate ones, are caught.
function runInBackground(waitUntil, task) {
  if (typeof waitUntil !== "function") return;
  try {
    waitUntil(
      Promise.resolve()
        .then(task)
        .catch(() => console.log("notify: background-error"))
    );
  } catch {
    /* the response does not depend on background work */
  }
}

export async function onRequest({ request, env, waitUntil }) {
  if (request.method !== "POST") return json({ status: "error" }, 405);
  if (!sameOrigin(request)) return json({ status: "error", message: "Request not allowed." }, 403);

  const body = await readJson(request);
  if (!body) return json({ status: "error", message: "Please check the form and try again." }, 400);

  // Hidden spam-trap field: real visitors never fill it. Pretend success, store nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") return json({ status: "ok", ref: newRef() });

  const { errors, lead } = validate(body);
  if (errors.length) return json({ status: "invalid", fields: errors, message: "Please check the highlighted fields." }, 400);

  if (!env.DB) return json({ status: "offline" }, 503);
  const db = env.DB;

  try {
    const visitor = await visitorKey(request, env);
    const okHour = await allow(db, `lead1h:${visitor}`, 3600, 3);
    const okDay = okHour && (await allow(db, `leadday:${visitor}`, 86400, 5));
    if (!okHour || !okDay) return json({ status: "limited", message: "You've sent several requests already. We'll be in touch soon." }, 429);
  } catch {
    return json({ status: "offline" }, 503);
  }

  const check = await verifyTurnstile(body.turnstile, "lead", request, env);
  if (!check.ok) {
    console.log(`turnstile lead rejected: ${check.reason}`); // visible in Cloudflare Functions real-time logs
    return json({ status: "verify", reason: check.reason, message: "The security check didn't go through. Please try again." }, 403);
  }

  const ref = newRef();
  const isRequest = Boolean(lead.preferredDate);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO leads (ref, name, email, business_type, service, details, preferred_date, preferred_time,
                              request_type, status, consent_at, consent_version)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'requested', datetime('now'), ?10)`
        )
        .bind(ref, lead.name, lead.email, lead.businessType, lead.service, lead.details, lead.preferredDate, lead.preferredTime,
          isRequest ? "consultation_request" : "inquiry", CONSENT_VERSION),
      // Backup for the daily cleanup Worker: remove anything older than 12 months.
      db.prepare("DELETE FROM leads WHERE created_at < datetime('now', '-12 months')"),
    ]);
  } catch {
    return json({ status: "offline" }, 503);
  }

  waitUntil(notifyTelegram(env, ref, lead, isRequest));
  // Best-effort emails (owner notification + customer receipt), after the lead is saved. Any error
  // in there is caught and logged; it can never change this response.
  runInBackground(waitUntil, () => notifyLead(env, ref));
  return json({ status: "ok", ref, request: isRequest });
}
