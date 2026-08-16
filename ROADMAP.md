# Entra Tracker -- Roadmap

## Shipped

- [x] Passkey / FIDO2 External ID coverage -- title-keyword classification (`passkey`, `fido2`,
  `webauthn`, `native auth`, `native authentication`) added to `EXTERNAL_ID_TITLE_KEYWORDS`.
  Reclassification is title-only; workforce passkey items are not blanket-reclassified because
  their service category ("Authentications (Logins)") is a workforce signal.
- [x] Source 5: entra-docs commit watch on `external-id/customers` -- surfaces passkey/FIDO2
  how-to articles before Microsoft adds them to the curated `whats-new-docs.md` index.
- [x] `announcedDate` field -- ISO date populated from section month headers, commit dates,
  and RSS pubDates. Displayed as "Announced Mon YYYY" on cards without a deadline.
- [x] Newest-announced sort -- client-side sort option; server tiebreak also uses `announcedDate`.
- [x] CSV export -- `GET /entra-tracker?format=csv` returns all items as downloadable CSV.
- [x] On Radar client-side watchlist -- star items, persisted in `localStorage`, filterable.
- [x] Reliability fixes (Phase 0) -- KV `expirationTtl` decoupled from HTTP `max-age` so a
  missed cron no longer forces a cold start; `Vary: Origin` on all CORS responses;
  `?refresh=1` gated behind a `REFRESH_TOKEN` secret; dedup keyed on the full normalised
  title scoped by source (was a 60-char prefix, which collided) with a `dedupeDropped`
  counter surfaced in the envelope.
- [x] Two-stage dedupe (Phase 0.1) -- Phase 0's source-scoped dedupe correctly stopped
  distinct items colliding but also stopped the SAME change (reported by more than one
  Microsoft source) from being merged, so items in both `whats-new.md` and a docs
  changelog started appearing twice. Restored cross-source merging as its own stage:
  intra-source exact dedupe (`dedupeDropped`) is now separate from cross-source merge
  (`crossSourceMerged`), which adds `sources: []`/`links: []` to merged items and ranks
  sources by provenance to decide which one's fields survive. `external-id-commits`
  items are exempt from cross-source merging in both directions. First fixture-tested
  logic in the repo (`api/worker.test.js`, `api/__fixtures__/dedupe/`).
- [x] Deadline scoring rewrite (Phase 1a) -- `extractDeadline` replaced with a candidate
  scorer: collects every date in the text (not just the first format-precedence match),
  scores each by proximity to cutoff vs. rollout language, same-sentence cessation verbs,
  precision, and future/past, and picks the best rather than accepting any date
  unconditionally for retirement/breaking. Emits `deadlineConfidence`
  (`stated`/`derived`/`inferred`), `deadlineEvidence` (the source sentence), and
  `deadlinePrecision` (`day`/`month`). Fixture-tested against real captured Microsoft
  text only (`api/__fixtures__/deadline/`) -- no hand-written prose, per the risk that
  synthetic fixtures bake in the author's own assumptions about what Microsoft's text
  looks like.
- [x] Item identity rewrite (Phase 1b) -- `id` now composed from `source` + `link` +
  normalised title (was a bare title hash with ad hoc per-parser prefixes). A title
  reworded by Microsoft between builds is caught by a similarity match (same source,
  same `announcedDate` month, similarity ≥0.70 -- validated against a real
  MicrosoftDocs heading-rename commit) instead of resetting `firstSeen`; the prior
  title is recorded in a new `titleHistory: []`.
- [x] Classification provenance (Phase 1c) -- every item carries `evidence: {tier,
  basis, quote, sourceUrl}`. Cross-source merges (Phase 0.1) now rank by evidence tier
  first, falling back to the fixed source-priority table only within a tier -- the
  wholesale swap Phase 0.1 anticipated.
