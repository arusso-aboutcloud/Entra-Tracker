All fixtures in this directory are real, captured Microsoft text, trimmed. None are hand-written prose. Captured 2026-08-14.

| File | Source | Captured from |
|---|---|---|
| `agent-registry-retirement.txt` | `whats-new.md`, "Plan for change – Agent Registry consolidation into Microsoft Agent 365" | https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/fundamentals/whats-new.md (March 2026 section) |
| `pim-iteration2-graph-changelog.txt` | Graph changelog, PIM iteration 2 API deprecation | https://developer.microsoft.com/en-us/graph/changelog/rss (item pubDate 2025-11-18) — this is the actual "PIM iteration 2 API retirement" example referenced in `worker.js`'s own source comments |
| `sap-successfactors-deadline.txt` | `whats-new.md`, "Public Preview - Workload identity-based authentication for SAP SuccessFactors provisioning integrations" | same `whats-new.md` fetch, May 2026 section |
| `fslogix-rollout-language.txt` | FSLogix release notes, "upcoming change" callout | https://learn.microsoft.com/en-us/fslogix/overview-release-notes — exact text `parseFSLogixDocs`'s own `(action required|upcoming change)[^.]{0,500}` regex extracts today |
| `fslogix-no-date.txt` | FSLogix release notes, "Action required" callout | same fetch — exact text the same regex extracts for the second callout on the page |
| `iso-date-not-deadline-composite.txt` | **Composite of two real spans from the same live FSLogix page** — see below | same fetch |

## Why `iso-date-not-deadline-composite.txt` is a composite

The acceptance list requires "an ISO date present that is not the deadline". Searched all four live sources exhaustively on 2026-08-14 (1355-line `whats-new.md`, all 2552 Graph changelog items, the FSLogix release-notes page, `external-id-docs`, `b2c-docs`) for a naturally-occurring ISO-format (`yyyy-mm-dd`) date anywhere near retirement/breaking language. Found **zero** — Microsoft's actual changelog prose in this corpus exclusively uses "Month Day, Year" or "Month Year" phrasing. The only ISO-format dates found anywhere were page-footer "Last updated on yyyy-mm-dd" timestamps, which never occur close enough to a real callout to land in one contiguous capture.

`iso-date-not-deadline-composite.txt` is the real "Action required: Windows Kerberos hardening (RC4)..." callout sentence, verbatim, followed by the real "Last updated on 2026-03-30" footer sentence, verbatim, from the same live page — joined by a period. Every word is genuine, captured Microsoft text; only the **juxtaposition** is constructed, because no single real span combining both exists in the current corpus. This is flagged explicitly rather than silently presented as one untouched span, per the work order's "real, not synthetic" requirement — the goal there is avoiding invented phrasing that bakes in assumptions about what Microsoft's prose looks like, and both halves here are 100% authentic.

## Category assignments used in tests

- `agent-registry-retirement.txt`: `category = 'breaking'` (real `**Type:** Plan for change` → `TYPE_TO_CATEGORY['plan for change'] = 'breaking'`).
- `pim-iteration2-graph-changelog.txt`: `category = 'retirement'` (matches `parseGraphChangelog`'s fixed category for anything passing its deprecation filter).
- `sap-successfactors-deadline.txt`: `category = 'new_feature'` (real `**Type:** New feature`) — deliberately NOT retirement/breaking, to test that a non-retirement category still surfaces a `stated`-confidence deadline when the language genuinely supports it (`must upgrade ... before November 2026` is literally in `DEADLINE_LANGUAGE`).
- `fslogix-rollout-language.txt` / `fslogix-no-date.txt` / `iso-date-not-deadline-composite.txt`: `category = 'breaking'` (all three real texts contain "action required" / "Action required", which is `parseFSLogixDocs`'s own breaking-vs-preview rule).
