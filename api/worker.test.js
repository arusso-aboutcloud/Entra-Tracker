import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  normalizeTitleForDedup,
  titleSimilarity,
  monthDiff,
  sourceRank,
  dedupeIntraSource,
  mergeCrossSource,
  twoStageDedupe,
  extractDeadline,
  classifyByKeyword,
  buildEvidence,
  evidenceTierRank,
  makeId,
  fnv1a,
  applyDiff,
  SERVICE_TAXONOMY,
  classifyTaxonomy,
  matchesAnyTaxonomyEntry,
  routeThroughTaxonomy,
  isExternalId,
  REVISION_FIELD_COLUMNS,
  revisionContentHash,
  writeRevisions,
  buildTrackerData,
  HEALTH_KEY,
  median,
  evaluateSourceHealth,
  buildHealthResponse,
  applyDegradedGate,
} from './worker.js';
import workerDefault from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(...segments) {
  const p = path.join(__dirname, '__fixtures__', ...segments);
  return JSON.parse(readFileSync(p, 'utf8'));
}
function loadText(...segments) {
  const p = path.join(__dirname, '__fixtures__', ...segments);
  return readFileSync(p, 'utf8').trim();
}

// ── DEDUPE (Phase 0.1) ───────────────────────────────────────────────────────

describe('normalizeTitleForDedup', () => {
  test('strips subtype prefix, punctuation, and collapses whitespace', () => {
    assert.equal(
      normalizeTitleForDedup('[External ID] Passkey  support -- for External ID!'),
      'passkey support for external id'
    );
  });
});

describe('titleSimilarity / monthDiff', () => {
  test('near-identical titles score above the merge threshold', () => {
    const a = 'Privileged Identity Management (PIM) iteration 2 API retirement';
    const b = 'Privileged Identity Management (PIM) iteration 2 API retirement notice';
    assert.ok(titleSimilarity(a, b) >= 0.82, `expected >=0.82, got ${titleSimilarity(a, b)}`);
  });

  test('unrelated titles score low', () => {
    assert.ok(titleSimilarity('Conditional Access enforcement', 'FSLogix profile container retirement') < 0.3);
  });

  test('monthDiff is null when either date is missing', () => {
    assert.equal(monthDiff(null, '2026-03-01'), null);
    assert.equal(monthDiff('2026-03-01', null), null);
  });

  test('monthDiff counts whole months regardless of day', () => {
    assert.equal(monthDiff('2026-01-31', '2026-02-01'), 1);
    assert.equal(monthDiff('2026-01-02', '2026-06-01'), 5);
  });
});

describe('dedupeIntraSource (stage 1)', () => {
  test('collapses an exact-normalised-title repeat within the same source', () => {
    const items = loadFixture('dedupe', 'intra-source-duplicate.json');
    const { items: kept, dedupeDropped } = dedupeIntraSource(items);
    assert.equal(kept.length, 1);
    assert.equal(dedupeDropped, 1);
  });

  test('does not touch distinct titles', () => {
    const items = loadFixture('dedupe', 'cross-source-exact-merge.json'); // 2 different sources, same title
    const { items: kept, dedupeDropped } = dedupeIntraSource(items);
    assert.equal(kept.length, 2);
    assert.equal(dedupeDropped, 0);
  });
});

describe('mergeCrossSource (stage 2)', () => {
  test('merges an exact cross-source title match, higher-rank source wins (no evidence on fixture -> falls back to source order)', () => {
    const items = loadFixture('dedupe', 'cross-source-exact-merge.json');
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 1);
    assert.equal(crossSourceMerged, 1);
    const survivor = merged[0];
    assert.equal(survivor.source, 'entra-whatsnew-md'); // rank 0 beats external-id-docs (rank 2)
    assert.deepEqual(new Set(survivor.sources), new Set(['entra-whatsnew-md', 'external-id-docs']));
    assert.equal(survivor.links.length, 2);
  });

  test('merges a near-duplicate title within the ±1 month window, and backfills a null deadline from the loser', () => {
    const items = loadFixture('dedupe', 'cross-source-near-duplicate-merge.json');
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 1);
    assert.equal(crossSourceMerged, 1);
    const survivor = merged[0];
    assert.equal(survivor.source, 'entra-whatsnew-md');
    assert.equal(survivor.deadline, '2026-09-30');
    assert.equal(survivor.daysRemaining, 47);
  });

  test('does NOT merge a near-duplicate title when announcedDate months are more than 1 apart', () => {
    const items = loadFixture('dedupe', 'cross-source-month-window-reject.json');
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 2);
    assert.equal(crossSourceMerged, 0);
  });

  test('external-id-commits items are never merged into or absorbed by another source (carve-out, still holds after tier-ranking swap)', () => {
    const items = loadFixture('dedupe', 'eic-carveout.json');
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 2);
    assert.equal(crossSourceMerged, 0);
    assert.ok(merged.some(i => i.source === 'external-id-commits'));
    assert.ok(merged.some(i => i.source === 'entra-whatsnew-md'));
  });

  test('(1c) evidence tier wins over the fixed CROSS_SOURCE_RANK table when they disagree', () => {
    // Real-content fixture, see api/__fixtures__/evidence/README for provenance
    // and why this pairing was chosen to force a flip.
    const fx = loadFixture('evidence', 'agent-registry-cross-source-merge.json');
    const items = [fx.whatsnewItemNoTypeField, fx.graphChangelogItem];
    // Sanity: titles must actually match for this to be a merge-ranking test.
    assert.equal(
      normalizeTitleForDedup(items[0].title),
      normalizeTitleForDedup(items[1].title)
    );
    // Old fixed table says entra-whatsnew-md (rank 0) beats graph-changelog (rank 1).
    assert.ok(sourceRank('entra-whatsnew-md') < sourceRank('graph-changelog'));
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 1);
    assert.equal(crossSourceMerged, 1);
    // New tier-based ranking: tier A (graph-changelog here) beats tier B
    // (entra-whatsnew-md here) -- the winner FLIPS from what the old table alone would pick.
    assert.equal(merged[0].source, 'graph-changelog');
    assert.equal(merged[0].evidence.tier, 'A');
  });
});

describe('twoStageDedupe (end to end)', () => {
  test('runs stage 1 then stage 2 and reports both counters', () => {
    const items = [
      ...loadFixture('dedupe', 'intra-source-duplicate.json'),
      ...loadFixture('dedupe', 'cross-source-exact-merge.json'),
    ];
    const { items: result, dedupeDropped, crossSourceMerged } = twoStageDedupe(items);
    assert.equal(result.length, 2);
    assert.equal(dedupeDropped, 1);
    assert.equal(crossSourceMerged, 1);
  });
});

