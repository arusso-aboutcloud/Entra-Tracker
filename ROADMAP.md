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

## Planned

- Cross-device On-radar sync via Cloudflare D1 + device token -- CONDITIONAL, only if
  client-side localStorage radar proves insufficient; do not start without revisiting user
  demand and privacy implications.
