Real M365 Roadmap API response captured live 2026-08-16 via `curl` against
`https://www.microsoft.com/releasecommunications/api/v1/m365` (unauthenticated,
1813 total items at capture time). The real whats-new.md correlation text was
fetched the same day from the same raw URL `worker.js` actually uses
(`raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/fundamentals/whats-new.md`).
This satisfies the Phase 5 work order's rule 6: verify the real response shape
and real tag vocabulary against a live call before hardcoding anything.

## Real response shape, verified live (not assumed)

- Top level: a bare JSON array, not `{ items: [...] }`.
- Per item: `id` (number), `title`, `description`, `moreInfoLink` (string or
  `null` — populated on only 21/1813 items at capture time),
  `publicDisclosureAvailabilityDate` / `publicPreviewDate` (both
  `"<Month> CY<Year>"`, e.g. `"September CY2026"` — every non-empty
  occurrence across all 1813 items matched this exact shape, no variants),
  `created` / `modified` (ISO datetime), `status` (exactly 4 values seen:
  `Launched`, `In development`, `Rolling out`, `Cancelled`),
  `publicRoadmapStatus` (constant `"Include this month"` on every item —
  not a useful per-item signal, not used), `tags` (flat list) and
  `tagsContainer` (grouped: `cloudInstances`, `platforms`, `products`,
  `releasePhase`, each an array of `{tagName}`).
- The real product tag is `tagsContainer.products[].tagName === "Microsoft Entra"`
  (camelCase `tagsContainer`, not `TagsContainer`). 12 of 1813 items carried
  it at capture time. This is a cheap pre-filter only — every survivor still
  goes through the real Phase 2 taxonomy as the scoping authority.

## Files

- `roadmap-real-subset.json` — real, unmodified objects for all 12
  `Microsoft Entra`-tagged items live at capture time, plus 2 real
  non-Entra items (`Microsoft Teams`-tagged) to prove the product-tag
  pre-filter actually excludes something, plus 1 real `Cancelled`-status
  item (non-Entra) to prove the codebase's cancellation exclusion runs
  against genuine API data. No live item combined `Microsoft Entra` +
  `Cancelled` at capture time — see "Constructed fixtures" below for that
  specific combination.
