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
