# Entra Tracker — Microsoft Entra ID Change Tracker

> Live tracker for Microsoft Entra ID retirements, breaking changes, preview features, and what's-new updates. Auto-updated every 4 hours from official Microsoft sources.

**Live:** [entratracker.aboutcloud.io](https://entratracker.aboutcloud.io) | [tracker.aboutcloud.io](https://tracker.aboutcloud.io)  
**API:** `https://api.aboutcloud.io/entra-tracker`

---

## What It Does

A fully automated, €0/month change tracker that monitors four official Microsoft source repositories and RSS feeds for Entra ID updates — what's new, previews, retirements, and breaking changes. Every update is classified by type, service category, and impact, then served through a searchable, filterable web UI.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Microsoft Sources (GitHub raw + RSS)                         │
│                                                              │
│  1. entra-docs: fundamentals/whats-new.md                    │
│  2. techcommunity RSS (Entra blog)                           │
│  3. entra-docs: external-id/whats-new-docs.md                │
│  4. azure-docs: active-directory-b2c/whats-new-docs.md       │
└──────────────┬───────────────────────────────────────────────┘
               │ cron: 0 */4 * * *
               ▼
┌──────────────────────────────────────┐
│  Cloudflare Worker: entra-tracker    │
│  • Fetches 4 sources in parallel     │
│  • Parses Markdown + RSS + HTML      │
│  • Classifies: type, service, impact │
│  • Deduplicates across sources       │
│  • Writes to KV                      │
│  • Serves JSON API                   │
│                                      │
│  Handler: fetch + scheduled          │
│  Bindings: KV (ENTRA_CACHE)          │
└──────┬──────────────┬────────────────┘
       │              │
       ▼              ▼
┌──────────────┐  ┌──────────────────────────────┐
│  KV: ENTRA_  │  │  Cloudflare Pages             │
│  CACHE       │  │  entra-tracker.pages.dev      │
│              │  │  entratracker.aboutcloud.io    │
│  • v3        │  │  tracker.aboutcloud.io         │
│    (single   │  │                                │
│     key)     │  │  Static SPA:                   │
│              │  │  • Search + filter             │
│              │  │  • Type badges                 │
│              │  │  • Service category pills      │
│              │  │  • Date range picker           │
│              │  │  • aboutcloud.io crosslinks    │
│              │  │  • Structured Data (JSON-LD)   │
└──────────────┘  └──────────────────────────────┘
```

---

## Cloudflare Infrastructure

### Worker: `entra-tracker`

| Property | Value |
|---|---|
| **ID** | `entra-tracker` |
| **Handlers** | `fetch`, `scheduled` |
| **Compatibility date** | 2026-03-31 |
| **Versions** | 24 (latest: April 12, 2026) |
| **Deployed via** | Quick Editor (dashboard) |
| **Author** | russo.antonio76@gmail.com |

**Bindings:**

| Name | Type | Details |
|---|---|---|
| `ENTRA_CACHE` | KV Namespace | ID: `7f7ec741df00421cbdefc462630c7b75` |

**Cron Trigger:** `0 */4 * * *` (every 4 hours) — scrapes all 4 sources in parallel and refreshes KV.

### Pages: `entra-tracker`

| Property | Value |
|---|---|
| **Project name** | `entra-tracker` |
| **Domains** | `entra-tracker.pages.dev`, `entratracker.aboutcloud.io`, `tracker.aboutcloud.io` |
| **Deployment type** | Git-based (branch: main) |
| **Latest deployment** | April 13, 2026 |
| **Tech** | Static HTML + inline CSS/JS |

### KV: `ENTRA_CACHE`

**Namespace ID:** `7f7ec741df00421cbdefc462630c7b75`

**Key:** `entra_tracker_v3` — single-key storage containing all parsed articles and metadata.

---

## API

**Base URL:** `https://api.aboutcloud.io/entra-tracker`

### `GET /`
Returns full article catalog with metadata.

### Query Parameters
Supports search, filter by type/category, date range.

---

## Data Sources

| # | Source | Type | Description |
|---|---|---|---|
| 1 | `entra-docs: fundamentals/whats-new.md` | Markdown | Core Entra ID + B2C/External ID what's-new |
| 2 | TechCommunity RSS | RSS | Entra blog announcements |
| 3 | `entra-docs: external-id/whats-new-docs.md` | Markdown | External ID docs changelog |
| 4 | `azure-docs: active-directory-b2c/whats-new-docs.md` | Markdown | B2C docs changelog |

**Parsing strategies per source:**
- Source 1: H3 headings + `**Type:**` + `**Service category:**` blocks
- Source 2: Standard RSS XML
- Sources 3-4: Bullet `* [Title](url) - description`

---

## Classification

### Update Types
- **Preview** — public preview features
- **GA** — generally available
- **Retirement** — features being deprecated/retired
- **Breaking Change** — changes requiring action
- **Plan for Change** — upcoming changes
- **Updated** — documentation updates

### Service Categories
Tracked per item based on Microsoft's own categorization (e.g., Entra ID Protection, Conditional Access, External ID, B2C, etc.).

---

## Frontend Features

- 🔍 **Full-text search** — across title, description, category, type
- 🏷️ **Type filters** — Preview, GA, Retirement, Breaking Change, Plan for Change
- 📂 **Service category pills** — filter by Entra service area
- 📅 **Date range picker** — scope by time period
- 📊 **Stats bar** — total items, breakdown by type
- 🔗 **Crosslinks to aboutcloud.io** — related blog articles
- 🔗 **Links to entraerrors.aboutcloud.io** — error code reference
- 🌙 **Dark theme** (Entra-inspired)
- 📈 **Analytics** via aboutcloud.io analytics

---

## GitHub Repo

**Repo:** `arusso-aboutcloud/Entra-Tracker` (private)

Canonical source for the application. Code reconciled from Cloudflare on 2026-04-29.

### Structure

```
├── api/                  # Worker script
│   ├── worker.js         # Full worker source (604 lines)
│   └── wrangler.toml     # Worker configuration
├── web/                  # Pages frontend
│   ├── index.html        # Full frontend (1529 lines)
│   └── wrangler.toml     # Pages configuration
├── .gitignore
└── README.md
```

---

## Status

- ✅ **Worker** — live, cron active (every 4h), serving API
- ✅ **Pages** — live, 3 domains active
- ✅ **KV** — populated (single-key `entra_tracker_v3`)
- ✅ **Cron** — running every 4 hours
- ✅ **4 sources** — all fetched and parsed
- ✅ **GitHub synced** — worker, frontend, configs all in repo

---

*Last reconciled: 2026-04-29*