describe('sourceRank / evidenceTierRank', () => {
  test('sourceRank orders sources as specified (tie-break table, Phase 0.1)', () => {
    assert.ok(sourceRank('entra-whatsnew-md') < sourceRank('graph-changelog'));
    assert.ok(sourceRank('graph-changelog') < sourceRank('external-id-docs'));
    assert.equal(sourceRank('external-id-docs'), sourceRank('b2c-docs'));
    assert.ok(sourceRank('b2c-docs') < sourceRank('fslogix-docs'));
    assert.ok(sourceRank('fslogix-docs') < sourceRank('external-id-commits'));
  });

  test('evidenceTierRank orders A > B > C, unknown tiers rank last', () => {
    assert.ok(evidenceTierRank('A') < evidenceTierRank('B'));
    assert.ok(evidenceTierRank('B') < evidenceTierRank('C'));
    assert.ok(evidenceTierRank('C') < evidenceTierRank(undefined));
  });
});

// ── DEADLINE SCORING (1a) -- all fixtures are real captured Microsoft text,
// see api/__fixtures__/deadline/README.md for exact source + capture date. ──

describe('extractDeadline (candidate scorer, real fixtures)', () => {
  test('real: Agent Registry retirement -- day-precision date, cessation verb same sentence -> stated', () => {
    const text = loadText('deadline', 'agent-registry-retirement.txt');
    const r = extractDeadline(text, 'breaking', '2026-03-01');
    assert.ok(r.deadline, 'expected a deadline to be found');
    assert.equal(r.deadline.toISOString().split('T')[0], '2026-05-01');
    assert.equal(r.deadlineConfidence, 'stated');
    assert.equal(r.deadlinePrecision, 'day');
    assert.match(r.deadlineEvidence, /retired on May 1, 2026/i);
  });

  test('real: PIM iteration 2 Graph API deprecation -- day-precision, stated', () => {
    const text = loadText('deadline', 'pim-iteration2-graph-changelog.txt');
    const r = extractDeadline(text, 'retirement', '2025-11-18');
    assert.ok(r.deadline);
    assert.equal(r.deadline.toISOString().split('T')[0], '2026-10-28');
    assert.equal(r.deadlineConfidence, 'stated');
    assert.equal(r.deadlinePrecision, 'day');
  });

  test('real: SAP SuccessFactors basic-auth deadline -- new_feature category still surfaces a stated month-precision deadline because "must upgrade...before" genuinely supports it', () => {
    const text = loadText('deadline', 'sap-successfactors-deadline.txt');
    const r = extractDeadline(text, 'new_feature', '2026-05-01');
    assert.ok(r.deadline, 'a non-retirement/breaking category can still surface a deadline when confidence is stated/derived');
    // End-of-month convention: "November 2026" -> 2026-11-30
    assert.equal(r.deadline.toISOString().split('T')[0], '2026-11-30');
    assert.equal(r.deadlineConfidence, 'stated'); // "must upgrade" is literally in DEADLINE_LANGUAGE
    assert.equal(r.deadlinePrecision, 'month');
  });

  test('real: FSLogix "no date at all" callout -> null deadline', () => {
    const text = loadText('deadline', 'fslogix-no-date.txt');
    const r = extractDeadline(text, 'breaking', null);
    assert.equal(r.deadline, null);
    assert.equal(r.deadlineConfidence, null);
  });

  test('real: FSLogix rollout-language date, non-retirement category -> suppressed entirely (inferred not enough outside retirement/breaking)', () => {
    const text = loadText('deadline', 'fslogix-rollout-language.txt');
    // This is how parseFSLogixDocs actually classifies this exact real text
    // in isolation (no "action required"/"must"/"breaking" substring here).
    const category = /action required|breaking|will fail|must|before.*update/i.test(text) ? 'breaking' : 'preview';
    assert.equal(category, 'preview');
    const r = extractDeadline(text, category, null);
    assert.equal(r.deadline, null, 'rollout-language date with no deadline language nearby should not surface as a deadline for a preview item');
  });

  test('real: same FSLogix rollout-language text, but breaking category -> weak candidate still surfaces, downgraded to inferred', () => {
    // Demonstrates the honesty of the confidence field: with only one date
    // candidate in the text and no deadline-language support, the scorer
    // can't invent a better candidate -- but it correctly marks this one
    // low-confidence rather than presenting it as certain. 1d suppresses
    // the countdown for 'inferred' for exactly this reason.
    const text = loadText('deadline', 'fslogix-rollout-language.txt');
    const r = extractDeadline(text, 'breaking', null);
    assert.ok(r.deadline);
    assert.equal(r.deadlineConfidence, 'inferred');
  });

  test('real (composite, see fixture README): an incidental ISO page-footer date is the only candidate -- surfaced but downgraded to inferred, not silently treated as certain', () => {
    const text = loadText('deadline', 'iso-date-not-deadline-composite.txt');
    const r = extractDeadline(text, 'breaking', null);
    // The old bug: this ISO date would have been accepted outright as a
    // hard deadline for a 'breaking' category with zero language support.
    // The new scorer still can't know it's page metadata (it's the only
    // candidate in the text) but correctly flags it as weakly supported.
    assert.ok(r.deadline);
    assert.equal(r.deadlineConfidence, 'inferred');
  });

  test('synthetic (deterministic tie-break check, not prose): retirement/breaking break score ties toward the LATEST future date', () => {
    // Two day-precision dates, both same-sentence with a cessation verb, both
    // future, both equally far from rollout language (none present) -- an
    // exact score tie is what this test needs, which real prose essentially
    // never produces on demand. See README for why this one case is synthetic.
    const text = 'This will be retired on 2026-09-01 or 2026-11-01, exact date to be confirmed.';
    const r = extractDeadline(text, 'retirement', null);
    assert.equal(r.deadline.toISOString().split('T')[0], '2026-11-01');
  });

  test('synthetic (regex-overlap mechanics): "15 March 2026" (DMY) is not double-counted as a separate "March 2026" (MY) candidate', () => {
    const text = 'The feature will be retired on 15 March 2026.';
    const r = extractDeadline(text, 'retirement', null);
    assert.equal(r.deadlinePrecision, 'day'); // DMY wins, not the subsumed MY reading
    assert.equal(r.deadline.toISOString().split('T')[0], '2026-03-15');
  });

  test('an ISO date elsewhere in the body no longer beats the real MDY/text deadline just by matching an earlier-precedence format', () => {
    // Same illustrative example as the work order text -- kept as a direct
    // before/after regression guard (the old single-format-match bug is
    // exactly what this demonstrates fixed).
    const text = 'Published 2026-01-15. Starting March 2026 rollout begins; fully retired by November 2026.';
    const r = extractDeadline(text, 'retirement', null);
    assert.equal(r.deadline.toISOString().split('T')[0], '2026-11-30');
    assert.equal(r.deadlineConfidence, 'stated');
  });

  test('retirement with no date anywhere returns a fully-null result object (not a bare null)', () => {
    const r = extractDeadline('This feature is being retired with no stated date.', 'retirement', null);
    assert.deepEqual(r, { deadline: null, deadlineConfidence: null, deadlineEvidence: null, deadlinePrecision: null });
  });
});

