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
  autoincrement `id` column, which is.

## Planned

- Cross-device On-radar sync via Cloudflare D1 + device token -- CONDITIONAL, only if
  client-side localStorage radar proves insufficient; do not start without revisiting user
  demand and privacy implications.
