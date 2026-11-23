// Shared request checks for the chatbot API: responses, origin check, body size, IP hashing,
// D1-based rate limiting, Turnstile verification and short-lived signed chat sessions.

const MAX_BODY_BYTES = 8 * 1024;
const encoder = new TextEncoder();

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

// Only accept browser requests coming from this same site (production or the preview URL).
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

// Read a small JSON body. Returns null if it is too big, not JSON, or not an object.
export async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().startsWith("application/json")) return null;
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (encoder.encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// Remove control characters (keeps normal line breaks) and trim.
export function clean(value, maxLength) {
  if (typeof value !== "string") return "";
  const out = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
  return out.length > maxLength ? "" : out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One-way, salted hash of the visitor's IP. The raw IP is never stored.
export async function visitorKey(request, env) {
  const salt = env.IP_HASH_SALT;
  if (typeof salt !== "string" || salt.length < 16) throw new Error("IP_HASH_SALT missing");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 32);
}

// Fixed-window counter in D1. Returns true if this request is allowed.
// Throws on D1 errors, which callers treat as "not allowed" (fail closed).
export async function allow(db, key, windowSeconds, limit) {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(key, windowStart)
    .first();
  return row !== null && row.count <= limit;
}

// Server-side Turnstile check. The token must be valid, for this hostname and for this action.
// Returns { ok, reason }. `reason` is a short code (Cloudflare's own error codes or ours); it
// never contains the secret key or the token, so it is safe to log and to return to the browser.
export async function verifyTurnstile(token, expectedAction, request, env) {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing-token" };
  if (token.length > 2048) return { ok: false, reason: "token-too-long" };
  // Trim: a secret pasted with a trailing space or line break is rejected by Cloudflare.
  const secret = typeof env.TURNSTILE_SECRET_KEY === "string" ? env.TURNSTILE_SECRET_KEY.trim() : "";
  if (!secret) return { ok: false, reason: "missing-secret" };

  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);

  let data;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    if (!res.ok) return { ok: false, reason: `siteverify-http-${res.status}` };
    data = await res.json();
  } catch {
    return { ok: false, reason: "siteverify-unreachable" };
  }

  if (data.success !== true) {
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].filter((c) => typeof c === "string") : [];
    return { ok: false, reason: codes.length ? codes.join(",").slice(0, 120) : "not-successful" };
  }
  if (data.action !== expectedAction) return { ok: false, reason: "action-mismatch" };
  if (data.hostname !== new URL(request.url).hostname) return { ok: false, reason: "hostname-mismatch" };
  return { ok: true, reason: "ok" };
}

// ---- Signed chat sessions -------------------------------------------------------------------
// After one Turnstile check, the visitor gets a session token valid for 30 minutes, so Turnstile
// does not have to run before every message. Format: base64url(payload).base64url(hmac).

const SESSION_SECONDS = 30 * 60;

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hmacKey(env) {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new Error("SESSION_SECRET missing");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSession(env, visitor) {
  const payload = encoder.encode(JSON.stringify({ v: visitor, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), payload));
  return `${b64url(payload)}.${b64url(sig)}`;
}

export async function checkSession(env, token, visitor) {
  if (typeof token !== "string" || token.length > 512 || !token.includes(".")) return false;
  try {
    const [p, s] = token.split(".");
    const payload = fromB64url(p);
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64url(s), payload);
    if (!ok) return false;
    const data = JSON.parse(new TextDecoder().decode(payload));
    return data.v === visitor && Number.isInteger(data.exp) && data.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}