// ── ITEM IDENTITY (1b) ───────────────────────────────────────────────────────

describe('makeId', () => {
  test('same source+link+title -> same id; changing any one component changes it', () => {
    const a = makeId('entra-whatsnew-md', 'https://x/whats-new', 'Some Title');
    const b = makeId('entra-whatsnew-md', 'https://x/whats-new', 'Some Title');
    assert.equal(a, b);
    assert.notEqual(a, makeId('graph-changelog', 'https://x/whats-new', 'Some Title'));
    assert.notEqual(a, makeId('entra-whatsnew-md', 'https://x/other', 'Some Title'));
    assert.notEqual(a, makeId('entra-whatsnew-md', 'https://x/whats-new', 'Other Title'));
  });

  test('is stable across a trivial re-punctuation of the title (normalises before hashing)', () => {
    const a = makeId('entra-whatsnew-md', 'https://x', 'Some -- Title!');
    const b = makeId('entra-whatsnew-md', 'https://x', 'Some Title');
    assert.equal(a, b);
  });

  test('is an 8-hex-char string (unchanged format)', () => {
    assert.match(makeId('s', 'l', 't'), /^[0-9a-f]{8}$/);
  });
});

describe('fnv1a', () => {
  test('is deterministic', () => {
    assert.equal(fnv1a('hello'), fnv1a('hello'));
  });
});

describe('applyDiff (identity continuity across a rewording, and the id-formula transition)', () => {
  test('real: exact id match carries firstSeen forward unchanged', () => {
    const prevItem = { id: 'aaaa1111', title: 'Some Title', source: 'entra-whatsnew-md', announcedDate: '2026-03-01', firstSeen: '2026-01-01' };
    const curItem  = { id: 'aaaa1111', title: 'Some Title', source: 'entra-whatsnew-md', announcedDate: '2026-03-01' };
    applyDiff([curItem], [prevItem], false);
    assert.equal(curItem.isNew, false);
    assert.equal(curItem.firstSeen, '2026-01-01');
    assert.equal(curItem.firstSeenEstimated, false);
    assert.deepEqual(curItem.titleHistory, []);
  });

  test('real (MicrosoftDocs commit ac6b47d6): a genuine minor title rewording is caught by the similarity fallback, firstSeen carried forward, titleHistory records the prior title', () => {
    const fx = loadFixture('identity', 'jailbreak-heading-rename.json');
    assert.ok(titleSimilarity(fx.before.title, fx.after.title) >= 0.70, 'fixture must actually clear the threshold it is meant to validate');
    const prevId = makeId(fx.before.source, 'https://learn.microsoft.com/en-us/entra/fundamentals/whats-new', fx.before.title);
    const prevItem = { id: prevId, title: fx.before.title, source: fx.before.source, announcedDate: fx.before.announcedDate, firstSeen: '2026-02-05' };
    const newId = makeId(fx.after.source, 'https://learn.microsoft.com/en-us/entra/fundamentals/whats-new', fx.after.title);
    const curItem = { id: newId, title: fx.after.title, source: fx.after.source, announcedDate: fx.after.announcedDate };
    assert.notEqual(prevId, newId, 'the rewording must actually change the id, or this test proves nothing');

    applyDiff([curItem], [prevItem], false);
    assert.equal(curItem.isNew, false, 'reworded item must not be treated as brand new');
    assert.equal(curItem.firstSeen, '2026-02-05', 'firstSeen must carry forward from the pre-rewording item');
    assert.deepEqual(curItem.titleHistory, [fx.before.title]);
  });

  test('real (Preview->GA pair, distinct lifecycle stages): similarity fallback correctly does NOT merge two genuinely different announcements', () => {
    const fx = loadFixture('identity', 'preview-to-ga-distinct.json');
    assert.ok(titleSimilarity(fx.preview.title, fx.ga.title) < 0.70, 'fixture must actually be below the threshold it is meant to validate');
    const prevItem = { id: 'prev-preview-id', title: fx.preview.title, source: fx.preview.source, announcedDate: fx.preview.announcedDate, firstSeen: '2026-04-02' };
    const curItem  = { id: 'new-ga-id', title: fx.ga.title, source: fx.ga.source, announcedDate: fx.ga.announcedDate };
    applyDiff([curItem], [prevItem], false);
    assert.equal(curItem.isNew, true, 'a real GA announcement must not be swallowed by a Preview announcement several weeks earlier');
    assert.notEqual(curItem.firstSeen, '2026-04-02');
  });

  test('the makeId formula change (this phase) is a non-event for firstSeen continuity: every existing item has an unchanged title, so it trivially clears the similarity bar even though every id value changes', () => {
    // Simulates the actual Phase 0.1 -> Phase 1 deploy transition: prevItems
    // carry ids computed under the OLD ad hoc per-parser hash inputs; current
    // items carry ids computed under the NEW source+link+title formula. Titles
    // are identical, so this is the "one-time id value change" scenario
    // described in makeId()'s comment and the PR description, not a routine
    // rewording.
    function oldMakeId(title) { return fnv1a(String(title || '')); } // old bare-title hash, reimplemented locally on purpose (not imported) to pin down exactly what changed
    const title = 'General Availability - Some Real Feature';
    const oldId = oldMakeId(title);
    const newId = makeId('entra-whatsnew-md', 'https://learn.microsoft.com/en-us/entra/fundamentals/whats-new', title);
    assert.notEqual(oldId, newId, 'the formula must actually differ, or this test proves nothing');

    const prevItem = { id: oldId, title, source: 'entra-whatsnew-md', announcedDate: '2026-06-01', firstSeen: '2026-06-02' };
    const curItem  = { id: newId, title, source: 'entra-whatsnew-md', announcedDate: '2026-06-01' };
    applyDiff([curItem], [prevItem], false);
    assert.equal(curItem.isNew, false, 'an unchanged item must not appear as new just because the id formula changed');
    assert.equal(curItem.firstSeen, '2026-06-02');
    assert.deepEqual(curItem.titleHistory, [], 'title is unchanged, so no titleHistory entry should be added even though similarity-fallback matching is what carried firstSeen');
  });
});

