# Blog posts

Public posts for <https://hitly.net/blog>. Everything on the blog is derived from the
`.mdx` files in this directory — index page, sitemap, RSS feed, JSON-LD. To publish a
post, drop a file here and merge.

## Start a new post

```bash
# from the repo root
yarn blog:new "Your post title"        # publishes when merged
yarn blog:new "Your post title" --draft # hidden until draft: false
```

This scaffolds `<slug>.mdx` with a valid frontmatter skeleton. Or copy an existing
post and edit it.

## Frontmatter

```yaml
---
title: "Post title (becomes the H1, meta title, OG title)"
description: "One-line summary, 60-160 characters. Used for meta description, OG, RSS."
date: 2026-11-25 # ISO date, required. Sorts the index and feeds the feeds.
updated: 2026-12-01 # optional ISO date for material edits
tags: ["regulation"] # optional; shown on the post, no tag pages yet
draft: true # optional, default false
---
```

The schema is validated at build time (`source.config.ts`): a bad `description`
length or a malformed `date` fails the build rather than shipping a broken page.

## Voice and accuracy — read before writing

- HITLy is a **technology provider**. It is not authorised or regulated by the FCA,
  is not a law firm, and makes **no compliance claims**. Never write that HITLy
  "makes you compliant", "meets Article 14", or "satisfies the FCA". Describe what
  the product does (approval inbox, durable trace, governance rules) and let readers
  draw conclusions with their own advisers.
- The standing disclaimer is rendered automatically under every post and the index
  (`BLOG_DISCLAIMER` in `lib/blog.ts`). Do not paste a variant into the post body.
- Cite **official sources only** with their URLs, and quote sparingly (short
  verbatim quotes with the page linked). Regulator dates must be read from the
  official page — do not invent or approximate publication dates.
- Allowed external domains (enforced by tests): `fca.org.uk`, `esma.europa.eu`,
  `eba.europa.eu`, `eiopa.europa.eu`, `eur-lex.europa.eu`,
  `ec.europa.eu`, `europa.eu`, `digital-strategy.ec.europa.eu`. Internal links use
  site-relative paths (`/docs/trace`, not `https://hitly.net/docs/trace`).
- No code, imports, or JSX in post bodies (enforced by tests): plain markdown,
  headings, lists, tables, blockquotes, links. The disclaimer, JSON-LD, and chrome
  are all provided by the page template — posts are content only.
- Spelling: **HITLy** (capital H, capital L, lowercase y). `HITLy™` on first mention
  in a post. Never use `®`. Follow `docs/news/` changelogs for tone: hedged, no
  claims about deployment status unless the docs say so.

## Drafts, corrections, rollback

- `draft: true` excludes a post from the index, sitemap, RSS, and its page 404s.
  **It is still in git history** — do not use drafts to stage anything you would not
  want recoverable from a public repo forever.
- Corrections: fix the file and set `updated:`. The URL never changes (stable slugs
  are an SEO requirement), so prefer editing over renaming.
- Withdrawal: delete the file (or set `draft: true`) and revert. Like everything in a
  public repo, treat any published claim as permanent in history.

## Publish checklist

1. `yarn workspace @hitly/web test` from the repo root (validates frontmatter, links,
   corpus rules, feed, JSON-LD).
2. `yarn dev` in `apps/web`, view `/blog/<slug>` — check the H1, date, disclaimer.
3. Grep the post for banned words the tests may not know about (internal hostnames,
   unreleased product names, customer names).
4. Never put secrets, internal hostnames, or customer data in a post or its images.
   This repository is public under Apache-2.0 — the repo `LICENSE` covers code;
   blog prose is HITLy editorial content (see repo `README` / legal page).
