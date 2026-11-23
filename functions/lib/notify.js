// Best-effort email notifications for new leads, sent through the owner's Google Apps Script
// web app (free Gmail sending). Nothing here can affect lead storage or the visitor's reply:
// lead.js calls notifyLead() in the background (waitUntil) after the lead is already saved and the
// success response is ready, and notifyLead() never throws.
//
// Delivery is NOT guaranteed. Each email has its own status in the lead_notifications table:
//   pending   not attempted yet
//   sending   an attempt holds a 60-second lease; an expired lease means the attempt was cut off
//   sent      Apps Script confirmed this email was sent (now or earlier)
//   failed    Apps Script confirmed this email was NOT sent (reason in last_code)
//   unknown   no trustworthy answer (timeout, network error, unreadable reply): may or may not be sent
//   skipped   receipt not due (same address within 24 hours, daily cap, or Gmail quota low)
//   disabled  email is switched off or not configured
// Retries are opportunistic: one quick retry inside the same background task, then only when a later
// lead is submitted (up to 2 older emails per submission), or after a manual reset in the D1 console.
// Apps Script remembers which emails it already sent, so a retry never sends the same email twice
// (except in the rare case described in README.md).

const encoder = new TextEncoder();

const ATTEMPT_TIMEOUT_MS = 10_000; // one request to Apps Script
const TASK_BUDGET_MS = 25_000; // Cloudflare allows about 30 s of background work after the response
const MIN_MS_FOR_ATTEMPT = 11_000; // never start an attempt that might not finish in the budget
const RETRY_DELAY_MS = 2_000;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const OLDER_PER_PASS = 2;
const ACK_CAP_MAX = 50; // Gmail allows ~100 recipients/day; each lead may use 2
const MAX_REPLY_CHARS = 4096;
// Only leads that agreed to the notice version describing these emails are ever emailed.
export const EMAIL_CONSENT_VERSION = "2026-11-draft-2";

const RETRYABLE = "'pending','sending','failed','unknown'";
const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,200}\/exec$/;

const isTrue = (v) => typeof v === "string" && v.trim().toLowerCase() === "true";

export function emailSettings(env) {
  const url = typeof env.APPS_SCRIPT_URL === "string" ? env.APPS_SCRIPT_URL.trim() : "";
  const secret = typeof env.APPS_SCRIPT_SECRET === "string" ? env.APPS_SCRIPT_SECRET.trim() : "";
  return {
    enabled: isTrue(env.EMAIL_ENABLED),
    urlOk: URL_RE.test(url),
    secretOk: secret.length >= 32,
    url,
    secret,
  };
}

export function emailConfigured(env) {
  const s = emailSettings(env);
  return s.enabled && s.urlOk && s.secretOk;
}

// Receipts per UTC day. Missing or invalid => 0 => no receipts (owner emails still go out).
export function ackDailyCap(env) {
  const raw = Number.parseInt(env.ACK_DAILY_CAP ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, ACK_CAP_MAX);
}

// First word of the name, made harmless for a fixed email template.
export function safeFirstName(name) {
  let s = typeof name === "string" ? name : "";
  s = s.replace(/(https?:\/\/|www\.)\S*/gi, " ").replace(/:\/\//g, " ");
  s = s.replace(/[<>@\u0000-\u001F\u007F]/g, " ").trim();
  const first = (s.split(/\s+/)[0] || "").slice(0, 40);
  return first || "there";
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Signed request body. Apps Script cannot read headers, so the signature travels in the body.
export async function signedBody(secret, payloadObject, nowSeconds) {
  const payload = JSON.stringify(payloadObject);
  const ts = nowSeconds;
  const sig = await hmacHex(secret, `${ts}.${payload}`);
  return JSON.stringify({ v: 1, ts, payload, sig });
}

// ---- D1 steps --------------------------------------------------------------------------------

// Create the row and decide ONCE whether the customer gets a receipt. Done in one statement so two
// leads arriving together cannot both squeeze under the daily cap.
async function createRow(db, ref, cap) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO lead_notifications
         (ref, owner_status, customer_status, customer_skip_reason, attempts, lease_until)
       SELECT l.ref, 'pending',
              CASE WHEN EXISTS (SELECT 1 FROM leads o WHERE o.email = l.email AND o.ref != l.ref
                                  AND o.created_at >= datetime('now', '-24 hours')) THEN 'skipped'
                   WHEN (SELECT COUNT(*) FROM lead_notifications n WHERE n.created_at >= date('now')
                           AND n.customer_status NOT IN ('skipped', 'disabled')) >= ?2 THEN 'skipped'
                   ELSE 'pending' END,
              CASE WHEN EXISTS (SELECT 1 FROM leads o WHERE o.email = l.email AND o.ref != l.ref
                                  AND o.created_at >= datetime('now', '-24 hours')) THEN 'same-address-24h'
                   WHEN (SELECT COUNT(*) FROM lead_notifications n WHERE n.created_at >= date('now')
                           AND n.customer_status NOT IN ('skipped', 'disabled')) >= ?2 THEN 'daily-cap'
                   ELSE NULL END,
              0, 0
         FROM leads l WHERE l.ref = ?1`
    )
    .bind(ref, cap)
    .run();
}

async function createDisabledRow(db, ref, code) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO lead_notifications (ref, owner_status, customer_status, attempts, lease_until, last_code)
       VALUES (?1, 'disabled', 'disabled', 0, 0, ?2)`
    )
    .bind(ref, code)
    .run();
}