- `whats-new-correlation-pair.md` — real, verbatim whats-new.md text (May
  2026 section) for "General Availability - Cross tenant group
  synchronization", trimmed to just that entry. Genuinely the same feature
  as real roadmap id `518221` ("Microsoft Entra: Cross-tenant security
  group synchronization") — confirmed by reading both descriptions, not
  guessed from title alone.

## The real correlation pair, and why `roadmapTitleSimilarity` is a
## separate function from the existing `titleSimilarity`

Roadmap id `518221` vs. the whats-new.md entry above, both genuinely about
the same feature:

| function | score |
|---|---|
| existing `titleSimilarity()` (Phase 0.1/1, backs the live 0.82/0.70 thresholds) | **0.25** |
| new `roadmapTitleSimilarity()` | **0.80** |

`titleSimilarity()` scores this real pair low because
`normalizeTitleForDedup()` strips hyphens entirely (`"Cross-tenant"` →
`"crosstenant"`, one token, which then can't match `"cross"` + `"tenant"` as
separate words in the other title), and because it doesn't strip either
source's own boilerplate ("General Availability -", "Microsoft Entra:").
Reusing it naively for roadmap correlation would have made a real,
genuine match look weak. Rather than touch `titleSimilarity()` /
`normalizeTitleForDedup()` — which back Phase 0.1's already-shipped,
already-tuned 0.82 cross-source-merge threshold and Phase 1's 0.70
title-reword threshold, both validated against their own real data —
`roadmapTitleSimilarity()` is a parallel function: hyphens become spaces
instead of being deleted, and a short explicit list of near-universal
lifecycle/product-label boilerplate words is stripped before scoring.

`STRONG_TITLE_DATE_SIMILARITY_THRESHOLD = 0.75` is set with margin below
this real pair's 0.80, the same "validate against one real pair, set the
bar with margin below it" methodology Phase 1 used for its 0.70 threshold
(real pair scored 0.75 there). The real pair's dates also independently
validate `ROADMAP_DATE_WINDOW_MONTHS = 1`: the roadmap states
`publicDisclosureAvailabilityDate: "April CY2026"` (→ 2026-04-30) while the
whats-new.md entry lives in the "## May 2026" section (`announcedDate:
2026-05-01`) — a genuine 1-month gap between two official Microsoft
channels describing the same feature, which is exactly the kind of
disagreement `ROADMAP_DATE_WINDOW_MONTHS` exists to tolerate for a
same-feature match (as opposed to `dateConflict`, which fires on an
already-*correlated* item's `deadline` disagreeing with the roadmap's
stated date — see below).

## Constructed fixtures (disclosed, not real captures)

The live roadmap API exposes no cross-reference field to any tracked
item's own id or an `MC\d{6,7}` message-center id, and a search across all
currently-live tracked source text found no real id references of either
kind (checked via regex against every current source fixture and via a
GitHub code search against `MicrosoftDocs/entra-docs`). `exact-id`
correlation, `dateConflict`, and the Entra+Cancelled combination therefore
have no real example to capture at this time. Per the work order's explicit
allowance for this case, the following are hand-constructed, clearly
disclosed as such (not presented as real Microsoft payloads), and used only
for logic that runs on already-parsed data:

- **Exact-id match**: a tracked item whose description contains the literal
  string "roadmap ID 518221" (a plausible but constructed way such a
  reference could appear in Microsoft prose), paired with the real roadmap
  id 518221 item from `roadmap-real-subset.json`.
- **`dateConflict`**: the same exact-id pair, but with the tracked item's
  `deadline` set several months apart from the roadmap's real stated date,
  to trigger the additive `dateConflict: true` flag.
- **Near-miss (sub-threshold, captured not asserted)**: two constructed
  titles verified to score `0.667` on `roadmapTitleSimilarity()` — clearly
  below the `0.75` bar, but with dates deliberately placed *within* the
  correlation window, so the test isolates title similarity as the only
  reason the pair doesn't correlate (not a coincidental date mismatch).
- **Entra-tagged + `Cancelled`**: a minimal constructed roadmap item
  reusing the same shape as a real one, with `status: "Cancelled"` and the
  real `Microsoft Entra` product tag, to prove the exclusion works for the
  one combination that didn't happen to exist live at capture time.

All constructed item-level fixtures live inline in
`api/worker.test.js`'s Phase 5 `describe` blocks, following the same
"item-level fixtures for logic that runs on already-parsed data must be
disclosed inline, not dressed up as real payloads" convention established
in Phase 0.1's dedupe fixtures.

## Funnel counts from the live 2026-08-16 fetch (full 1813-item response)

Recorded here for reference; the authoritative funnel report (re-run fresh
at PR time, piped through the real pipeline) is in the PR description.

- Total roadmap items: 1813
- Survive `tagsContainer.products[].tagName === 'Microsoft Entra'` pre-filter: 12
- Survive `status !== 'Cancelled'` (none of the 12 were Cancelled): 12
- Taxonomy match (all 12 are genuinely Entra ID roadmap items; see per-item
  status/title table below): expected 12, confirmed against the real
  pipeline in the PR's funnel report, not hand-counted here.

| id | status | title |
|---|---|---|
| 568076 | In development | Windows Hello for Business and macOS Platform SSO as MFA second factor |
| 566869 | In development | Upcoming changes to federatedTokenValidationPolicy default settings |
| 559476 | Launched | Account Discovery for Application Access Governance |
| 529856 | In development | ID Account Recovery |
| 545894 | Rolling out | App Deactivation |
| 529855 | In development | Conditional Access support for Entra ID Account Recovery |
| 536578 | In development | Microsoft Security Copilot App Lifecycle Management Agent in Microsoft Entra |
| 529857 | In development | ID Account Recovery (second, distinct roadmap entry) |
| 518221 | Launched | Cross-tenant security group synchronization (the real correlation pair) |
| 498158 | In development | Improved Backup and Restore Experience for the Authenticator App on iOS |
| 470023 | In development | Google to Entra Identity Sync service |
| 409529 | In development | Passkey authentication in brokered Microsoft apps on Android |

None of these 12 (other than 518221) has a matching item in the current
live `whats-new.md`/docs/changelog sources — each becomes a standalone
tier-A item under this phase's design (uncorrelated, but taxonomy-matched).
