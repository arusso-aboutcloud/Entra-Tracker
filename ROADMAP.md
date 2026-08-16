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
- [x] Frontend redesign + `.ics` calendar feed -- net-new product work
  after the reliability arc (PRs #21-27) closed. Two deliverables, one PR:
  a full visual/interaction redesign of `web/index.html`, and a new
  `GET /entra-tracker?format=ics` export. No pipeline change -- confirmed
  JSON/CSV/RSS output unaffected by dedicated tests.
  **Motion**: deleted every infinite-loop glow/pulse animation (a
  breathing hero title/subtitle, a pulsing "live" dot, a glowing subscribe
  button, six looping stat-number glows) -- for a trustworthy-signal tool,
  forever-looping decoration reads as "this page is alive," not "something
  changed." What's left: the loading spinner, sub-200ms hover/focus/press
  transitions, and a single one-shot card entrance animation that plays
  once per re-render. `prefers-reduced-motion: reduce` neutralises all of
  it.
  **Unified filter bar**: replaced three disconnected filter mechanisms
  (a 12-checkbox environment panel, a status-button-row + two `<select>`s,
  and free-text search) with one model -- multi-select toggle-chips
  (`aria-pressed`, real `<button>`s) for urgency, change type, and service
  area (sourced live from `GET /taxonomy`), all freely combinable, plus
  External ID / On Radar / My-environment as special toggle chips, all in
  the same visual vocabulary. Every active filter renders as a removable
  pill in an active-filters strip with one "Clear all" -- no hidden state.
  Deep-link copy-link now encodes the full chip state (comma-separated
  per axis) instead of a single filter+status pair.
  **Card redesign**: each card is now a native `<details>` -- a compact,
  scannable summary (title, urgency strip, key badges, evidence tier,
  countdown, roadmap announcements -- the latter always visible, a trust
  signal not a "read more" detail) with an expandable region holding the
  full description, evidence quote + source, service-area/source
  metadata, and a link into `/methodology`. New "Revised" badge wired to
  the one real signal already available (`titleHistory[]`, Phase 1) and
  positioned as the slot a future deadline-slip signal (D1 revision store,
  a separate later work order) will extend without another redesign.
  **Design tokens**: consolidated near-duplicate CSS custom properties
  that meant the same neutral role under different names (`--surf`/
  `--surface2`, `--bdr`/`--border`, `--text2`/`--muted`, `--dim`) into one
  name per role; the semantic red/yellow/green/purple palette was already
  clean and untouched.
  **Accessibility**: explicit `:focus-visible` rings on every interactive
  element (the search input previously suppressed the browser default
  with no replacement -- a real gap, now fixed); filter chips are real
  `<button>`s with `aria-pressed` so assistive tech announces them
  correctly as toggles.
  **"My environment" panel**: the old "Tenant Profile" reframed (not
  deleted) -- copy now states plainly it's a rough, self-declared,
  keyword-based approximation, explicitly staged as the entry point for a
  future real client-side tenant overlay (delegated Microsoft Graph
  access, out of scope here). Its match result now folds into the same
  active-filters pill strip as everything else.
  **`.ics` feed**: `GET /entra-tracker?format=ics`, hand-built (no
  library), one all-day `VEVENT` per item with a real `deadline`
  (unfiltered by status, matching CSV's behaviour), `inferred`-confidence
  deadlines included with a leading `~` tentative marker rather than
  excluded outright, RFC 5545-compliant (CRLF, `,`/`;`/`\`/newline
  escaping, 75-octet code-point-safe line folding), one `VALARM` per
  event (3 days before), non-fatal per event (one malformed item is
  skipped, logged, and never corrupts the rest of the calendar). Verified
  two ways: unit tests, and round-tripping the real output of a live
  production fetch through an independent RFC 5545 parser (`node-ical`) --
  5 real dated items parsed back out correctly, including the tentative
  marker on the one real `inferred`-confidence item. Appears as a new row
  in the Subscribe/Export popover.
  Verified live via headless Playwright against mocked API/taxonomy/health
  responses: full-page and mobile (375px, no horizontal overflow)
  screenshots, the "urgent + Conditional Access = two clicks, two pills"
  flow, card expand/collapse (and that starring an item doesn't also
  toggle the card open), keyboard focus rings, reduced-motion rendering,
  and the Subscribe popover's new `.ics` row -- zero console errors in
  every scenario. 19 new Worker-side tests for the `.ics` builder
  (escaping, folding, tentative marker, non-fatal skip, namespace
  filtering) plus a dedicated no-pipeline-diff suite exercising `toCSV`/
  `toRSS` directly; 127 tests total (108 pre-existing unaffected).
- [x] Slip-history read UI + endpoint -- exposes the D1 revision store
  (Phase 3) that had been write-only since 2026-08-16, and wires PR #28's
  "Revised" badge slot to real data instead of its `titleHistory[]`
  placeholder. Read-only against the store: `writeRevisions()`, the
  schema, and `REVISION_FIELD_COLUMNS` are byte-for-byte unchanged; no
  migration needed either, since the existing Phase 3 index already
  served every read query this phase issues.
  New `GET /entra-tracker/history/:itemId` -- a single indexed lookup
  (`WHERE item_id = ? ORDER BY observed_at ASC, id ASC LIMIT 200`, served
  by the existing `(item_id, id DESC)` index in either scan direction, tie-
  broken on the autoincrement `id` for the same reason the write path
  already does), no auth, never fetches upstream or rebuilds. Invalid item
  id shapes (validated against `^[0-9a-f]{8}$`, the real fnv1a id format)
  are rejected before ever reaching D1. Returns the ordered revision log
  (baseline's `changedFields` correctly `[]`, not fabricated) plus a
  pre-derived `deadlineHistory[]` -- the `deadline` column run-length-
  encoded to its distinct-value sequence, so an item rebuilt dozens of
  times with an unchanged deadline still collapses to one entry; only a
  genuine value change (including gaining or losing a deadline entirely,
  tracked via strict equality against `null`) counts as a "move." Unknown
  id -> clean 404; D1 down -> clean 503; both return the same well-formed
  empty shape, never a 500 that reads as "the tracker is broken."
  New additive `deadlineChangeCount` on every item in the main envelope,
  computed **once per build** via a single batch aggregate (SQLite window
  functions `LAG`/`ROW_NUMBER`, confirmed supported against the live D1
  before writing the query) scoped to only the current build's item ids
  (`WHERE item_id IN (...)`) so cost tracks today's feed size, not years
  of accumulated history for items long since aged out of the feed --
  explicitly not a per-card/per-request lookup, which is what makes it
  safe to put on every item. Non-fatal: a failing aggregate yields
  `deadlineChangeCount: 0` for every item, proven with a dedicated test
  diffing a real build against one run with a throwing D1.
  Frontend: the "Revised" badge now fires only on a genuine deadline
  change (a reworded title alone no longer triggers it -- that was always
  meant as a placeholder, not a permanent second meaning for the badge).
  Expanding a flagged card lazily fetches its history (cached per session,
  never re-fetched on re-collapse/re-expand, never fetched at all for the
  100+ cards a user hasn't opened) and renders the deadline-slip sequence
  as the headline, with the full revision log available on demand behind
  a nested disclosure. `/methodology` extended with an honest explanation:
  history is observed starting 2026-08-16, not asserted for an item's
  full lifetime -- a slip that happened before that date and hasn't
  recurred since will show as "never moved," stated plainly rather than
  implying more certainty than the record has.
  **Observed revision-count distribution, reported honestly per the work
  order's explicit ask:** live D1 queried directly before merge -- 103
  total rows, 103 distinct items, every current item has exactly one
  revision (its baseline). Zero items have slipped yet, so
  `deadlineChangeCount` is `0` across the entire live feed today and no
  card shows the badge in production. Expected for a one-day-old store,
  not a bug -- the feature is explicitly designed to render gracefully at
  zero and get richer as real changes accumulate. The rich (multi-slip)
  UI states were verified with mocked data for exactly this reason.
  150 tests total (127 pre-existing unaffected, 23 new).

## Planned

- Cross-device On-radar sync via Cloudflare D1 + device token -- CONDITIONAL, only if
  client-side localStorage radar proves insufficient; do not start without revisiting user
  demand and privacy implications.