// Claim the row with a lease. Only a row with no active lease can be claimed, so every message
// left in 'sending' after this UPDATE belongs to this attempt. Returns { owner, customer, lease }
// with true for each message this attempt must send, or null if nothing can be claimed.
async function claimRow(db, ref, nowSec) {
  const lease = nowSec + LEASE_SECONDS;
  const row = await db
    .prepare(
      `UPDATE lead_notifications
          SET owner_status    = CASE WHEN owner_status    IN (${RETRYABLE}) THEN 'sending' ELSE owner_status END,
              customer_status = CASE WHEN customer_status IN (${RETRYABLE}) THEN 'sending' ELSE customer_status END,
              lease_until = ?2, attempts = attempts + 1, updated_at = datetime('now')
        WHERE ref = ?1 AND attempts < ?3 AND lease_until < ?4
          AND created_at >= datetime('now', '-48 hours')
          AND (owner_status IN (${RETRYABLE}) OR customer_status IN (${RETRYABLE}))
        RETURNING owner_status, customer_status`
    )
    .bind(ref, lease, MAX_ATTEMPTS, nowSec)
    .first();
  if (!row) return null;
  return { owner: row.owner_status === "sending", customer: row.customer_status === "sending", lease };
}

// Write the result, but only if this attempt still holds the lease (if the lease ran out and another
// attempt took over, that attempt's result wins). Clears the lease so a retry can start at once.
async function recordResult(db, ref, lease, owner, customer, customerSkipReason, code) {
  await db
    .prepare(
      `UPDATE lead_notifications
          SET owner_status    = CASE WHEN owner_status    = 'sending' THEN ?3 ELSE owner_status END,
              customer_status = CASE WHEN customer_status = 'sending' THEN ?4 ELSE customer_status END,
              customer_skip_reason = CASE WHEN customer_status = 'sending' AND ?4 = 'skipped' THEN ?5
                                          ELSE customer_skip_reason END,
              last_code = ?6, lease_until = 0, updated_at = datetime('now')
        WHERE ref = ?1 AND lease_until = ?2`
    )
    .bind(ref, lease, owner, customer, customerSkipReason, code)
    .run();
}

async function loadLead(db, ref) {
  return db
    .prepare(
      `SELECT ref, name, email, business_type, service, details, preferred_date, preferred_time,
              request_type, created_at, consent_version
         FROM leads WHERE ref = ?1`
    )
    .bind(ref)
    .first();
}

// Older emails worth another try: unsent rows from the last 48 hours, plus recent leads that never
// got a row (for example if an earlier background task was cut off before creating it).
async function olderWork(db, excludeRef, nowSec) {
  const rows = await db
    .prepare(
      `SELECT ref, 0 AS missing FROM lead_notifications
        WHERE ref != ?1 AND attempts < ?2 AND lease_until < ?3 AND created_at >= datetime('now', '-48 hours')
          AND (owner_status IN (${RETRYABLE}) OR customer_status IN (${RETRYABLE}))
       UNION ALL
       SELECT l.ref, 1 AS missing FROM leads l LEFT JOIN lead_notifications n ON n.ref = l.ref
        WHERE n.ref IS NULL AND l.ref != ?1 AND l.consent_version = ?4
          AND l.created_at >= datetime('now', '-48 hours')
       LIMIT ?5`
    )
    .bind(excludeRef, MAX_ATTEMPTS, nowSec, EMAIL_CONSENT_VERSION, OLDER_PER_PASS)
    .all();
  return rows.results || [];
}

// ---- Apps Script call ------------------------------------------------------------------------

const TOP_LEVEL_NOT_SENT = new Set(["rejected", "bad-request", "not-configured", "busy"]);

// Turn one Apps Script reply (or the lack of one) into a status per requested message.
// Only a well-formed reply that names a message can set 'sent' or 'failed'; anything else is 'unknown'.
export function interpretReply(want, transportCode, data) {
  const out = { owner: want.owner ? "unknown" : null, customer: want.customer ? "unknown" : null, skipReason: null };
  if (transportCode) return { ...out, code: transportCode };
  if (!data || typeof data !== "object" || data.v !== 1) return { ...out, code: "bad-response" };

  if (typeof data.error === "string") {
    // Apps Script returns these before sending anything, so nothing was sent.
    if (TOP_LEVEL_NOT_SENT.has(data.error)) {
      return {
        owner: want.owner ? "failed" : null,
        customer: want.customer ? "failed" : null,
        skipReason: null,
        code: `script:${data.error}`,
      };
    }
    return { ...out, code: "script:internal" }; // an error after sending may have started
  }

  const map = (value, isCustomer) => {
    if (value === "sent" || value === "already-sent") return "sent";
    if (value === "failed" || value === "quota") return "failed";
    if (isCustomer && value === "skipped-quota") {
      out.skipReason = "gmail-quota";
      return "skipped";
    }
    return "unknown";
  };
  if (want.owner) out.owner = map(data.owner, false);
  if (want.customer) out.customer = map(data.customer, true);
  const parts = [];
  if (want.owner) parts.push(`owner:${typeof data.owner === "string" ? data.owner.slice(0, 20) : "missing"}`);
  if (want.customer) parts.push(`customer:${typeof data.customer === "string" ? data.customer.slice(0, 20) : "missing"}`);
  return { ...out, code: parts.join(" ") };
}