describe('applyDiff (1e: cold-start firstSeen seeding)', () => {
  test('cold start seeds firstSeen from announcedDate when it is in the past, and marks firstSeenEstimated', () => {
    const curItem = { id: 'x1', title: 'T', source: 's', announcedDate: '2026-03-01' };
    applyDiff([curItem], [], true);
    assert.equal(curItem.firstSeen, '2026-03-01');
    assert.equal(curItem.firstSeenEstimated, true);
  });

  test('cold start with no usable announcedDate falls back to today, not estimated', () => {
    const curItem = { id: 'x2', title: 'T', source: 's', announcedDate: null };
    const todayISO = new Date().toISOString().split('T')[0];
    applyDiff([curItem], [], true);
    assert.equal(curItem.firstSeen, todayISO);
    assert.equal(curItem.firstSeenEstimated, false);
  });

  test('a normal (non-cold-start) build never sets firstSeenEstimated true, even for a genuinely brand-new item', () => {
    const curItem = { id: 'x3', title: 'T', source: 's', announcedDate: '2026-03-01' };
    applyDiff([curItem], [], false);
    assert.equal(curItem.firstSeenEstimated, false);
  });
});

// ── CLASSIFICATION PROVENANCE (1c) ──────────────────────────────────────────

describe('buildEvidence / classifyByKeyword', () => {
  test('buildEvidence caps quote length and defaults sourceUrl to null', () => {
    const e = buildEvidence('B', 'doc-callout', 'x'.repeat(500), undefined);
    assert.equal(e.quote.length, 240);
    assert.equal(e.sourceUrl, null);
  });

  test('real: SAP SuccessFactors text keyword-classifies as retirement (body mentions "deprecate"), even though the live parser uses Type: New feature instead', () => {
    // classifyByKeyword checks CLASSIFIERS.retirement first and the body
    // text says "SAP's plan to deprecate basic authentication" -- so the
    // keyword fallback alone would call this 'retirement'. The live parser
    // never actually reaches this fallback for this entry because it has a
    // real **Type:** field (New feature) and TYPE_TO_CATEGORY wins first;
    // this test documents why classifyByKeyword's raw output can't be
    // treated as authoritative for whats-new.md entries in isolation.
    const text = loadText('deadline', 'sap-successfactors-deadline.txt');
    assert.equal(classifyByKeyword('Public Preview - Workload identity-based authentication for SAP SuccessFactors provisioning integrations', text), 'retirement');
  });
});

// ── SERVICE TAXONOMY (Phase 2) ───────────────────────────────────────────────

describe('SERVICE_TAXONOMY structure', () => {
  test('every entry has a unique id and name, and a non-empty titleTerms array', () => {
    const ids = new Set(), names = new Set();
    for (const entry of SERVICE_TAXONOMY) {
      assert.ok(entry.id && !ids.has(entry.id), `duplicate or missing id: ${entry.id}`);
      ids.add(entry.id);
      assert.ok(entry.name && !names.has(entry.name), `duplicate or missing name: ${entry.name}`);
      names.add(entry.name);
      assert.ok(Array.isArray(entry.titleTerms) && entry.titleTerms.length > 0, `${entry.id} has no titleTerms`);
    }
  });

  test('entra-id-workforce (the broad catch-all) is last, so more specific entries get first refusal in Tier 2', () => {
    assert.equal(SERVICE_TAXONOMY[SERVICE_TAXONOMY.length - 1].id, 'entra-id-workforce');
  });
});

describe('classifyTaxonomy (real fixtures -- regression guards for bugs found during Phase 2 development)', () => {
  test('real: "assigning" no longer false-matches the (removed) signin term -- primary is the authoritative serviceCategory, Authentication methods', () => {
    const fx = loadFixture('taxonomy', 'token-lifetime-policies.json');
    assert.ok(fx.description.toLowerCase().includes('assigning'), 'fixture must actually contain the trap word, or this test proves nothing');
    const matches = classifyTaxonomy(fx.title, fx.description, fx.serviceCategory);
    assert.ok(matches.length > 0);
    assert.equal(matches[0].name, fx.expectedPrimary);
    assert.equal(matches[0].name, 'Authentication methods');
  });

  test('real: an item whose body incidentally lists "Conditional Access policies, named locations" still primaries on its own real serviceCategory, not the incidental mentions', () => {
    const fx = loadFixture('taxonomy', 'backup-and-recovery.json');
    assert.ok(fx.description.toLowerCase().includes('conditional access'), 'fixture must contain the incidental mention, or this test proves nothing');
    const matches = classifyTaxonomy(fx.title, fx.description, fx.serviceCategory);
    assert.equal(matches[0].name, fx.expectedPrimary);
    assert.equal(matches[0].name, 'Entra ID (workforce)');
    // The incidental mentions are still legitimately present as secondary matches.
    assert.ok(matches.some(m => m.id === 'conditional-access'));
  });

  test('real: a B2B item mentioning generic "sign-in" language still primaries on serviceCategory B2B -> Entra External ID', () => {
    const fx = loadFixture('taxonomy', 'domainless-saml-b2b.json');
    const matches = classifyTaxonomy(fx.title, fx.description, fx.serviceCategory);
    assert.equal(matches[0].name, fx.expectedPrimary);
    assert.equal(matches[0].name, 'Entra External ID / Azure AD B2C');
  });

  test('a whats-new.md item with NO serviceCategory falls through to Tier 2 (title/description) matching', () => {
    const matches = classifyTaxonomy('Public Preview - New passkey management experience', 'Admins can manage passkey (FIDO2) registrations for external tenant users.', '');
    assert.ok(matches.some(m => m.id === 'entra-external-id'));
  });

  test('an item matching nothing returns an empty array', () => {
    const matches = classifyTaxonomy('Completely unrelated Azure Storage announcement', 'Blob storage tiering is now generally available.', '');
    assert.deepEqual(matches, []);
  });
});

