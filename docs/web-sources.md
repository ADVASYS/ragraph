# Web sources

RAGraph can autonomously crawl the web and feed the result into the same
knowledge-graph pipeline that handles local folder mounts. A **web source** is
a per-universe configuration that tells the crawler which URL to start from,
how deep to go, and when to refresh. Extracted pages are written to a local
Markdown cache and re-used by the normal ingestion pipeline, so chunking,
entity extraction, embedding, and graph consolidation work unchanged.

## Data model

Three tables live inside the meta database (`MetaDatabase`):

- `web_sources` — one row per source, storing the user's configuration:
  scope, max depth, max pages, include/exclude regex patterns, refresh
  interval, status, and last/next scan timestamps.
- `web_pages` — the crawler's per-URL index. Used for dedupe (`content_hash`)
  and conditional refresh (`etag`, `last_modified`). Each row references a
  row in `files` when the page made it through ingestion.
- `files` — the existing documents table, now with an optional
  `web_source_id` column. A `CHECK` constraint enforces that every file is
  linked to either a `mount_id` or a `web_source_id`.

Legacy databases are migrated in place: the `files` table is rewritten with a
nullable `mount_id` and the new `web_source_id` column during startup.

## Crawl flow

```
User URL
  │
  ▼
robots.txt ── sitemap.xml (if scope = site / sitemap)
  │
  ▼
BFS queue (p-queue, concurrency = 2, 500 ms politeness per origin)
  │
  ▼
HTTP GET (If-None-Match / If-Modified-Since from previous run)
  ├─ 304 Not Modified ──▶ update fetched_at, skip
  ├─ non-HTML / too big ▶ skip
  └─ 200 OK
     │
     ▼
jsdom + @mozilla/readability (fallback: body → turndown)
  │  produces clean Markdown + content hash
  ▼
content_hash dedupe
  ├─ unchanged ──▶ bump fetched_at, no re-ingestion
  └─ new / changed
     │
     ▼
write /ragraph/web/<universe>/<source>/<slug>-<hash8>.md
upsert web_pages + files rows
ingestion.ingestFile(record)  ← same pipeline as folder mounts
```

### Scope options

- **`single`** — only the supplied URL. Ideal for stable single-page
  references (RFCs, docs landing pages).
- **`site`** — BFS starting from the URL, respecting `max_depth` and
  `max_pages`. Falls back to `sitemap.xml` if advertised in robots.txt.
- **`sitemap`** — skip BFS and enumerate the origin's sitemap(s). Best for
  large documentation sites with a canonical index.

### Same-origin / include-exclude filters

Each crawl applies three filters, in order:

1. `same_origin` (default on) — drop off-host links.
2. `exclude_patterns` — any match drops the URL.
3. `include_patterns` — if provided, the URL must match at least one.

Patterns are standard JavaScript regular expressions, matched
case-insensitively against the full URL.

### Robots.txt & politeness

`RobotsParser` fetches and caches `robots.txt` per origin. Disallowed URLs
are skipped. `crawl-delay` directives are honored in addition to the built-in
500 ms politeness delay between requests to the same origin.

### Refresh

Sources can define an auto-refresh interval (daily, weekly, monthly). The
`WebScheduler` ticks every 5 minutes and kicks off any source whose
`next_scan_at` has elapsed. Manual rescan is always available from the UI.

## Storage layout

```
<userData>/ragraph/
└── web/
    └── <universeId>/
        └── <sourceId>/
            ├── example-com-docs-getting-started-abc12345.md
            └── …
```

Each Markdown file has a YAML frontmatter block with `title`, `source_url`,
`canonical_url`, `author`, `language`, `web_source_id`, and `fetched_at`.
The existing `Parser.parseMarkdown` picks this up automatically, so the
title, language, and URL propagate into graph metadata without any
pipeline changes.

## Limits & safety

| Limit              | Default | Hard cap                |
| ------------------ | ------- | ----------------------- |
| Max crawl depth    | 2       | 5                       |
| Max pages / source | 100     | 2000                    |
| Request timeout    | 20 s    | —                       |
| Max HTML size      | 4 MiB   | — (discarded when over) |
| Concurrency        | 2       | per-source              |

Non-HTML responses (`application/pdf`, images, …) are skipped — add a PDF
directly to a folder mount if you need it indexed. Pages that extract to
fewer than ~120 characters of Markdown are considered boilerplate (login
walls, 404s, cookie banners) and discarded.

## Troubleshooting

- **Source stuck in `error` state** — hover over the status badge to read
  the error. Common causes: invalid start URL, origin offline, or a robots.txt
  `Disallow: /` for our User-Agent.
- **No pages discovered** — a common culprit is `sameOrigin=true` combined
  with a URL that immediately redirects to a CDN origin. Disable
  `sameOrigin` or add a regex include-pattern.
- **Pages not refreshed** — the source may still be within its refresh
  interval. Use the rescan button to force a new run; crawler writes only
  when the content hash changes.
- **Duplicate-looking pages in the list** — a page whose canonical URL
  differs from its request URL keeps the request URL in `files.abs_path`
  but shows the canonical URL in the UI. This is expected.
