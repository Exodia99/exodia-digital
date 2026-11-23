# Exodia Digital — Website

Official website for **Exodia Digital**: web solutions, digital growth and business automation.

Plain **HTML, CSS and JavaScript**, with no framework and no build step. The design and content come from the
approved website made in Claude chat. The embedded images were moved into separate files so the page loads faster.

## Project structure

```
.
├── index.html                 # The website (one page)
├── 404.html                   # "Page not found" (served automatically by Cloudflare Pages)
├── assets/
│   ├── css/styles.css         # All styles
│   ├── js/main.js             # Contact form + optional client reviews
│   └── images/                # Logo, owl emblem, hero mockup, portfolio screenshots (WebP)
├── site.webmanifest
├── robots.txt
├── sitemap.xml                # Contains a [YOUR-DOMAIN] placeholder
├── _headers                   # Cloudflare Pages: security + caching headers
├── _redirects                 # Cloudflare Pages: redirects (empty for now)
├── .editorconfig
└── .gitignore
```

## Local preview

```bash
python -m http.server 8080
```

Then open <http://localhost:8080>.

## Editing notes

- **Client reviews:** the "What clients say" section stays hidden until you add real reviews to
  `REVIEWS` in `assets/js/main.js`, for example `{quote: "...", name: "...", role: "..."}`.
- **Contact form:** opens the visitor's email app with a pre-filled message to `exodia.digitals@gmail.com`
  (`CONTACT_EMAIL` in `assets/js/main.js`).
- **Domain:** once confirmed, add canonical, `og:url` and `og:image` tags to `index.html`, and update
  `sitemap.xml` and `robots.txt`.

## Deployment (Cloudflare Pages)

Not connected yet. When ready:

1. Push this repository to GitHub.
2. In Cloudflare Pages, create a project from that repository with:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/`
3. `_headers`, `_redirects` and `404.html` are picked up automatically.

## Chat assistant (Cloudflare free plan only)

A chat window in the bottom-right corner answers questions with Cloudflare Workers AI and collects
inquiries and consultation **requests** (never confirmed bookings). Everything runs on free plans:
Pages Functions, Workers AI (free daily allocation), D1 and Turnstile. There is no paid model, no
fallback model and no paid service. Telegram alerts exist in the code but are **off** unless
`TELEGRAM_ENABLED` is set to `true`.

### Files

```
functions/api/chat.js      POST /api/chat: checks, rate limits, neuron budget, AI reply
functions/api/lead.js      POST /api/lead: saves an inquiry or consultation request to D1
functions/api/config.js    GET  /api/config: public widget settings (no secrets)
functions/lib/budget.js    The one allowed model, its neuron rates, the daily cap logic
functions/lib/guard.js     Origin/size checks, IP hashing, rate limits, Turnstile, sessions
functions/lib/knowledge.js What the assistant knows (taken only from this website)
functions/lib/notify.js    Best-effort lead emails through Google Apps Script (Gmail)
_routes.json               Functions run only for /api/*; the website stays static
schema.sql                 D1 tables: leads, ai_usage, rate_limits, lead_notifications, cleanup_runs
workers/cleanup/index.js   Daily cleanup Worker (pasted into the dashboard, not part of Pages)
assets/js/chatbot.js       Chat widget
assets/css/chatbot.css     Chat widget styles (all scoped to .xd-chat*)
privacy.html               Privacy notice (+ assets/css/privacy.css)
```

### Daily AI budget

Neurons = real token counts from each AI reply × Cloudflare's published rate for the model. Before
each call the worst possible cost is reserved in D1 in one atomic update, and the call only happens
if it fits under `DAILY_NEURON_CAP` (never above 9,000 in code). If the counter, the usage data or
D1 cannot be trusted, AI replies switch off and visitors see a friendly message; the request form
keeps working. Today's usage:

```sql
SELECT * FROM ai_usage ORDER BY day DESC LIMIT 7;
```

### Cloudflare settings (Workers & Pages > exodia-digital > Settings)

| Name | Type | Preview | Production |
|---|---|---|---|
| `AI` | Workers AI binding | yes | yes |
| `DB` | D1 binding | `exodia-leads-preview` | `exodia-leads` |
| `AI_ENABLED` | Variable | `true` | `true` |
| `DAILY_NEURON_CAP` | Variable | `1000` | `8000` |
| `TURNSTILE_SITE_KEY` | Variable | site key | site key |
| `TURNSTILE_SECRET_KEY` | Secret | secret key | secret key |
| `SESSION_SECRET` | Secret | random, 32+ characters | different random value |
| `IP_HASH_SALT` | Secret | random, 16+ characters | different random value |

Redeploy after changing settings. Never use Workers AI for anything else on this account, so the
counter stays complete.

### Viewing leads (Cloudflare dashboard > Storage & Databases > D1 > exodia-leads > Console)

```sql
-- newest 50
SELECT ref, created_at, name, email, business_type, service, preferred_date, preferred_time, request_type, status
FROM leads ORDER BY created_at DESC LIMIT 50;

-- search
SELECT * FROM leads WHERE name LIKE '%juan%' OR email LIKE '%juan%' OR details LIKE '%juan%';

-- open requests
SELECT * FROM leads WHERE status = 'requested' ORDER BY created_at;

-- update a status: requested, contacted, confirmed, closed
UPDATE leads SET status = 'contacted' WHERE ref = 'EXD-...';

-- privacy request: access / delete one person's data
SELECT * FROM leads WHERE email = 'person@example.com';
DELETE FROM leads WHERE email = 'person@example.com';

-- check the daily cleanup is running (newest run should be under 2 days old)
SELECT * FROM cleanup_runs ORDER BY ran_at DESC LIMIT 7;
```

Times in `created_at` are UTC (add 8 hours for Philippine time). Keep two-factor authentication on
for the Cloudflare account, because the dashboard is the only way to read leads.

### Email notifications (best effort, Preview only for now)

After a lead is saved, a background task asks the owner's Google Apps Script web app to send two
plain-text emails from the owner's Gmail: a notification to the owner (all lead details) and a short
receipt to the customer (reference number and first name only; not a confirmed appointment).
Google Apps Script and Gmail are free; no paid email service is used.

**Delivery is not guaranteed.** Emails never affect lead storage or the visitor's success message:
the D1 `leads` table is always the record to rely on. Retries are opportunistic:

- one quick retry about 2 seconds after a timeout or unreadable reply;
- after that, only when **another lead is submitted** (up to 2 older emails per submission, within
  48 hours, at most 5 attempts per lead);
- otherwise by **manual reset** in the D1 console (below).

So with little traffic, a failed email may wait until the next submission or need a manual reset.

The Apps Script code (`Code.gs`) is kept outside this repository, because everything here is
published. It holds `OWNER_EMAIL` and `SHARED_SECRET` in its Script properties.

Receipts are skipped when the same address already submitted in the last 24 hours, when
`ACK_DAILY_CAP` receipts were already counted today (UTC), or when the Gmail daily quota is low
(about 100 recipients a day; the owner notification goes first). Only leads that agreed to notice
version `2026-11-draft-2` are emailed.

| Name | Type | Preview | Production |
|---|---|---|---|
| `EMAIL_ENABLED` | Variable | `true` | not set (email off) |
| `APPS_SCRIPT_URL` | Secret | the web app `/exec` URL | not set |
| `APPS_SCRIPT_SECRET` | Secret | same value as `SHARED_SECRET`, 32+ (48 recommended) characters | not set |
| `ACK_DAILY_CAP` | Variable | `20` (max 50; missing = no receipts) | not set |

Create the status table once (one line, in the D1 console of the database you are setting up):

```sql
CREATE TABLE IF NOT EXISTS lead_notifications (ref TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), owner_status TEXT NOT NULL CHECK (owner_status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'disabled')), customer_status TEXT NOT NULL CHECK (customer_status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'skipped', 'disabled')), customer_skip_reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, last_code TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
```

Statuses: `sent` (Apps Script confirmed), `failed` (Apps Script confirmed not sent; see
`last_code`), `unknown` (no trustworthy answer: may or may not have been sent), `skipped`,
`disabled`, `pending`, and `sending` (an attempt in progress; once its lease has expired it means the
attempt was cut off and the outcome is unknown).

```sql
-- emails that may not have reached the owner or customer
SELECT n.*, CASE WHEN n.owner_status = 'sending' AND n.lease_until < CAST(strftime('%s','now') AS INTEGER)
                 THEN 'interrupted (outcome unknown)' END AS note
FROM lead_notifications n
WHERE n.owner_status NOT IN ('sent', 'disabled') OR n.customer_status NOT IN ('sent', 'skipped', 'disabled')
ORDER BY n.created_at DESC;

-- leads with no email status row at all
SELECT l.ref, l.created_at FROM leads l LEFT JOIN lead_notifications n ON n.ref = l.ref
WHERE n.ref IS NULL ORDER BY l.created_at DESC;

-- manual reset: retried on the next lead submission (only works within 48 hours of the lead)
UPDATE lead_notifications SET attempts = 0, lease_until = 0,
  owner_status = CASE WHEN owner_status = 'sent' THEN 'sent' ELSE 'pending' END,
  customer_status = CASE WHEN customer_status IN ('sent', 'skipped') THEN customer_status ELSE 'pending' END
WHERE ref = 'EXD-...';
```

Known rare duplicate: if Gmail sends an email but Apps Script then fails to record it as sent, a
later retry can send that one email a second time.

### Monthly manual tasks (until the cleanup Worker is deployed and verified)

The privacy notice says these are done by hand, so do them every month:

1. D1 console (each database in use):
   `DELETE FROM rate_limits WHERE window_start < CAST(strftime('%s','now','-2 days') AS INTEGER);`
2. Gmail: search `subject:EXD- older_than:1y`, delete the results (inbox and Sent), then empty Trash.