describe('matchesAnyTaxonomyEntry (Graph changelog relevance gate, real fixtures)', () => {
  test('real: a genuine PIM API deprecation matches (privilegedAccess)', () => {
    const text = loadText('deadline', 'pim-iteration2-graph-changelog.txt');
    assert.equal(matchesAnyTaxonomyEntry(text), true);
  });

  test('real: an off-topic Windows 365 Cloud PC item does NOT match, despite containing "provisioning" as a substring of an unrelated resource name', () => {
    const text = loadText('taxonomy', 'cloud-pc-off-topic.txt');
    assert.ok(text.toLowerCase().includes('provisioning'), 'fixture must contain the trap substring, or this test proves nothing');
    assert.equal(matchesAnyTaxonomyEntry(text), false);
  });

  test('only checks titleTerms, never serviceCategoryTerms, against free text', () => {
    // 'other' is entra-id-workforce's serviceCategoryTerms entry (matches
    // Microsoft's literal "Other" category label) and appears in no entry's
    // titleTerms -- the cloud-pc fixture above is the real-world proof this
    // matters; this pins the implementation choice with a direct example.
    const term = 'other';
    for (const entry of SERVICE_TAXONOMY) {
      assert.ok(!entry.titleTerms.includes(term), `expected no entry's titleTerms to contain '${term}'`);
    }
    assert.equal(matchesAnyTaxonomyEntry(`this entry's service category is ${term}`), false);
  });
});

describe('isExternalId (namespace assignment, unchanged behaviour sourced from the taxonomy)', () => {
  test('real: raw serviceCategory "B2B" -> external-id namespace', () => {
    assert.equal(isExternalId('Domainless SAML IdP federation for workforce tenants', 'B2B'), true);
  });

  test('real: passkey in the title alone (workforce serviceCategory) -> external-id namespace, title-only override', () => {
    assert.equal(isExternalId('Expanded policy storage for passkeys (FIDO2) in Microsoft Entra ID', 'Authentications (Logins)'), true);
  });

  test('a plain workforce item with no external-id signal anywhere -> not external-id', () => {
    assert.equal(isExternalId('General Availability - License Usage', 'Reporting'), false);
  });
});

describe('routeThroughTaxonomy (drop counting and sample cap)', () => {
  // Item-level fixtures here (not raw payload) -- this tests routing/counting
  // arithmetic, disclosed per the work order's fixture rule for that case.
  test('an item matching nothing is dropped and counted per source', () => {
    const items = [
      { title: 'Unrelated Azure Storage update', description: 'Blob tiering GA.', serviceCategory: '', source: 'entra-whatsnew-md', link: 'x' },
      { title: 'Public Preview - New passkey experience', description: 'external tenant passkeys', serviceCategory: '', source: 'entra-whatsnew-md', link: 'y' },
    ];
    const { items: kept, unmatched } = routeThroughTaxonomy(items);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, 'Public Preview - New passkey experience');
    assert.deepEqual(unmatched, { 'entra-whatsnew-md': 1 });
  });

  test('a matched item gets serviceCategory overwritten to the primary canonical name and serviceCategories[] populated', () => {
    const items = [{ title: 'Conditional Access update', description: '', serviceCategory: 'Conditional Access', source: 'entra-whatsnew-md', link: 'x' }];
    const { items: kept } = routeThroughTaxonomy(items);
    assert.equal(kept[0].serviceCategory, 'Conditional Access');
    assert.deepEqual(kept[0].serviceCategories, ['Conditional Access']);
  });

  test('unmatchedSamples is capped at 10 total across all sources', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      title: `Unrelated item ${i}`, description: 'nothing identity-related here', serviceCategory: '', source: 'entra-whatsnew-md', link: `x${i}`,
    }));
    const { unmatched, unmatchedSamples } = routeThroughTaxonomy(items);
    assert.equal(unmatched['entra-whatsnew-md'], 15);
    assert.equal(unmatchedSamples.length, 10);
  });
});

// ── REVISION STORE (Phase 3, write-path only) ────────────────────────────────

// A minimal, tightly-scoped fake D1Database -- only understands the exact
// two query shapes writeRevisions() issues (see api/worker.js): a bind-less
// SELECT of the latest-per-item_id rows, and bound INSERT statements passed
// to batch(). Not a general SQL engine.
function makeFakeD1(existingRows) {
  const rows = existingRows ? existingRows.map(r => ({ ...r })) : [];
  const batchCallSizes = [];
  return {
    _rows: rows,
    _batchCallSizes: batchCallSizes,
    prepare(sql) {
      return {
        async all() {
          if (/^SELECT/i.test(sql.trim())) return { results: rows.map(r => ({ ...r })) };
          return { results: [] };
        },
        bind(...args) { return { _args: args }; },
      };
    },
    async batch(stmts) {
      batchCallSizes.push(stmts.length);
      for (const s of stmts) {
        const [item_id, observed_at, content_hash, title, category, status, deadline, deadline_confidence, announced_date, service_category, changed_fields] = s._args;
        const row = { item_id, observed_at, content_hash, title, category, status, deadline, deadline_confidence, announced_date, service_category, changed_fields };
        const idx = rows.findIndex(r => r.item_id === item_id);
        if (idx >= 0) rows[idx] = row; else rows.push(row);
      }
      return stmts.map(() => ({ success: true }));
    },
  };
}

function makeThrowingD1() {
  return {
    prepare() { throw new Error('D1 connection failed (simulated)'); },
    async batch() { throw new Error('D1 batch failed (simulated)'); },
  };
}

// Item-level (not raw-payload) fixtures, disclosed per the standing rule:
// hashing/diffing runs entirely on already-parsed item objects, not on
// Microsoft's source text, so there's nothing "real" to capture here --
// same justification as Phase 0.1's dedupe fixtures. The revision store's
// logic was separately verified against a REAL fresh 5-source fetch, piped
// through the real parsers/taxonomy/dedupe, and written to the actual
// production D1 database (12 real items, first build 12 rows, confirmed
// second build 0 rows) -- see the PR description for that run's numbers.
const REV_ITEM_A = { id: 'aaaa1111', title: 'Item A', category: 'breaking', status: 'yellow', deadline: '2026-05-01', deadlineConfidence: 'stated', announcedDate: '2026-03-01', serviceCategory: 'Conditional Access' };
const REV_ITEM_B = { id: 'bbbb2222', title: 'Item B', category: 'new_feature', status: 'green', deadline: null, deadlineConfidence: null, announcedDate: '2026-04-01', serviceCategory: 'Entra ID (workforce)' };

