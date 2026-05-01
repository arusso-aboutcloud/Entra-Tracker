# Entra Tracker — Microsoft Entra ID Change Tracker

> Live tracker for Microsoft Entra ID retirements, breaking changes, preview features, and what's-new updates. Auto-updated every 4 hours from official Microsoft sources.

**Author:** [Antonio Russo](mailto:arusso@aboutcloud.io) · [aboutcloud.io](https://aboutcloud.io)

<p align="center">
  <a href="https://github.com/arusso-aboutcloud/Entra-Tracker/actions/workflows/trivy-scan.yml"><img src="./trivy-badge.svg" alt="Trivy Security Scan" height="24"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/sources-4-blue" alt="4 data sources">
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

A fully automated, €0/month change tracker that monitors four official Microsoft source repositories and RSS feeds for Entra ID updates — what's new, previews, retirements, and breaking changes. Every update is classified by type, service category, and impact, then served through a searchable, filterable web UI.

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

**Cron Trigger:** Every 4 hours — scrapes all 4 sources in parallel and refreshes KV.

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
Returns full article catalog with metadata. Supports search, filter by type/category, and date range.

---

## Data Sources

| # | Source | Type | Description |
|---|---|---|---|
| 1 | `entra-docs: fundamentals/whats-new.md` | Markdown | Core Entra ID + B2C/External ID what's-new |
| 2 | TechCommunity RSS | RSS | Entra blog announcements |
| 3 | `entra-docs: external-id/whats-new-docs.md` | Markdown | External ID docs changelog |
| 4 | `azure-docs: active-directory-b2c/whats-new-docs.md` | Markdown | B2C docs changelog |

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

---

## Frontend Features

- 🔍 Full-text search — across title, description, category, type
- 🏷️ Type filters — Preview, GA, Retirement, Breaking Change, Plan for Change
- 📂 Service category pills — filter by Entra service area
- 📅 Date range picker — scope by time period
- 📊 Stats bar — total items, breakdown by type
- 🔗 Crosslinks to aboutcloud.io and entraerrors.aboutcloud.io
- 🌙 Dark theme (Entra-inspired)

---

## Repo Structure

```
├── api/                  # Worker script
│   ├── worker.js         # Full worker source
│   └── wrangler.toml     # Worker configuration
├── web/                  # Pages frontend
│   ├── index.html        # Full frontend
│   └── wrangler.toml     # Pages configuration
├── .github/workflows/    # CI/CD
│   └── trivy-scan.yml    # Automated security scanning
├── architecture.svg      # Architecture diagram
├── trivy-badge.svg       # Auto-updated security badge
├── LICENSE
└── README.md
```

---

## Quick Start

1. **Clone:** `git clone https://github.com/arusso-aboutcloud/Entra-Tracker.git`
2. **Install Wrangler:** `npm install -g wrangler`
3. **Create KV namespace:** `wrangler kv:namespace create ENTRA_CACHE`
4. **Update `wrangler.toml`** with your KV namespace ID
5. **Deploy:** `wrangler deploy`

---

## License

MIT — see [LICENSE](./LICENSE) for full text.

> ⚠️ **Commercial use?** This project is free for personal, educational, and non-commercial use.  
> If you want to use it commercially (SaaS, managed service, reselling, or as part of a paid product),  
> please **[contact me](https://aboutcloud.io/contact)** first. I'm happy to discuss — just ask.

---

*Last reconciled: 2026-04-29*
