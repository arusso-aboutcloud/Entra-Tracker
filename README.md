# Entra ID Change Tracker

> Live tracker for Microsoft Entra ID retirements, breaking changes, previews, and roadmap items — auto-updated every 4 hours from 7 official Microsoft sources, with deadline-slip history.

**Author:** [Antonio Russo](mailto:arusso@aboutcloud.io) · [aboutcloud.io](https://aboutcloud.io)

<p align="center">
  <a href="https://github.com/arusso-aboutcloud/Entra-Tracker/actions/workflows/trivy-scan.yml"><img src="./trivy-badge.svg" alt="Trivy Security Scan" height="24"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/sources-7-blue" alt="7 data sources">
  <img src="https://img.shields.io/badge/update-every_4h-green" alt="Updated every 4 hours">
  <img src="https://img.shields.io/badge/cost-€0/month-brightgreen" alt="€0/month">
</p>

**Live:** [entratracker.aboutcloud.io](https://entratracker.aboutcloud.io) ([tracker.aboutcloud.io](https://tracker.aboutcloud.io))
**API:** `https://api.aboutcloud.io/entra-tracker`

---

## What it does

Monitors seven official Microsoft sources — `whats-new.md`, docs changelogs, the Graph API changelog, the Microsoft 365 Roadmap, and more — for anything affecting Entra ID: previews, GA, retirements, breaking changes, and roadmap items. Every update is classified by type, service area, and evidence strength (how confident the tracker is that Microsoft actually said what it thinks it said), deduplicated across sources, and served through a searchable, filterable web UI. Deadline changes are tracked over time in D1, so an item that slipped its date shows the full history, not just the current one.

<p align="center">
  <img src="./architecture.svg" alt="Entra Tracker Architecture" width="720">
</p>

---

## Key features

- **Unified filter bar** — urgency, change type, and service area, all multi-select and freely combinable, with every active filter shown as a removable pill
- **Deadline-slip history** — a "Revised" badge on any item whose deadline has genuinely changed since first observed; expand a card for the full timeline (`Jun → Oct → Mar`)
- **Evidence tiers (A/B/C)** — every item is labeled by how strong Microsoft's own signal was, not just classified silently
- **Degraded-source detection** — if a source's parser starts returning far fewer items than usual, that source falls back to last-known-good data and says so, instead of silently losing items
- **On Radar** — star items into a personal, `localStorage`-only watchlist
- **Subscribe & export** — RSS, CSV, JSON, and a full `.ics` calendar feed (one event per deadline, reminders included) — see below
- **Roadmap correlation** — Microsoft 365 Roadmap entries are matched to the corresponding tracked item where the evidence is strong, shown as a supplementary "likely related" or confirmed tag
- Dark theme, `prefers-reduced-motion`-respecting, zero infinite-loop decorative animation

Full engineering history and design rationale for all of the above: [ROADMAP.md](./ROADMAP.md).

---

## API

**Base URL:** `https://api.aboutcloud.io/entra-tracker`

| Endpoint | Returns |
|---|---|
| `GET /` | Full article catalog with metadata |
| `GET /taxonomy` | The 14-entry service-area taxonomy every item is classified against |
| `GET /health` | Per-source health — last success time, item-count ratio vs. trailing median, degraded flag |
| `GET /entra-tracker/history/:itemId` | Full revision log + deadline-change history for one item |

**Query parameters** (on `GET /`): `format=csv\|rss\|ics` to export instead of JSON · `namespace=external-id` to scope to External ID only · `refresh=1` (requires an `X-Refresh-Token` header) to force a live re-fetch.

Every item carries `deadlineConfidence` (`stated`/`derived`/`inferred`), `evidence` (`{tier, basis, quote, sourceUrl}`), `deadlineChangeCount`, and `announcements[]` (correlated Roadmap entries) — see `/methodology` in the web UI for the plain-language version, or `api/worker.js` for the field-level implementation.

---

## Data sources

All Microsoft-official — no scraping of unofficial mirrors.

| # | Source | Type |
|---|---|---|
| 1 | `entra-docs: fundamentals/whats-new.md` | Markdown (primary) |
| 2 | `learn.microsoft.com`: FSLogix release notes | HTML |
| 3 | `entra-docs: external-id/whats-new-docs.md` | Markdown |
| 4 | `azure-docs: active-directory-b2c/whats-new-docs.md` | Markdown |
| 5 | `entra-docs` commits: `external-id/customers` | GitHub Commits API |
| 6 | Microsoft Graph API changelog | RSS |
| 7 | Microsoft 365 Roadmap | JSON API |

---

## Repo structure

```
├── api/                  # Worker script (fetch + scheduled handlers)
│   ├── worker.js
│   ├── worker.test.js    # node --test, zero runtime dependencies
│   ├── __fixtures__/     # Real captured Microsoft text, used by the tests above
│   ├── migrations/        # D1 schema (forward-only)
│   └── wrangler.toml
├── web/                  # Pages frontend (single-file HTML/CSS/JS)
├── scripts/               # Repo maintenance (Trivy badge generation)
├── .github/workflows/    # Worker deploy + Trivy scan
├── architecture.svg
├── ROADMAP.md            # Shipped work + engineering rationale
└── LICENSE
```

---

## Quick start

```bash
git clone https://github.com/arusso-aboutcloud/Entra-Tracker.git
npm install -g wrangler
wrangler kv:namespace create ENTRA_CACHE   # then set the id in api/wrangler.toml
wrangler deploy --config api/wrangler.toml
cd api && node --test                      # no install step, zero dependencies
```

---

## Related aboutcloud.io tools

| Tool | What it does |
|---|---|
| [Entra RoleLens](https://entrarolelens.aboutcloud.io) ([source](https://github.com/arusso-aboutcloud/Entra-Rolelens)) | Least-privilege Entra ID role finder — task → minimum built-in role |
| [EntraPass](https://entrapass.aboutcloud.io) ([source](https://github.com/arusso-aboutcloud/EntraPass)) | Passkey (FIDO2) readiness scanner for Entra ID tenants |
| [AADSTS Entra Errors](https://entraerrors.aboutcloud.io) ([source](https://github.com/arusso-aboutcloud/AADSTS-Entra-Errors)) | Searchable AADSTS error code reference |
| [CROSSEC](https://crossec.aboutcloud.io) ([source](https://github.com/arusso-aboutcloud/crossed)) | Microsoft Cloud security crossword game |

---

## License

MIT — see [LICENSE](./LICENSE) for full text.

> 💼 **Using this commercially?** MIT licensed and free for personal, educational, and open-source projects. Building something commercial (SaaS, managed services, reselling)? [Let's talk](https://aboutcloud.io/author/).