describe('revisionContentHash', () => {
  test('only depends on the tracked fields, not e.g. daysRemaining/firstSeen', () => {
    const a = { ...REV_ITEM_A, daysRemaining: 47, firstSeen: '2026-01-01' };
    const b = { ...REV_ITEM_A, daysRemaining: 12, firstSeen: '2026-06-01' };
    assert.equal(revisionContentHash(a), revisionContentHash(b));
  });

  test('changes when a tracked field changes', () => {
    const a = revisionContentHash(REV_ITEM_A);
    const b = revisionContentHash({ ...REV_ITEM_A, status: 'red' });
    assert.notEqual(a, b);
  });
});

describe('writeRevisions (non-fatal contract + change-only writes)', () => {
  test('no env.TRACKER_DB binding -> resolves immediately, no error', async () => {
    await assert.doesNotReject(writeRevisions(undefined, [REV_ITEM_A], '2026-08-16T00:00:00.000Z'));
    await assert.doesNotReject(writeRevisions({}, [REV_ITEM_A], '2026-08-16T00:00:00.000Z'));
  });

  test('a D1 that throws on every call never propagates -- the build must survive a D1 outage', async () => {
    const throwing = makeThrowingD1();
    await assert.doesNotReject(writeRevisions({ TRACKER_DB: throwing }, [REV_ITEM_A, REV_ITEM_B], '2026-08-16T00:00:00.000Z'));
  });

  test('first-ever build (empty table): every item gets a baseline row, changed_fields is empty', async () => {
    const db = makeFakeD1([]);
    await writeRevisions({ TRACKER_DB: db }, [REV_ITEM_A, REV_ITEM_B], '2026-08-16T00:00:00.000Z');
    assert.deepEqual(db._batchCallSizes, [2]); // one batch call, 2 rows
    assert.equal(db._rows.length, 2);
    for (const row of db._rows) assert.deepEqual(JSON.parse(row.changed_fields), []);
  });

  test('a second build with IDENTICAL content writes nothing (no batch call at all)', async () => {
    const db = makeFakeD1([]);
    await writeRevisions({ TRACKER_DB: db }, [REV_ITEM_A, REV_ITEM_B], '2026-08-16T00:00:00.000Z');
    await writeRevisions({ TRACKER_DB: db }, [REV_ITEM_A, REV_ITEM_B], '2026-08-16T04:00:00.000Z');
    assert.deepEqual(db._batchCallSizes, [2]); // still just the one batch call from the first build
    assert.equal(db._rows.length, 2);
  });

  test('a build where only one item changed writes exactly one row, with changed_fields naming what changed', async () => {
    const db = makeFakeD1([]);
    await writeRevisions({ TRACKER_DB: db }, [REV_ITEM_A, REV_ITEM_B], '2026-08-16T00:00:00.000Z');
    const changedA = { ...REV_ITEM_A, status: 'red', deadline: '2026-04-15' };
    await writeRevisions({ TRACKER_DB: db }, [changedA, REV_ITEM_B], '2026-08-16T04:00:00.000Z');
    assert.deepEqual(db._batchCallSizes, [2, 1]); // second build only wrote 1 row
    const latestA = db._rows.find(r => r.item_id === REV_ITEM_A.id);
    assert.deepEqual(JSON.parse(latestA.changed_fields).sort(), ['deadline', 'status']);
    assert.equal(latestA.observed_at, '2026-08-16T04:00:00.000Z');
  });

  test('KV cold start does not force a revision-store write storm: D1 already recognises unchanged item_ids from a prior build', async () => {
    // Simulates the scenario the work order specifically asks about: D1's
    // OWN history (not KV's coldStart flag) is what determines whether a
    // write happens. Seed D1 as if a prior build already ran (a real
    // "previous build" recorded via the same code path, not hand-built --
    // reuses writeRevisions itself to seed it), then simulate a KV cold
    // start (irrelevant to D1) re-observing the exact same items.
    const db = makeFakeD1([]);
    await writeRevisions({ TRACKER_DB: db }, [REV_ITEM_A, REV_ITEM_B], '2026-08-16T00:00:00.000Z');
    // "KV cold start" only affects firstSeen/isNew seeding in applyDiff, not
    // the item content itself -- the revision store only ever sees content.
    await writeRevisions({ TRACKER_DB: db }, [REV_ITEM_A, REV_ITEM_B], '2026-08-16T20:00:00.000Z');
    assert.deepEqual(db._batchCallSizes, [2]); // no second baseline storm
  });
});

// Shared by the Phase 3 and Phase 4 buildTrackerData integration tests below.
const WHATS_NEW_FIXTURE = [
  '## March 2026',
  '',
  '### Plan for change - Test Entry For Revision Store',
  '',
  '**Type:** Plan for change',
  '**Service category:** Conditional Access',
  '',
  'This entry will be retired on May 1, 2026.',
  '',
  '---',
  '',
].join('\n');

function mockFetchFor(url) {
  const u = String(url);
  const ok = (body) => Promise.resolve({ ok: true, text: async () => body });
  if (u.includes('whats-new.md')) return ok(WHATS_NEW_FIXTURE);
  if (u.includes('fslogix')) return ok('<html></html>');
  if (u.includes('external-id/whats-new-docs.md')) return ok('');
  if (u.includes('active-directory-b2c/whats-new-docs.md')) return ok('');
  if (u.includes('commits?path=')) return ok('[]');
  if (u.includes('graph/changelog')) return ok('<rss><channel></channel></rss>');
  return Promise.resolve({ ok: false, status: 404, text: async () => '' });
}

