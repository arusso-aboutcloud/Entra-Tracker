# Entra Tracker — Microsoft Entra ID Change Tracker

> Live tracker for Microsoft Entra ID retirements, breaking changes, preview features, and what's-new updates. Auto-updated every 4 hours from official Microsoft sources.

**Author:** [Antonio Russo](mailto:arusso@aboutcloud.io) · [aboutcloud.io](https://aboutcloud.io)

<p align="center">
  <a href="https://github.com/arusso-aboutcloud/Entra-Tracker/actions/workflows/trivy-scan.yml"><img src="./trivy-badge.svg" alt="Trivy Security Scan" height="24"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/sources-6-blue" alt="6 data sources">
  <img src="https://img.shields.io/badge/update-every_4h-green" alt="Updated every 4 hours">
  <img src="https://img.shields.io/badge/cost-€0/month-brightgreen" alt="€0/month">
</p>

**Live:** [entratracker.aboutcloud.io](https://entratracker.aboutcloud.io) | [tracker.aboutcloud.io](https://tracker.aboutcloud.io)  
**API:** `https://api.aboutcloud.io/entra-tracker`

---

## Architecture

<p align="center">
  <img src="./architecture.svg" alt="Entra Tracker Architecture" width="720">
</p>

---

## What It Does

A fully automated, €0/month change tracker that monitors six official Microsoft sources for Entra ID updates -- what's new, previews, retirements, and breaking changes. Every update is classified by type, service category, and impact, then served through a searchable, filterable web UI.

---

## Security Scan

<p align="center">
  <a href="https://github.com/arusso-aboutcloud/Entra-Tracker/actions/workflows/trivy-scan.yml"><img src="./trivy-badge.svg" alt="Trivy Security Scan"></a>
</p>

This repository is continuously scanned by [Trivy](https://trivy.dev/) on every push and daily at midnight UTC. The badge above is **live** — it updates automatically via GitHub Actions after each scan.

<details>
<summary>📊 Latest Trivy Report (click to expand)</summary>

> Full results available in the [Actions tab](https://github.com/arusso-aboutcloud/Entra-Tracker/actions/workflows/trivy-scan.yml).

| Scanner | Status |
|---|---|
| Secrets | Scanned on every push |
| Misconfigurations | Scanned on every push |
| Vulnerabilities | Scanned on every push |

</details>

---

## Cloudflare Infrastructure

### Worker

| Property | Value |
|---|---|
| Handlers | `fetch`, `scheduled` |
| Compatibility date | 2026-03-31 |

**Bindings:**

| Name | Type | Details |
|---|---|---|
| `ENTRA_CACHE` | KV Namespace | Single-key cache of parsed articles + metadata |

**Cron Trigger:** Every 4 hours -- scrapes all 5 sources in parallel and refreshes KV.

**CI Deploy:** `.github/workflows/deploy-worker.yml` runs `wrangler deploy` automatically
on every push to `main` that touches `api/**`. Runs on Node.js 24 (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`
+ `wrangler-action@v4`). Requires two repo secrets set in
GitHub Settings > Secrets and variables > Actions:
`CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit permission) and `CLOUDFLARE_ACCOUNT_ID`.

**Worker secret:** `REFRESH_TOKEN` (optional but recommended) — set via
`wrangler secret put REFRESH_TOKEN --config api/wrangler.toml` or the Cloudflare
dashboard. Gates the `?refresh=1` bypass; without it, `refresh=1` is ignored.

**Deploy runbook — do this after any deploy that touches cache-write timing
or identity/dedup logic (worth doing after any deploy, cheap either way):**
once `REFRESH_TOKEN` is set, call `?refresh=1` with the correct
`X-Refresh-Token` header immediately after the deploy finishes. This forces
the KV entry to rewrite under the new code *before* the next natural 4h
cron cycle, carrying `firstSeen` forward under the new logic instead of
leaving the old entry's TTL/format to run out on its own. This would have
prevented the 2026-08-14 cold start documented in PR #22 — the fix that
shipped in that PR only governs writes made after it deployed, so the
already-in-flight entry (written by the pre-fix code, with the old 4h TTL
already counting down) expired on schedule regardless, one cron cycle
after the fix landed, and forced exactly one more cold start before the
new logic took over.

### Pages

| Property | Value |
|---|---|
| Deployment type | Git-based (branch: main) |
| Tech | Static HTML + inline CSS/JS |

### KV: `ENTRA_CACHE`

**Key:** `entra_tracker_v3` — single-key storage containing all parsed articles and metadata.

---

## API

**Base URL:** `https://api.aboutcloud.io/entra-tracker`

### `GET /`
Returns full article catalog with metadata.

**Query parameters:**

| Parameter | Values | Description |
|---|---|---|
| `format` | `csv` | Return dataset as CSV instead of JSON. Reuses cached data — does not trigger a re-fetch. Columns: `title,category,impact,status,announcedDate,firstSeen,deadline,daysRemaining,namespace,link`. Response includes `Content-Disposition: attachment; filename="entra-tracker.csv"`. |
| `format` | `rss` | Return top 50 items as RSS 2.0 feed, newest-first by `firstSeen`. Reuses cached data. `Content-Type: application/rss+xml`. Respects `namespace` filter. |
| `namespace` | `external-id` | Filter items to External ID namespace only. Works with JSON, CSV, and RSS formats. |
| `refresh` | `1` | Bypass KV cache and force a fresh fetch from all sources. **Requires** an `X-Refresh-Token` request header matching the `REFRESH_TOKEN` secret; if that secret isn't configured, `refresh=1` is silently ignored and the cached response is served instead. |

**`announcedDate` field:** Each item now includes `announcedDate` (ISO `yyyy-mm-dd` or `null`). Populated from the `## Month YYYY` section header in whats-new.md / docs changelogs, the commit date in the commits source, or the RSS pubDate. This is the publication/announcement date only — it never becomes a deadline.

**`dedupeDropped` field:** The envelope includes a `dedupeDropped` count from dedupe **stage 1** — items collapsed because the *same source* reported the exact same normalised title more than once in one build. This should be near-zero in normal operation (it indicates a parser emitting a genuine repeat, e.g. a stray re-scan of a block); a persistently nonzero value is worth investigating, not expected.

**`crossSourceMerged` field:** The envelope includes a `crossSourceMerged` count from dedupe **stage 2** — items that were the *same underlying change reported by more than one Microsoft source* (e.g. both `whats-new.md` and a docs changelog cover the same retirement) and were merged into a single item. Unlike `dedupeDropped`, a nonzero `crossSourceMerged` is expected and routine — it's the normal case for changes that get dual coverage. Merged items keep the existing scalar `source`/`link` fields pointing at the highest-provenance contributor, and add `sources: []` / `links: []` arrays listing every source that reported the change. `external-id-commits` items are exempt from stage 2 in both directions (never merged into another source's item, never absorb one) since they're a pre-changelog how-to watch, not independent coverage of the same announcement.

**Cache behavior:** The HTTP `Cache-Control: max-age` and the underlying KV entry's TTL are decoupled. Responses are cached for 4 hours (matching the cron refresh interval), but the KV entry itself persists for 30 days as a backstop — so a single missed or failed cron run no longer expires the cache and forces a cold start (which would reset every item's `firstSeen` and republish the whole feed as "new").

**CORS:** every response (including 404s and errors) carries `Access-Control-Allow-Origin` for the caller's origin plus `Vary: Origin`, so shared/edge caches key on the request origin instead of serving one origin's CORS headers to another.

**Deadline fields (`deadlineConfidence`, `deadlineEvidence`, `deadlinePrecision`):** every item's deadline now comes with how sure the tracker is about it. `deadlineConfidence` is `'stated'` (an explicit cessation phrase — "retired", "deprecated", "must migrate" — in the same sentence as the date), `'derived'` (cutoff language nearby but not same-sentence), `'inferred'` (the best candidate found, but without clear supporting language), or `null` (no date found at all). `deadlineEvidence` is the literal sentence the date was taken from. `deadlinePrecision` is `'day'` or `'month'` depending on how precisely Microsoft stated it. The frontend does not render a countdown for `'inferred'` — it shows the date with an explicit "unconfirmed" hedge instead. See `/methodology` in the web UI for the plain-language version.

**`evidence` field:** every item carries `evidence: { tier, basis, quote, sourceUrl }` recording how strong Microsoft's own signal was. `tier` is `'A'` (structured metadata — a `**Type:**` block or a Graph changelog deprecation), `'B'` (official documentation content without structured metadata), or `'C'` (a repo signal that a document moved — an indicator, not an announcement; currently only the `external-id-commits` source). `basis` is the specific mechanism: `'ms-type-field' | 'graph-changelog' | 'doc-callout' | 'repo-signal' | 'keyword-heuristic'`. Cross-source merges now rank by tier first (A beats B beats C), falling back to the fixed source-priority table only to break ties within the same tier.

**`sources`/`links` arrays and `titleHistory`:** unchanged from Phase 0.1's cross-source merge — see that section below. `titleHistory: []` is new: when an item's title is reworded between two builds (Microsoft edits a whats-new.md heading) and the tracker's similarity matching recognises it as the same item, the prior title is appended here and `firstSeen` carries forward instead of resetting.

**`firstSeenEstimated` field:** `true` when `firstSeen` was estimated from `announcedDate` during a cold start (no usable prior snapshot) rather than observed directly; `false` otherwise, including for every item in normal operation. See "Cold-start firstSeen repair" below.

**Item identity (`id`):** composed from `source` + `link` + normalised title (previously a bare hash of the title, with ad hoc per-parser prefixes). The format is unchanged (8 hex characters). A rewording of an item's title is now tolerated via similarity matching (same source, same `announcedDate` month, title similarity ≥0.70 — validated against a real MicrosoftDocs heading-rename commit, see `api/worker.js`'s `TITLE_REWORD_SIMILARITY_THRESHOLD` comment) rather than minting a new id and resetting `firstSeen`.

**Cold-start `firstSeen` repair:** on a cold start (no usable prior snapshot — see Cache behavior above), each item's `firstSeen` is seeded from its `announcedDate` when that's in the past, rather than flattened to the day of the cold start for every item at once (the failure mode documented in PR #22, 2026-08-14). Items without a usable `announcedDate` still fall back to the cold-start date. The RSS feed also now falls back to `announcedDate` as a secondary sort key when `firstSeen` values tie, so a future cold start degrades to an estimated-but-ordered feed instead of collapsing to arrival order.

**Threshold note:** the cross-source merge similarity threshold (0.82, Phase 0.1) has only ever fired on hand-built fixtures — `crossSourceMerged` has been 0 against live data every time it's been checked so far. The first time it fires for real, the merge should be spot-checked before being trusted; don't tune the threshold without that evidence.

---

## Data Sources

All sources are Microsoft-official (MicrosoftDocs GitHub repos + learn.microsoft.com).

| # | Source | Type | Description |
|---|---|---|---|
| 1 | `entra-docs: fundamentals/whats-new.md` | Markdown | Core Entra ID + B2C/External ID what's-new (primary source) |
| 2 | `learn.microsoft.com: FSLogix release notes` | HTML | Azure Files / Entra Kerberos breaking-change callouts (`is-warning`/`is-important` alerts + "action required" notices) |
| 3 | `entra-docs: external-id/whats-new-docs.md` | Markdown | External ID docs changelog (`- [Title](url)` bullets) |
| 4 | `azure-docs: active-directory-b2c/whats-new-docs.md` | Markdown | B2C docs changelog (B2C is end-of-sale; winding down) |
| 5 | `entra-docs: commits — external-id/customers` | GitHub Commits API | External ID customer how-tos (direct repo watch, pre-changelog) — catches passkey/FIDO2 guides before MS adds them to the curated index |
| 6 | `developer.microsoft.com: Graph changelog` | RSS | Microsoft Graph API resource/endpoint **deprecations** (e.g. the PIM iteration 2 API retirement). The feed is a 2500+ item firehose, so it is filtered to Entra-relevant resource/API-level deprecations only (headline-sentence match + recency/deadline gate) — typically 1–3 high-signal items. |

Changelog parsers track raw-entry counts; if a source matches zero entries the API response includes a `warnings[]` entry so upstream format drift surfaces instead of failing silently.

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
Tracked per item based on Microsoft's own categorization (Entra ID Protection, Conditional Access, External ID, B2C, etc.).

### Evidence Tiers
Every item also carries a Tier A/B/C badge recording how strong Microsoft's own signal was for its classification — see the `evidence` field above, or the `/methodology` section in the web UI for the plain-language version aimed at Entra admins rather than developers.

---

## Frontend Features

- 🔍 Full-text search — across title, description, category, type
- 🏷️ Type filters — Preview, GA, Retirement, Breaking Change, Plan for Change
- 📂 Service category pills — filter by Entra service area
- 📅 Date range picker — scope by time period
- 📊 Stats bar — total items, breakdown by type
- 🔗 Crosslinks to aboutcloud.io and entraerrors.aboutcloud.io
- 🌙 Dark theme (Entra-inspired)
- 📣 Announced date display — cards without a deadline show "Announced Mon YYYY" instead of an empty right panel
- 🔃 Newest-announced sort — sort the entire feed by `announcedDate` descending to see what's freshest
- ⭐ On Radar (client-side watchlist) — star any item to add it to your personal watchlist; persisted in `localStorage` under key `entratracker_radar`; filter to starred items with the "On Radar" toggle; cross-device sync is out of scope (see ROADMAP.md)
- 📡 Subscribe / Export — popover button surfacing RSS feeds (full and External ID), CSV export, and JSON API with one-click copy-to-clipboard for pasting into RSS readers, Teams, Power Automate, and spreadsheets
- 🅰️ Evidence tier badge (Tier A/B/C) on every card — how strong Microsoft's own signal was; see the `/methodology` section for what each tier means
- ⏳ Deadline confidence hedge — cards with an `'inferred'`-confidence deadline show the date plainly ("possible date … unconfirmed") instead of a countdown, since a countdown implies more certainty than the source text actually supports
- 📊 Methodology section — collapsible, plain-language explanation of evidence tiers and deadline confidence, written for an Entra admin rather than a developer

---

## Repo Structure

```
├── api/                  # Worker script
│   ├── worker.js         # Full worker source
│   ├── worker.test.js    # Node test-runner unit tests (node --test)
│   ├── __fixtures__/     # Checked-in fixtures for parser/scoring tests
│   │   ├── dedupe/       # Item-level fixtures (dedupe/merge logic, Phase 0.1)
│   │   ├── deadline/     # Real captured Microsoft text (deadline scoring, Phase 1)
│   │   ├── identity/     # Real title-rewording cases (item identity, Phase 1)
│   │   └── evidence/     # Cross-source tier-ranking fixture (Phase 1)
│   ├── package.json      # type:module marker for the test runner (no deps)
│   └── wrangler.toml     # Worker configuration
├── web/                  # Pages frontend
│   ├── index.html        # Full frontend
│   └── wrangler.toml     # Pages configuration
├── scripts/               # Repo maintenance scripts
│   └── generate_trivy_badge.py  # Renders trivy-badge.svg from scan results
├── .github/workflows/    # CI/CD
│   ├── deploy-worker.yml # Deploys the Worker to Cloudflare on push to main
│   └── trivy-scan.yml    # Automated security scanning
├── architecture.svg      # Architecture diagram
├── trivy-badge.svg       # Auto-updated security badge
├── LICENSE
├── README.md
└── ROADMAP.md
```

---

## Quick Start

1. **Clone:** `git clone https://github.com/arusso-aboutcloud/Entra-Tracker.git`
2. **Install Wrangler:** `npm install -g wrangler`
3. **Create KV namespace:** `wrangler kv:namespace create ENTRA_CACHE`
4. **Update `wrangler.toml`** with your KV namespace ID
5. **Deploy:** `wrangler deploy`
6. **Run tests:** `cd api && node --test` (no install step — zero runtime dependencies)

---

## License

MIT — see [LICENSE](./LICENSE) for full text.

> 💼 **Using this commercially?** MIT licensed and free for personal, educational, and open-source projects.  
> Building something commercial (SaaS, managed services, reselling)? I'd love to chat —  
> [contact me](https://aboutcloud.io/author/)

---

*Last reconciled: 2026-08-14*