- [x] Cold-start `firstSeen` repair (Phase 1e) -- on a cold start, `firstSeen` is now
  estimated from `announcedDate` per item (flagged `firstSeenEstimated: true`) instead
  of flattening every item to the cold-start date, which is what actually happened on
  2026-08-14 (see PR #22's verification table). RSS ordering now falls back to
  `announcedDate` when `firstSeen` values tie, so a future cold start degrades to an
  estimated-but-ordered feed instead of arrival order.
- [x] Frontend: Tier A/B/C badge on every card, no countdown for `inferred`-confidence
  deadlines (shown as a hedged date instead), and a `/methodology` section explaining
  tiers and confidence levels for an Entra admin audience.
- [x] Service taxonomy (Phase 2) -- centralised the scoping logic that used to live
  separately in `GRAPH_ENTRA_RE`, `EXTERNAL_ID_SERVICE_CATEGORIES`/`EXTERNAL_ID_TITLE_KEYWORDS`
  (the constants referenced above, now folded into `SERVICE_TAXONOMY`'s `entra-external-id`
  entry), and Microsoft's own 30+ raw `whats-new.md` category strings shown as-is, into
  one 14-entry taxonomy exposed at `GET /taxonomy`. Every item now gets a normalised
  `serviceCategory` (canonical name) plus an additive `serviceCategories: []` of every
  match. An item matching nothing is dropped and counted (`unmatched`/`unmatchedSamples`
  on the envelope) rather than silently disappearing. Verified against a fresh live
  fetch of all 5 sources: **zero items dropped**, `namespace` assignment byte-for-byte
  unchanged, 99 of 105 items' `serviceCategory` string changed (expected -- the
  normalisation this phase exists to do; see `api/__fixtures__/taxonomy/README.md` for
  the full mapping). Classification building surfaced and fixed three real bugs from
  naive substring matching (`signin` inside `assigning`, `provisioning` inside
  `cloudPcProvisioningPolicy`, and incidental in-body mentions of unrelated features
  outranking an item's real Microsoft-assigned category) -- documented in the same
  fixture README as regression guards. Frontend: a service-area filter dropdown
  (`web/index.html`, sourced live from `GET /taxonomy`) and a `/methodology` coverage
  statement -- the README previously advertised "service category pills" that, on
  inspection, did not exist in the code; this is the actual first implementation,
  flagged as a correction rather than silently built over the stale claim.
- [x] D1 revision store, write-path only (Phase 3) -- lands early on purpose:
  deadline-slip history can't be reconstructed retroactively, so recording starts
  now even though nothing reads it until Phase 4/5. New D1 database
  `entra-tracker-history` (binding `TRACKER_DB`), one `item_revisions` table
  (`api/migrations/0001_create_item_revisions.sql`). On each build, a row is
  inserted only when an item's tracked fields (title/category/status/deadline/
  deadlineConfidence/announcedDate/serviceCategory) actually changed since its
  last stored revision -- unchanged items write nothing, and `changed_fields`
  records what did. Strictly non-fatal: every D1 access is wrapped so a failure
  can never touch the KV write or the API response, and diagnostics go to the
  console log only, never into `warnings[]`, so the envelope stays byte-for-byte
  unchanged in every scenario -- proved with a dedicated test that runs a full
  build against a D1 binding that throws on every call. No read endpoint, no
  frontend change, no API response change -- deliberately out of scope this phase.
  Verified against a real fetch, piped through the real parsers/taxonomy/dedupe,
  written to the actual production D1: 12 real items -> 12 rows on the first
  build, confirmed 0 new rows on an identical second build. Also caught and
  fixed a real edge case live: the initial latest-revision query tiebroke on
  `observed_at`, which isn't guaranteed unique (a dropped-connection retry
  during testing produced two rows sharing a timestamp) -- switched to the
  autoincrement `id` column, which is. **Confirmed the deployed write path
  landed cleanly on its first real production build** (Phase 4 development):
  103 distinct items, 103 rows, closing that open item from the Phase 3 PR.
- [x] Degraded mode + `GET /health` (Phase 4) -- "never lie quietly": if a source
  silently returns far fewer items than usual (parser broke, HTML restructured),
  the previous good snapshot's items for that source are retained (flagged
  `stale: true`) instead of publishing a shrunken feed, and the source is
  named in a new envelope array `degraded: []`. Detection compares each
  source's raw parse count against a trailing median of its last 7 successful
  builds (stored in KV, deliberately not D1 -- D1 is allowed to fail
  non-fatally, health monitoring shouldn't be tied to the one store designed
  to be ignorable); a drop below 50% of the median trips it, except for
  small-N sources (median <=5 -- `fslogix-docs`/`external-id-docs`/
  `graph-changelog` normally run this low, `b2c-docs` legitimately sits near
  zero) which are exempt from the ratio test entirely so ordinary noise never
  false-trips it. A degraded build does not update its own trailing baseline.
  New `GET /health` endpoint: no auth, a single cheap KV read, never fetches
  a source or triggers a rebuild -- proved with a test that calls the real
  route with `fetch()` set to throw on any call. Frontend: a plain
  (non-alarming, yellow not red) banner naming the affected source(s), and
  per-source last-success timestamps in the footer. Optional
  `DEGRADED_WEBHOOK_URL` env var (Antonio sets it, absent = off) fires once
  per source on the transition *into* degraded, not every build while still
  degraded. Rollout behaviour stated explicitly: a source's first-ever build
  (empty trailing history) is never flagged degraded -- there's nothing to
  compare against yet -- and the window fills over ~7 successful builds
  (~28h at the 4h cron cadence). 83 tests total (64 pre-existing unaffected,
  19 new), including a dedicated test proving the full API envelope is
  byte-for-byte unchanged (only the additive `degraded`/`stale` fields added)
  whether the health-state KV read succeeds, fails, or the key doesn't exist yet.