describe('buildTrackerData: API envelope is byte-for-byte unchanged regardless of D1 presence/success/failure', () => {
  test('identical envelope (aside from the live lastUpdated timestamp) with no D1, a working D1, and a failing D1', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    global.fetch = mockFetchFor;

    const noD1     = await buildTrackerData([], {});
    const workingD1 = makeFakeD1([]);
    const withD1    = await buildTrackerData([], { TRACKER_DB: workingD1 });
    const throwD1   = await buildTrackerData([], { TRACKER_DB: makeThrowingD1() });

    const strip = (data) => { const { lastUpdated, ...rest } = data; return rest; };
    assert.deepEqual(strip(noD1), strip(withD1));
    assert.deepEqual(strip(noD1), strip(throwD1));

    // Confirm the working-D1 run actually wrote something (the test isn't
    // vacuous -- D1 really did receive the item set and record a revision).
    assert.ok(workingD1._batchCallSizes.length > 0, 'expected the revision store to actually write on a real first build');

    // Confirm no D1-related text leaked into the envelope in any scenario.
    for (const data of [noD1, withD1, throwD1]) {
      assert.equal(JSON.stringify(data).toLowerCase().includes('d1'), false);
      assert.equal(JSON.stringify(data).toLowerCase().includes('tracker_db'), false);
    }
  });
});

// ── HEALTH / DEGRADED MODE (Phase 4) ────────────────────────────────────────
// Item-level fixtures throughout (not raw payload) -- degraded-gate logic
// runs on already-parsed items and count arrays, not Microsoft's source
// text, same justification as Phase 3's revision-store fixtures. Real
// per-source counts observed from a live fetch during this phase's
// development (for the "first population" report) are cited in the PR
// description, not re-derived here.

function makeFakeKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    _store: store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

function makeThrowingKV() {
  return {
    async get() { throw new Error('KV read failed (simulated)'); },
    async put() { throw new Error('KV write failed (simulated)'); },
  };
}

describe('median', () => {
  test('odd length', () => assert.equal(median([1, 3, 2]), 2));
  test('even length averages the two middle values', () => assert.equal(median([1, 2, 3, 4]), 2.5));
  test('empty array is null', () => assert.equal(median([]), null));
});

describe('evaluateSourceHealth', () => {
  test('no history yet -> never degraded, regardless of count (rollout / first-ever build for a source)', () => {
    assert.deepEqual(evaluateSourceHealth(0, []), { degraded: false, trailingMedian: null, ratio: null });
    assert.deepEqual(evaluateSourceHealth(91, []), { degraded: false, trailingMedian: null, ratio: null });
  });

  test('small-N source (trailing median <= floor) is exempt from the ratio test, including a drop to zero', () => {
    // Mirrors the real b2c-docs pattern: legitimately near/at zero for long stretches (B2C is end-of-sale).
    const r = evaluateSourceHealth(0, [2, 1, 2, 0, 1]); // median 1
    assert.equal(r.degraded, false);
  });

  test('a real drop below 50% of a meaningfully-sized trailing median is degraded', () => {
    const r = evaluateSourceHealth(3, [91, 88, 90, 92, 89, 91, 90]); // median 90
    assert.equal(r.degraded, true);
    assert.equal(r.trailingMedian, 90);
  });

  test('a source within normal variation (>=50% of median) is not degraded', () => {
    const r = evaluateSourceHealth(50, [91, 88, 90, 92, 89, 91, 90]); // median 90, ratio ~0.56
    assert.equal(r.degraded, false);
  });
});

