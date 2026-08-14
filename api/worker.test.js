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
} from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, '__fixtures__', 'dedupe', name);
  return JSON.parse(readFileSync(p, 'utf8'));
}

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
    const items = loadFixture('intra-source-duplicate.json');
    const { items: kept, dedupeDropped } = dedupeIntraSource(items);
    assert.equal(kept.length, 1);
    assert.equal(dedupeDropped, 1);
  });

  test('does not touch distinct titles', () => {
    const items = loadFixture('cross-source-exact-merge.json'); // 2 different sources, same title
    const { items: kept, dedupeDropped } = dedupeIntraSource(items);
    // different sources -> stage 1 (intra-source only) must not collapse them
    assert.equal(kept.length, 2);
    assert.equal(dedupeDropped, 0);
  });
});

describe('mergeCrossSource (stage 2)', () => {
  test('merges an exact cross-source title match, higher-rank source wins', () => {
    const items = loadFixture('cross-source-exact-merge.json');
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 1);
    assert.equal(crossSourceMerged, 1);
    const survivor = merged[0];
    assert.equal(survivor.source, 'entra-whatsnew-md'); // rank 0 beats external-id-docs (rank 2)
    assert.deepEqual(new Set(survivor.sources), new Set(['entra-whatsnew-md', 'external-id-docs']));
    assert.equal(survivor.links.length, 2);
  });

  test('merges a near-duplicate title within the ±1 month window, and backfills a null deadline from the loser', () => {
    const items = loadFixture('cross-source-near-duplicate-merge.json');
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 1);
    assert.equal(crossSourceMerged, 1);
    const survivor = merged[0];
    assert.equal(survivor.source, 'entra-whatsnew-md'); // rank 0 beats graph-changelog (rank 1)
    // whatsnew-md's own deadline was null; graph-changelog had one -> backfilled
    assert.equal(survivor.deadline, '2026-09-30');
    assert.equal(survivor.daysRemaining, 47);
  });

  test('does NOT merge a near-duplicate title when announcedDate months are more than 1 apart', () => {
    const items = loadFixture('cross-source-month-window-reject.json');
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 2);
    assert.equal(crossSourceMerged, 0);
  });

  test('external-id-commits items are never merged into or absorbed by another source (carve-out)', () => {
    const items = loadFixture('eic-carveout.json'); // identical normalised titles, one is external-id-commits
    const { items: merged, crossSourceMerged } = mergeCrossSource(items);
    assert.equal(merged.length, 2, 'external-id-commits item must survive as its own item');
    assert.equal(crossSourceMerged, 0);
    assert.ok(merged.some(i => i.source === 'external-id-commits'));
    assert.ok(merged.some(i => i.source === 'entra-whatsnew-md'));
  });
});

describe('twoStageDedupe (end to end)', () => {
  test('runs stage 1 then stage 2 and reports both counters', () => {
    const items = [
      ...loadFixture('intra-source-duplicate.json'),
      ...loadFixture('cross-source-exact-merge.json'),
    ];
    const { items: result, dedupeDropped, crossSourceMerged } = twoStageDedupe(items);
    // 2 intra-source dupes -> 1, plus 2 cross-source exact dupes -> 1 = 2 survivors
    assert.equal(result.length, 2);
    assert.equal(dedupeDropped, 1);
    assert.equal(crossSourceMerged, 1);
  });
});

describe('sourceRank', () => {
  test('orders sources as specified: whatsnew-md > graph-changelog > docs changelogs > fslogix > commits', () => {
    assert.ok(sourceRank('entra-whatsnew-md') < sourceRank('graph-changelog'));
    assert.ok(sourceRank('graph-changelog') < sourceRank('external-id-docs'));
    assert.equal(sourceRank('external-id-docs'), sourceRank('b2c-docs'));
    assert.ok(sourceRank('b2c-docs') < sourceRank('fslogix-docs'));
    assert.ok(sourceRank('fslogix-docs') < sourceRank('external-id-commits'));
  });
});

describe('extractDeadline (regression guards, pre-existing behaviour)', () => {
  test('an ISO date elsewhere in the body does not win over category-gated retirement logic without expiry language', () => {
    // Documents current (pre-Phase-1) behaviour: retirement/breaking bypass the
    // proximity check entirely, so the FIRST matching format (ISO here) is
    // returned. This is the exact defect Phase 1 replaces with a scorer -- this
    // test exists so the Phase 1 diff has a clear "before" to compare against.
    const text = 'Published 2026-01-15. Starting March 2026 rollout begins; fully retired by November 2026.';
    const d = extractDeadline(text, 'retirement');
    assert.equal(d.toISOString().split('T')[0], '2026-01-15');
  });

  test('retirement with no date anywhere returns null', () => {
    assert.equal(extractDeadline('This feature is being retired with no stated date.', 'retirement'), null);
  });
});
