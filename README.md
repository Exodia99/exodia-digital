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
_routes.json               Functions run only for /api/*; the website stays static
schema.sql                 D1 tables: leads, ai_usage, rate_limits, cleanup_runs
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