describe('applyDegradedGate', () => {
  const PREV_WN  = [{ id: 'wn1', source: 'entra-whatsnew-md', title: 'Old WN item 1' }, { id: 'wn2', source: 'entra-whatsnew-md', title: 'Old WN item 2' }];
  const FRESH_WN = [{ id: 'wn3', source: 'entra-whatsnew-md', title: 'New WN item' }];

  function seededHealth(historyBySource) {
    const sources = {};
    for (const [source, history] of Object.entries(historyBySource)) {
      sources[source] = { lastSuccessAt: '2026-08-01T00:00:00.000Z', lastCount: history[history.length - 1], history, trailingMedian: median(history), ratio: 1, degraded: false };
    }
    return JSON.stringify({ lastUpdated: '2026-08-01T00:00:00.000Z', sources, degraded: [] });
  }

  test('a source dropping below 50% of trailing median: previous items retained and flagged stale, source in degraded[], baseline NOT updated', async () => {
    const kv = makeFakeKV({ [HEALTH_KEY]: seededHealth({ 'entra-whatsnew-md': [91, 88, 90, 92, 89, 91, 90] }) });
    const { items, degraded } = await applyDegradedGate({ ENTRA_CACHE: kv }, FRESH_WN, { 'entra-whatsnew-md': 3 }, PREV_WN, '2026-08-16T00:00:00.000Z');

    assert.deepEqual(degraded, ['entra-whatsnew-md']);
    assert.equal(items.length, 2); // carried previous items, not the 1 fresh item
    assert.ok(items.every(i => i.stale === true));
    assert.deepEqual(items.map(i => i.id).sort(), ['wn1', 'wn2']);

    const stored = JSON.parse(kv._store.get(HEALTH_KEY));
    assert.deepEqual(stored.sources['entra-whatsnew-md'].history, [91, 88, 90, 92, 89, 91, 90]); // unchanged
    assert.equal(stored.sources['entra-whatsnew-md'].degraded, true);
  });

  test('a healthy source: fresh items pass through flagged not-stale, and its count joins the trailing history', async () => {
    const kv = makeFakeKV({ [HEALTH_KEY]: seededHealth({ 'entra-whatsnew-md': [88, 90, 89] }) });
    const { items, degraded } = await applyDegradedGate({ ENTRA_CACHE: kv }, FRESH_WN, { 'entra-whatsnew-md': 91 }, PREV_WN, '2026-08-16T00:00:00.000Z');

    assert.deepEqual(degraded, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].stale, false);

    const stored = JSON.parse(kv._store.get(HEALTH_KEY));
    assert.deepEqual(stored.sources['entra-whatsnew-md'].history, [88, 90, 89, 91]);
  });

  test('small-N source within normal variation does not trip the gate', async () => {
    const kv = makeFakeKV({ [HEALTH_KEY]: seededHealth({ 'b2c-docs': [1, 0, 2, 0, 1] }) }); // median 1
    const { degraded } = await applyDegradedGate({ ENTRA_CACHE: kv }, [], { 'b2c-docs': 0 }, [], '2026-08-16T00:00:00.000Z');
    assert.deepEqual(degraded, []);
  });

  test('a recovered source rejoins normal operation and resumes updating its baseline', async () => {
    const kv = makeFakeKV({ [HEALTH_KEY]: seededHealth({ 'entra-whatsnew-md': [91, 88, 90, 92, 89, 91, 90] }) });

    // Build 1: degraded -- baseline frozen.
    await applyDegradedGate({ ENTRA_CACHE: kv }, FRESH_WN, { 'entra-whatsnew-md': 3 }, PREV_WN, '2026-08-16T00:00:00.000Z');
    let stored = JSON.parse(kv._store.get(HEALTH_KEY));
    assert.deepEqual(stored.sources['entra-whatsnew-md'].history, [91, 88, 90, 92, 89, 91, 90]);

    // Build 2: recovers to a normal count -- compared against the still-frozen baseline, passes, and resumes updating it.
    const { degraded } = await applyDegradedGate({ ENTRA_CACHE: kv }, FRESH_WN, { 'entra-whatsnew-md': 90 }, PREV_WN, '2026-08-16T04:00:00.000Z');
    assert.deepEqual(degraded, []);
    stored = JSON.parse(kv._store.get(HEALTH_KEY));
    assert.deepEqual(stored.sources['entra-whatsnew-md'].history, [88, 90, 92, 89, 91, 90, 90]); // window slid, includes the recovery count
  });

  test('non-fatal: a KV that throws on every call never propagates, and detection degrades to off (never degraded) rather than breaking the build', async () => {
    const kv = makeThrowingKV();
    const rawCounts = { 'entra-whatsnew-md': 3 }; // would be a real drop if the baseline were readable
    await assert.doesNotReject(applyDegradedGate({ ENTRA_CACHE: kv }, FRESH_WN, rawCounts, PREV_WN, '2026-08-16T00:00:00.000Z'));
    const { items, degraded } = await applyDegradedGate({ ENTRA_CACHE: kv }, FRESH_WN, rawCounts, PREV_WN, '2026-08-16T00:00:00.000Z');
    assert.deepEqual(degraded, []);
    assert.deepEqual(items, FRESH_WN.map(i => ({ ...i, stale: false })));
  });

  test('degraded webhook fires once on transition into degraded, not again on a second consecutive degraded build', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
    try {
      const kv = makeFakeKV({ [HEALTH_KEY]: seededHealth({ 'entra-whatsnew-md': [91, 88, 90, 92, 89, 91, 90] }) });
      const env = { ENTRA_CACHE: kv, DEGRADED_WEBHOOK_URL: 'https://example.test/hook' };
      await applyDegradedGate(env, FRESH_WN, { 'entra-whatsnew-md': 3 }, PREV_WN, '2026-08-16T00:00:00.000Z'); // build 1: transition
      await applyDegradedGate(env, FRESH_WN, { 'entra-whatsnew-md': 3 }, PREV_WN, '2026-08-16T04:00:00.000Z'); // build 2: still degraded
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.source, 'entra-whatsnew-md');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('no DEGRADED_WEBHOOK_URL set -> feature silently off, fetch never attempted', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('should not be called -- DEGRADED_WEBHOOK_URL is unset'); };
    try {
      const kv = makeFakeKV({ [HEALTH_KEY]: seededHealth({ 'entra-whatsnew-md': [91, 88, 90, 92, 89, 91, 90] }) });
      await assert.doesNotReject(applyDegradedGate({ ENTRA_CACHE: kv }, FRESH_WN, { 'entra-whatsnew-md': 3 }, PREV_WN, '2026-08-16T00:00:00.000Z'));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('buildHealthResponse', () => {
  test('shapes stored state into the public response; status reflects degraded[]', () => {
    const state = {
      lastUpdated: '2026-08-16T00:00:00.000Z',
      degraded: ['fslogix-docs'],
      sources: { 'fslogix-docs': { lastSuccessAt: null, lastCount: 0, history: [2, 1], trailingMedian: 1, ratio: 0, degraded: true } },
    };
    const r = buildHealthResponse(state);
    assert.equal(r.status, 'degraded');
    assert.deepEqual(r.degraded, ['fslogix-docs']);
    assert.equal(r.sources['fslogix-docs'].degraded, true);
  });

  test('null state (health snapshot never built yet) -> ok, empty', () => {
    const r = buildHealthResponse(null);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.degraded, []);
    assert.deepEqual(r.sources, {});
  });
});

describe('GET /entra-tracker/health -- real route (workerDefault.fetch), proves no upstream fetch', () => {
  test('returns the stored health state and makes zero fetch() calls', async () => {
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async (...args) => { fetchCalls++; throw new Error('unexpected upstream fetch from /health: ' + args[0]); };
    try {
      const healthJson = JSON.stringify({
        lastUpdated: '2026-08-16T00:00:00.000Z',
        degraded: ['b2c-docs'],
        sources: { 'b2c-docs': { lastSuccessAt: null, lastCount: 0, history: [], trailingMedian: null, ratio: null, degraded: true } },
      });
      const kv = makeFakeKV({ [HEALTH_KEY]: healthJson });
      const req = new Request('https://api.aboutcloud.io/entra-tracker/health', { headers: { Origin: 'https://tracker.aboutcloud.io' } });
      const res = await workerDefault.fetch(req, { ENTRA_CACHE: kv });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'degraded');
      assert.deepEqual(body.degraded, ['b2c-docs']);
      assert.equal(fetchCalls, 0, 'the /health route must never call fetch()');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('no stored health state yet -> "ok", empty, still zero fetches', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (...args) => { throw new Error('unexpected upstream fetch: ' + args[0]); };
    try {
      const kv = makeFakeKV({});
      const req = new Request('https://api.aboutcloud.io/entra-tracker/health', { headers: { Origin: 'https://tracker.aboutcloud.io' } });
      const res = await workerDefault.fetch(req, { ENTRA_CACHE: kv });
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.deepEqual(body.degraded, []);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('buildTrackerData (Phase 4): degraded/stale are additive-only, non-fatal on a missing/absent health KV', () => {
  test('no ENTRA_CACHE at all: degraded=[], every item gets stale:false, rest of the envelope matches a working-health-KV run', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    global.fetch = mockFetchFor;

    const noKV = await buildTrackerData([], {});
    assert.deepEqual(noKV.degraded, []);
    assert.ok(noKV.items.every(i => i.stale === false));

    const workingKV = makeFakeKV({});
    const withKV = await buildTrackerData([], { ENTRA_CACHE: workingKV });
    assert.deepEqual(withKV.degraded, []);
    assert.ok(withKV.items.every(i => i.stale === false));

    const strip = (data) => { const { lastUpdated, ...rest } = data; return rest; };
    assert.deepEqual(strip(noKV), strip(withKV));

    // Confirm the working-KV run actually persisted a health snapshot (not vacuous).
    assert.ok(workingKV._store.has(HEALTH_KEY));
  });
});