- [x] Microsoft 365 Roadmap source, conservatively correlated (Phase 5) -- adds
  `https://www.microsoft.com/releasecommunications/api/v1/m365` as a 7th source
  (label `m365-roadmap`). Real response shape and product-tag vocabulary
  verified against a live call before writing any parsing code (not assumed):
  a bare JSON array, `tagsContainer.products[].tagName === "Microsoft Entra"`
  as the real identity product tag (12 of 1813 items at capture time),
  `status` a 4-value enum (`Launched`/`In development`/`Rolling out`/
  `Cancelled`, the last excluded outright), and month-precision dates
  (`"<Month> CY<Year>"`). The product tag is only a cheap pre-filter --
  every survivor still routes through the real Phase 2 taxonomy as the
  scoping authority, same as every other source.
  Correlation is deliberately conservative: this phase's own cautionary
  example is the Phase 0.1 cross-source merge threshold (0.82), which has
  never once fired against real data -- an unvalidated threshold that just
  silently never engages. Two bases only: **`exact-id`** (the tracked
  item's text explicitly references the roadmap feature id -- attaches
  unconditionally), or **`strong-title-date`** (a new,
  purpose-built `roadmapTitleSimilarity()` clears `0.75` **and** the
  roadmap's stated date falls within 1 month of the tracked item's own
  date). `roadmapTitleSimilarity()` is deliberately a separate function
  from the existing `titleSimilarity()` (which backs the already-shipped
  0.82/0.70 thresholds) -- reusing it naively would have understated a
  real, genuine correlation pair (0.25 vs. 0.80 on the new function) due to
  hyphen-handling and unstripped boilerplate words; see
  `api/__fixtures__/roadmap/README.md` for the full real-pair validation.
  A correlated roadmap item attaches to the matched item's new additive
  `announcements: []` array rather than becoming its own card; an
  uncorrelated-but-taxonomy-matched roadmap item becomes its own standalone
  tier-A item. Every near-miss below the correlation bar is captured (not
  asserted) in KV (`entra_tracker_roadmap_candidates_v1`, capped at 200,
  diagnostic-only, never in the public API/UI) -- the mechanism that stops
  the 0.82 problem from repeating: real match-quality data accumulates for
  future evidence-driven recalibration instead of the bar being guessed at
  twice. A new additive `dateConflict: true` fires when a correlated
  roadmap entry's stated date disagrees (different month) with an
  already-derived `deadline` from another source -- both dates are kept,
  neither is silently picked, surfaced plainly in the UI as a genuine
  disagreement between two official Microsoft channels rather than an
  error to smooth over. Non-fatal and side-band throughout: correlation
  runs with a per-roadmap-item try/catch (one malformed item can't cost
  every *other* roadmap item its chance to correlate or publish in the
  same build), and `m365-roadmap` gets its own Phase 4 trailing health
  baseline -- a roadmap outage degrades exactly like any other source's,
  and a zero-count build doesn't poison its own baseline. Verified against
  a real live fetch through the actual production pipeline (not just
  fixtures): 1813 total roadmap items -> 12 tag-filter survivors -> 12
  taxonomy survivors (0 dropped) -> 0 exact-id + 1 strong-title-date
  correlation (the real Cross-tenant-sync pair, confidence 0.8) -> 11
  sub-threshold candidates captured (scores 0.167-0.571, all correctly
  below the 0.75 bar) -> 7 standalone tier-A items after the existing
  dateless-item retention horizon prunes the oldest 4 -> 0 dateConflicts,
  0 errors, 0 degraded. API envelope confirmed additive-only: `announcements[]`/
  `dateConflict` on items, `m365-roadmap` in `sources{}`, nothing else
  changed shape. Frontend: roadmap entries render as a supplementary row on
  the matched card (`exact-id` shown as a definite "Roadmap" tag,
  `strong-title-date` hedged as "likely related", never presented with
  equal certainty), `dateConflict` shown as a plain neutral badge, and
  `/methodology` extended to explain the roadmap source, tier-A treatment,
  what "likely related" means, and that Microsoft's own channels can
  genuinely disagree on a date. 108 tests total (83 pre-existing
  unaffected, 25 new).

## Planned

- Cross-device On-radar sync via Cloudflare D1 + device token -- CONDITIONAL, only if
  client-side localStorage radar proves insufficient; do not start without revisiting user
  demand and privacy implications.