async function callAppsScript(settings, body, deps) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetch(settings.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "follow", // Apps Script answers through a Google redirect
      signal: controller.signal,
    });
    const text = (await res.text()).slice(0, MAX_REPLY_CHARS);
    if (!res.ok) return { transportCode: `http-${res.status}`, data: null };
    try {
      return { transportCode: null, data: JSON.parse(text) };
    } catch {
      return { transportCode: null, data: null }; // e.g. a Google error page (HTML, status 200)
    }
  } catch (err) {
    return { transportCode: err && err.name === "AbortError" ? "timeout" : "network", data: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---- One lead: claim, send, record (with at most one quick retry) -----------------------------

async function processRef(ctx, ref, quickRetry) {
  const { db, settings, deps } = ctx;
  const tries = quickRetry ? 2 : 1;
  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      if (!ctx.hasTime(RETRY_DELAY_MS + MIN_MS_FOR_ATTEMPT)) return;
      await deps.sleep(RETRY_DELAY_MS);
    }
    if (!ctx.hasTime(MIN_MS_FOR_ATTEMPT)) return;

    const claim = await claimRow(db, ref, Math.floor(deps.now() / 1000));
    if (!claim) return;

    const lead = await loadLead(db, ref);
    if (!lead || lead.consent_version !== EMAIL_CONSENT_VERSION) {
      const s = (want) => (want ? "failed" : null);
      await recordResult(db, ref, claim.lease, s(claim.owner), s(claim.customer), null, lead ? "old-consent" : "lead-missing");
      return;
    }

    const payload = {
      ref: lead.ref,
      send: { owner: claim.owner, customer: claim.customer },
      firstName: safeFirstName(lead.name),
      lead: {
        name: lead.name,
        email: lead.email,
        businessType: lead.business_type,
        service: lead.service,
        details: lead.details,
        preferredDate: lead.preferred_date,
        preferredTime: lead.preferred_time,
        requestType: lead.request_type,
        createdAt: lead.created_at,
      },
    };
    const body = await signedBody(settings.secret, payload, Math.floor(deps.now() / 1000));
    const { transportCode, data } = await callAppsScript(settings, body, deps);
    const result = interpretReply(claim, transportCode, data);
    await recordResult(db, ref, claim.lease, result.owner, result.customer, result.skipReason, result.code);
    console.log(`notify ${ref}: ${result.code}`); // codes only, no personal data

    if (result.owner !== "unknown" && result.customer !== "unknown") return;
  }
}

// ---- Entry point -----------------------------------------------------------------------------

const defaultDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs: ATTEMPT_TIMEOUT_MS,
};

// Never throws. Safe to hand to waitUntil().
export async function notifyLead(env, ref, depsOverride = {}) {
  const deps = { ...defaultDeps, ...depsOverride };
  const db = env.DB;
  if (!db || typeof ref !== "string") return;
  const started = deps.now();
  const settings = emailSettings(env);

  try {
    if (!(settings.enabled && settings.urlOk && settings.secretOk)) {
      // Record why nothing was sent. Errors are ignored: Production has no email table.
      try {
        await createDisabledRow(db, ref, settings.enabled ? "not-configured" : "email-off");
      } catch {
        /* nothing to record */
      }
      return;
    }

    const ctx = {
      db,
      settings,
      deps,
      hasTime: (needMs) => deps.now() - started + needMs <= TASK_BUDGET_MS,
    };

    try {
      await createRow(db, ref, ackDailyCap(env));
    } catch {
      console.log(`notify ${ref}: notify-row-failed`);
      return;
    }

    try {
      await processRef(ctx, ref, true);
    } catch {
      console.log(`notify ${ref}: notify-error`);
    }

    // Opportunistic retries of older emails, only while time remains.
    try {
      const work = await olderWork(db, ref, Math.floor(deps.now() / 1000));
      for (const item of work) {
        if (!ctx.hasTime(MIN_MS_FOR_ATTEMPT)) break;
        if (item.missing) await createRow(db, item.ref, ackDailyCap(env));
        await processRef(ctx, item.ref, false);
      }
    } catch {
      console.log("notify: retry-pass-error");
    }

    // Remove rows whose lead has been deleted (they hold no personal data, only statuses).
    try {
      await db.prepare("DELETE FROM lead_notifications WHERE ref NOT IN (SELECT ref FROM leads)").run();
    } catch {
      /* harmless */
    }
  } catch {
    console.log("notify: unexpected-error");
  }
}
