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

## Planned

- Cross-device On-radar sync via Cloudflare D1 + device token -- CONDITIONAL, only if
  client-side localStorage radar proves insufficient; do not start without revisiting user
  demand and privacy implications.
