/**
 * Entra Tracker -- Cloudflare Worker v3
 * Endpoint: api.aboutcloud.io/entra-tracker
 *
 * Sources (all Microsoft official -- MicrosoftDocs GitHub repos + learn.microsoft.com):
 *   1. entra-docs: fundamentals/whats-new.md       -> core Entra ID (+ B2C/ExternalID items inside)
 *   2. learn.microsoft.com: FSLogix release notes  -> Azure Files / Entra Kerberos breaking-change callouts
 *   3. entra-docs: external-id/whats-new-docs.md   -> External ID docs changelog
 *   4. azure-docs: active-directory-b2c/whats-new-docs.md -> B2C docs changelog (B2C is end-of-sale)
 *   5. entra-docs: commits on external-id/customers -> External ID how-to docs (pre-changelog)
 *   6. developer.microsoft.com: Graph changelog RSS  -> Entra API/resource deprecations (e.g. PIM)
 *
 * NOTE: parseRSS()/transformRSSItems() are retained as reusable infrastructure
 * but are NOT wired into buildTrackerData today (no blog feed is ingested). The
 * Graph changelog (source 6) uses its own dedicated parser, not parseRSS.
 *
 * Parsing strategy:
 *   - Source 1: H3 + **Type:** + **Service category:** blocks (feature releases)
 *   - Source 2: HTML alert/callout divs + "action required" paragraphs
 *   - Sources 3-4: bullet "- [Title](url) - description" (docs change logs; "*" also accepted)
 *   - Source 6: RSS items, filtered to Entra resource/API-level deprecations only
 *   - Source 5: GitHub Commits API -- watches docs/external-id/customers for new how-tos
 *               and guides BEFORE they appear in the curated whats-new-docs.md index.
 *               Anonymous API rate limit: 60/hr; 4h cron + KV keeps us well under.
 *               Passkey/FIDO2 how-tos (e.g. how-to-sign-in-with-passkey.md) surface
 *               here as soon as they land in the repo, not just when MS adds them to
 *               the changelog index.
 */

const ALLOWED_ORIGINS = [
  'https://blog.aboutcloud.io',
    'https://aboutcloud.io',
  'https://tracker.aboutcloud.io',
  'https://entratracker.aboutcloud.io',
  'http://localhost:3000',
  'http://localhost:2368',
];

const CACHE_TTL_SECONDS = 4 * 60 * 60; // 4 hours -- HTTP Cache-Control max-age only
const KV_RETENTION_SECONDS = 30 * 24 * 60 * 60; // 30 days -- KV expirationTtl backstop only.
// Decoupled from CACHE_TTL_SECONDS on purpose: the 4h cron is the refresh mechanism, and
// the KV TTL is only a safety net so a single missed/failed cron run doesn't expire the
// key and force a cold start that resets every item's firstSeen.
const CACHE_KEY         = 'entra_tracker_v3';

// ── RETENTION HORIZONS ───────────────────────────────────────────────────────
// How long items stay in the feed before being dropped as objectively too old.
// DATED items (have a deadline) are kept until DEADLINE_RETENTION_DAYS past the
// deadline (the deadline is the true relevance anchor). DATELESS items age out by
// announcedDate, per category. Unknown announcedDate -> kept (rely on Microsoft
// pruning the source). All relative-day math, so year rollover is automatic.
const DEADLINE_RETENTION_DAYS = 365;          // drop dated items >365d past deadline
const RETENTION_DAYS = {
  retirement:  548,   // ~18 months -- keep deprecation guidance longest
  breaking:    548,   // ~18 months
  preview:     365,   // ~12 months -- old previews have GA'd or been dropped
  new_feature: 365,   // ~12 months -- a year-old GA is "how Entra works", not a change
};
const RETENTION_DEFAULT_DAYS = 365;

// ── SOURCES ────────────────────────────────────────────────────────────────

// Primary: GitHub raw markdown -- the actual What's New page
const WHATS_NEW_URL = 'https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/fundamentals/whats-new.md';

// FSLogix Release Notes -- fetched from learn.microsoft.com (markdown source is private repo)
// Parser handles HTML callout divs (is-warning, is-important, is-caution) and NOTE blocks
const FSLOGIX_RELEASE_NOTES_URL = 'https://learn.microsoft.com/en-us/fslogix/overview-release-notes';

// External ID docs changelog (bullet format)
const EXTERNAL_ID_DOCS_URL = 'https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/external-id/whats-new-docs.md';

// B2C docs changelog (bullet format)
const B2C_DOCS_URL = 'https://raw.githubusercontent.com/MicrosoftDocs/azure-docs/main/articles/active-directory-b2c/whats-new-docs.md';

// External ID customer docs -- direct commit watch (catches how-tos before curated changelog)
const COMMITS_API_URL = 'https://api.github.com/repos/MicrosoftDocs/entra-docs/commits?path=docs/external-id/customers&per_page=100';

// Microsoft Graph changelog (official dev-portal RSS) -- authoritative source for
// Graph API resource/endpoint DEPRECATIONS (e.g. the PIM iteration 2 API retirement)
// that never appear in whats-new.md. The feed is a 2500+ item firehose of granular
// API edits, so it is filtered HARD downstream (see parseGraphChangelog).
const GRAPH_CHANGELOG_URL = 'https://developer.microsoft.com/en-us/graph/changelog/rss/';

// Microsoft 365 Roadmap API (Phase 5) -- official, unauthenticated JSON. Real
// response shape and product-tag vocabulary verified live before writing any
// parsing code (see parseM365Roadmap()'s own comment for what was found).
const M365_ROADMAP_URL = 'https://www.microsoft.com/releasecommunications/api/v1/m365';

// Candidate official feeds that are NOT currently ingestable -- e.g. the Microsoft
// Entra blog RSS broke during the TechCommunity platform migration (all known URLs
// 404 or return an empty channel). Probed on each build (see probeCandidateFeeds):
// if Microsoft restores one, it surfaces a warnings[] entry telling the maintainer
// to wire it in. This is a health probe, not a source -- nothing is ingested here.
const CANDIDATE_FEEDS = [
  { name: 'entra-blog', urls: [
    'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=Identity',
    'https://techcommunity.microsoft.com/category/microsoft-entra/bd-p/Identity/rss',
    'https://techcommunity.microsoft.com/rss/board?board.id=Identity',
  ]},
];

// ── SERVICE TAXONOMY ─────────────────────────────────────────────────────────
// The single definition of what this tracker covers, and the vocabulary its
// service-category output is normalised against. Everything that used to be
// bespoke per-mechanism term lists (EXTERNAL_ID_SERVICE_CATEGORIES/
// EXTERNAL_ID_TITLE_KEYWORDS, GRAPH_ENTRA_RE) now derives from this.
//
// Ordered most-specific first, broadest last, used as the Tier-2 (title/
// description) tiebreak in classifyTaxonomy() -- 'entra-id-workforce' is
// deliberately last, since it's the broad workforce/administrative
// catch-all (audit, RBAC, reporting, user/group management, etc.) that
// most generic whats-new.md categories fall into when nothing more
// specific matches. Array order does NOT decide primary classification
// when a real Microsoft serviceCategory is available -- see the two-tier
// design in classifyTaxonomy() below.
//
// `serviceCategoryTerms` match against the raw Microsoft **Service
// category:** string (whats-new.md only) -- see classifyTaxonomy()'s Tier 1.
// `titleTerms` match against title+description -- Tier 2, and also what
// matchesAnyTaxonomyEntry() (the Graph changelog relevance gate) checks.
// Every entry needs `titleTerms`; `serviceCategoryTerms` is optional (most
// entries have no natural raw-category equivalent, e.g. Identity Protection
// isn't its own whats-new.md category).
const SERVICE_TAXONOMY = [
  {
    id: 'conditional-access',
    name: 'Conditional Access',
    serviceCategoryTerms: ['conditional access'],
    titleTerms: ['conditional access', 'conditionalaccess'],
  },
  {
    id: 'pim',
    name: 'Privileged Identity Management',
    serviceCategoryTerms: ['privileged identity management'],
    titleTerms: ['privileged identity management', 'privileged identity', 'privilegedaccess', ' pim '],
  },
  {
    id: 'identity-protection',
    name: 'Identity Protection',
    serviceCategoryTerms: [],
    titleTerms: ['identity protection', 'identityprotection', 'risky user', 'riskyuser', 'risky sign-in', 'named location', 'namedlocation'],
  },
  {
    id: 'entra-id-governance',
    name: 'Entra ID Governance',
    serviceCategoryTerms: ['entitlement management', 'entitlement management, lifecycle workflows', 'lifecycle workflows', 'tenant governance'],
    titleTerms: ['entitlement management', 'lifecycle workflow', 'access package', 'identity governance', 'tenant governance'],
  },
  {
    id: 'global-secure-access',
    name: 'Global Secure Access (Private Access / Internet Access)',
    serviceCategoryTerms: ['internet access', 'private access', 'ios client'],
    titleTerms: ['global secure access', 'private access', 'internet access', 'gsa '],
  },
  {
    id: 'entra-workload-id',
    name: 'Entra Workload ID',
    serviceCategoryTerms: [],
    titleTerms: ['workload identity', 'workload id', 'federated credential', 'managed identity'],
  },
  {
    id: 'entra-verified-id',
    name: 'Entra Verified ID',
    serviceCategoryTerms: [],
    titleTerms: ['verified id'],
  },
  {
    id: 'entra-domain-services',
    name: 'Entra Domain Services',
    serviceCategoryTerms: [],
    titleTerms: ['domain services'],
  },
  {
    id: 'entra-connect-cloud-sync',
    name: 'Entra Connect and Cloud Sync',
    serviceCategoryTerms: ['entra connect', 'microsoft identity manager'],
    titleTerms: ['entra connect', 'cloud sync', 'azure ad connect', 'identity manager', ' mim '],
  },
  {
    id: 'authentication-methods',
    name: 'Authentication methods',
    serviceCategoryTerms: ['authentications (logins)', 'mfa', 'microsoft authenticator app'],
    titleTerms: ['authentication method', 'authenticationmethod', 'multifactor', ' mfa ', 'mfa ', 'authenticator app',
      'kerberos', 'certificate-based authentication', 'passwordless'],
  },
  {
    id: 'graph-identity-apis',
    name: 'Microsoft Graph identity APIs',
    serviceCategoryTerms: ['ms graph'],
    // 'signin'/'sign-in' deliberately excluded: 'signin' (no separator, meant
    // to catch the Graph schema resource name) is a substring of the common
    // English word "assigning" (as-SIGNIN-g), and hyphenated 'sign-in' is
    // common Entra prose generally, not specific to Graph API content --
    // both produced false primary-classification hits in testing against
    // real whats-new.md text. 'graph api'/'microsoft graph' cover genuine
    // Graph-relevant items without that risk.
    titleTerms: ['graph api', 'microsoft graph', 'directoryrole', 'directory role'],
  },
  {
    id: 'identity-platform-msal',
    name: 'Microsoft identity platform / MSAL',
    serviceCategoryTerms: [],
    // 'app registration' deliberately excluded: too generic on its own --
    // app registrations get mentioned in passing across many unrelated
    // entries (audit logs, provisioning, etc.), not just identity-platform/
    // MSAL-specific ones. 'msal'/'identity platform'/'openid connect' are
    // specific enough to keep.
    titleTerms: ['msal', 'identity platform', 'openid connect'],
  },
  {
    // Kept deliberately broad and separate from workforce -- this is the only
    // entry with the field-scoped terms isExternalId() relies on for exact
    // namespace-assignment parity. See the block comment above.
    id: 'entra-external-id',
    name: 'Entra External ID / Azure AD B2C',
    serviceCategoryTerms: [
      'b2c', 'external id', 'external-id', 'ciam', 'consumer identity',
      'b2b', 'b2b collaboration', 'b2b direct connect', 'cross-tenant',
      'workforce and external',
    ],
    titleTerms: [
      'b2c', 'external id', 'external tenant', 'customer identity',
      'guest user', 'external user', 'cross-tenant', 'crosstenant', 'b2b',
      'user flow', 'custom policy', 'identity experience framework',
      'passkey', 'fido2', 'webauthn', 'native auth', 'native authentication',
    ],
  },
  {
    // Broadest catch-all, checked LAST. Covers whats-new.md's generic
    // administrative categories (audit, RBAC, reporting, user/group
    // management, provisioning, device management, etc.) plus the bare
    // "Entra"/"Azure AD" mentions that made GRAPH_ENTRA_RE's own catch-all
    // (`\bentra\b|microsoft entra`) work for the Graph changelog firehose.
    id: 'entra-id-workforce',
    name: 'Entra ID (workforce)',
    serviceCategoryTerms: [
      'audit', 'byod', 'byod support', 'device access management',
      'device registration and management', 'entra backup and recovery',
      'group management', 'modernized my account pages', 'my profile/account',
      'other', 'provisioning', 'rbac', 'reporting',
      'user experience and management', 'user management',
    ],
    titleTerms: [
      'entra id', 'azure ad', 'azure active directory', 'microsoft entra', 'entra',
      'agent id', 'agent registry', 'directory role', 'directoryrole', 'azure ad role',
    ],
  },
];

// Every taxonomy entry an item matches. Returns [] if nothing matches --
// callers decide what to do with that (buildTrackerData drops the item and
// counts it).
//
// Two-tier, not flat array-order: real Microsoft prose routinely mentions
// OTHER Entra features in passing inside a body paragraph (e.g. an "Entra
// Backup and Recovery" entry listing "Conditional Access policies, named
// locations" among the objects it backs up) -- if every entry's terms were
// checked against the same combined text with array position as the only
// tiebreak, those incidental mentions would win primary classification over
// the entry the item is actually ABOUT. So:
//   Tier 1: match the raw Microsoft **Service category:** string (whats-new.md
//           only) against each entry's serviceCategoryTerms. This is
//           Microsoft's own authoritative categorisation -- when present, it
//           always decides the primary.
//   Tier 2: match combined title+description against each entry's
//           titleTerms. Used for primary when Tier 1 found nothing (every
//           other source, and any whats-new.md category not in our map).
// Both tiers' matches are returned (Tier 1 first), so a title/description
// match still contributes to the additive serviceCategories[] list even
// when a serviceCategory match wins primary.
function classifyTaxonomy(title, description, serviceCategory) {
  const svcCat = (serviceCategory || '').toLowerCase();
  const text = `${title || ''} ${description || ''}`.toLowerCase();

  const svcMatches   = SERVICE_TAXONOMY.filter(e => (e.serviceCategoryTerms || []).some(t => svcCat.includes(t)));
  const titleMatches = SERVICE_TAXONOMY.filter(e => (e.titleTerms || []).some(t => text.includes(t)));

  const seen = new Set();
  const merged = [];
  for (const e of [...svcMatches, ...titleMatches]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
  return merged;
}

// True if free-form text (title/description prose) matches ANY taxonomy
// entry's titleTerms. Replaces GRAPH_ENTRA_RE -- the Graph changelog
// relevance gate now consumes the same single taxonomy definition instead
// of its own regex.
//
// Deliberately checks titleTerms only, never serviceCategoryTerms:
// serviceCategoryTerms are short labels meant to exact/near-exact-match
// Microsoft's own **Service category:** field (e.g. 'provisioning'), not to
// be scanned as substrings of arbitrary prose -- 'provisioning' is also a
// substring of the unrelated Graph resource name "cloudPcProvisioningPolicy",
// which caused a real false-positive match during testing (an off-topic
// Windows 365 Cloud PC item nearly got pulled in as Entra-relevant).
function matchesAnyTaxonomyEntry(text) {
  const lower = String(text || '').toLowerCase();
  return SERVICE_TAXONOMY.some(entry => (entry.titleTerms || []).some(t => lower.includes(t)));
}

// Namespace assignment (external-id vs entra-id) -- UNCHANGED behaviour from
// before Phase 2, just sourced from the taxonomy's entra-external-id entry
// instead of standalone EXTERNAL_ID_SERVICE_CATEGORIES/EXTERNAL_ID_TITLE_KEYWORDS
// constants. serviceCategory is checked only against serviceCategoryTerms;
// title is checked only against titleTerms -- the same two field-scoped
// checks as before, not a general taxonomy match, so this cannot pick up any
// term from any OTHER taxonomy entry.
const EXTERNAL_ID_TAXONOMY_ENTRY = SERVICE_TAXONOMY.find(e => e.id === 'entra-external-id');
function isExternalId(title, serviceCategory) {
  const t = (title || '').toLowerCase();
  const s = (serviceCategory || '').toLowerCase();
  return EXTERNAL_ID_TAXONOMY_ENTRY.serviceCategoryTerms.some(k => s.includes(k))
      || EXTERNAL_ID_TAXONOMY_ENTRY.titleTerms.some(k => t.includes(k));
}

// Routes every parsed item through the taxonomy exactly once. An item
// matching nothing is dropped -- never silently: counted per source in
// `unmatched` and a bounded sample (title + source, capped at 10 total)
// is kept in `unmatchedSamples` so the taxonomy can be extended from
// evidence. Overwrites the scalar `serviceCategory` with the primary
// match's canonical name (classifyTaxonomy()'s first returned entry --
// Tier 1 serviceCategory match if one exists, else the first Tier 2
// title/description match) -- this NORMALISES Microsoft's raw, inconsistent
// category strings (whats-new.md alone uses 30+ of them) into the
// taxonomy's fixed vocabulary. Adds the additive `serviceCategories: []`
// with every match, not just the primary.
function routeThroughTaxonomy(items) {
  const matched = [];
  const unmatched = {};
  const unmatchedSamples = [];
  for (const item of items) {
    const matches = classifyTaxonomy(item.title, item.description, item.serviceCategory);
    if (matches.length === 0) {
      unmatched[item.source] = (unmatched[item.source] || 0) + 1;
      if (unmatchedSamples.length < 10) unmatchedSamples.push({ title: item.title, source: item.source });
      continue;
    }
    item.serviceCategory = matches[0].name;
    item.serviceCategories = matches.map(m => m.name);
    matched.push(item);
  }
  return { items: matched, unmatched, unmatchedSamples };
}

// ── CLASSIFIERS ────────────────────────────────────────────────────────────
const CLASSIFIERS = {
  retirement: ['retir', 'deprecat', 'end of support', 'end of sale', 'shut down',
               'being removed', 'no longer support', 'stop support', 'last day',
               'sunset', 'end of life'],
  breaking:   ['action required', 'breaking change', 'will fail', 'stop working',
               'must migrate', 'must update', 'required action', 'disruption',
               'enforcement', 'will be blocked', 'will break', 'plan for change'],
  preview:    ['public preview', 'private preview', 'in preview', 'preview)', '(preview'],
};

// Map Type: field values from the markdown
const TYPE_TO_CATEGORY = {
  'plan for change':  'breaking',
  'deprecated':       'retirement',
  'retirement':       'retirement',
  'public preview':   'preview',
  'private preview':  'preview',
  'general availability': 'new_feature',
  'new feature':      'new_feature',
  'changed feature':  'new_feature',
};

const MONTHS = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

// ── DATE HELPERS ────────────────────────────────────────────────────────────

// Convert "March 2026" / "Mar 2026" -> "2026-03-01" (announcement month, never a deadline)
function monthHeaderToISO(header) {
  if (!header) return null;
  const m = header.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[2]}-${String(mo).padStart(2, '0')}-01`;
}

// Parse RSS/Atom pubDate string -> "yyyy-mm-dd" or null
function pubDateToISO(pubDate) {
  if (!pubDate) return null;
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch (e) { return null; }
}

// High similarity bar for "this is the same item, reworded" matching in
// applyDiff (see below). Validated against a real MicrosoftDocs commit
// (entra-docs@ac6b47d6, "Update jailbreak detection heading to include root
// detection": "Upcoming Changes - Jailbreak Detection in Authenticator App"
// -> "Upcoming Changes – Jailbreak/root Detection in Authenticator App")
// which scores 0.75 under titleSimilarity() -- a genuine minor Microsoft
// rewording, not a hand-picked example. 0.82 (Phase 0.1's cross-source
// threshold) would have missed it, so this is a separate, lower constant:
// the two thresholds guard different failure modes (cross-source over-
// merging distinct changes vs. same-source identity continuity across a
// rewording) and there's no reason to assume they should coincide. Checked
// against real Preview->GA title pairs for the same feature (e.g. "Public
// Preview - Account Discovery" vs "General Availability - Account
// Discovery", similarity 0.33) to confirm 0.70 does NOT collapse genuinely
// distinct lifecycle-stage announcements into one item.
const TITLE_REWORD_SIMILARITY_THRESHOLD = 0.70;

// Diff current items against the previous snapshot. Tags isNew, and carries
// firstSeen (and titleHistory) forward so an item's identity is stable
// across runs even when Microsoft reworks its title.
//
// Matching is two-tier: an exact id match first (title unchanged, or at
// least normalises the same), then -- only if that misses -- a similarity
// fallback within the same source: a previous item with the same
// announcedDate month and a title similarity >=TITLE_REWORD_SIMILARITY_THRESHOLD
// is treated as the same item. This is also what makes the makeId() formula
// change (this same phase, see makeId) a non-event for firstSeen continuity:
// every existing item's title is unchanged, so it trivially clears the
// similarity bar (similarity 1.0) and firstSeen carries forward even though
// every id value changes on this deploy. See the PR description for why
// this isn't a second cold start.
//
// `coldStart` changes how firstSeen is seeded when NEITHER match succeeds:
// normally that means a genuinely new item (firstSeen = today), but on a
// cold start (no usable prior snapshot) it instead means "we have no history
// to compare against", so firstSeen is estimated from announcedDate where
// possible (see 1e) instead of flattening every item to today's date.
function applyDiff(currentItems, prevItems, coldStart) {
  const prevList = prevItems || [];
  const prevById = new Map(prevList.map(i => [i.id, i]));
  const prevBySource = new Map();
  for (const p of prevList) {
    const bucket = prevBySource.get(p.source);
    if (bucket) bucket.push(p); else prevBySource.set(p.source, [p]);
  }
  const usedPrevIds = new Set();
  const nowISO = new Date().toISOString().split('T')[0];

  for (const item of currentItems) {
    let prev = prevById.get(item.id);
    let matchedBySimilarity = false;

    if (!prev) {
      const candidates = prevBySource.get(item.source) || [];
      let best = null, bestSim = 0;
      for (const cand of candidates) {
        if (usedPrevIds.has(cand.id)) continue;
        if (monthDiff(item.announcedDate, cand.announcedDate) !== 0) continue; // requires both present and equal
        const sim = titleSimilarity(item.title, cand.title);
        if (sim >= TITLE_REWORD_SIMILARITY_THRESHOLD && sim > bestSim) { best = cand; bestSim = sim; }
      }
      if (best) { prev = best; matchedBySimilarity = true; }
    }

    if (prev) usedPrevIds.add(prev.id);
    item.isNew = !prev;

    if (prev && prev.firstSeen) {
      item.firstSeen = prev.firstSeen;
      item.firstSeenEstimated = false;
    } else if (coldStart && item.announcedDate && item.announcedDate < nowISO) {
      // Cold start, nothing to carry forward: seed from announcedDate
      // instead of flattening every item's firstSeen to today (see 1e).
      item.firstSeen = item.announcedDate;
      item.firstSeenEstimated = true;
    } else {
      item.firstSeen = nowISO;
      item.firstSeenEstimated = false;
    }

    const priorHistory = (prev && Array.isArray(prev.titleHistory)) ? prev.titleHistory : [];
    const reworded = matchedBySimilarity && prev
      && normalizeTitleForDedup(prev.title) !== normalizeTitleForDedup(item.title);
    item.titleHistory = reworded ? [...priorHistory, prev.title] : priorHistory;
  }
  return currentItems;
}

// Integer whole-day count from today (UTC midnight) to a deadline (UTC
// midnight), so the number is stable all day regardless of viewer timezone.
// Negative = past. Both operands floored to UTC date, so use round (no
// fractional remainder).
function daysUntilUTC(deadline) {
  if (!deadline) return null;
  const now = new Date();
  const nowUTC  = Date.UTC(now.getUTCFullYear(),  now.getUTCMonth(),  now.getUTCDate());
  const deadUTC = Date.UTC(deadline.getUTCFullYear(), deadline.getUTCMonth(), deadline.getUTCDate());
  return Math.round((deadUTC - nowUTC) / 86400000);
}

// Expiry/cutoff language that justifies treating a nearby date as a DEADLINE
// (as opposed to an announcement/release/rollout-start date).
const DEADLINE_LANGUAGE = [
  'retire', 'retired', 'retirement', 'retiring',
  'deprecat',                       // deprecate/deprecated/deprecation
  'end of support', 'end of life', 'end of sale', 'eol',
  'will be removed', 'being removed', 'no longer support',
  'no longer work', 'no longer available', 'stop working', 'stop support',
  'must migrate', 'must update', 'must upgrade', 'required action',
  'sunset', 'cutoff', 'cut-off', 'last day', 'will fail', 'will break',
  'will be blocked', 'will be enforced', 'enforcement begins'
];

// Rollout/announcement language that means a nearby date is when something
// STARTS, not when it ENDS -- the negative-scoring counterpart to
// DEADLINE_LANGUAGE. "Starting March 2026 we begin rollout" should not
// outscore "fully retired by November 2026" just because it comes first.
const ROLLOUT_LANGUAGE = [
  'starting', 'beginning', 'rolling out', 'available from',
  'announced', 'now generally available',
];

// Distance in characters from [offset, offset+length) to the nearest
// occurrence of any keyword in `lower` (already-lowercased haystack). 0 if a
// keyword overlaps the span itself. null if no keyword occurs anywhere.
function nearestKeywordDistance(lower, offset, length, keywords) {
  let best = null;
  const spanEnd = offset + length;
  for (const kw of keywords) {
    let idx = lower.indexOf(kw);
    while (idx !== -1) {
      const kwEnd = idx + kw.length;
      let dist;
      if (kwEnd <= offset) dist = offset - kwEnd;
      else if (idx >= spanEnd) dist = idx - spanEnd;
      else dist = 0;
      if (best === null || dist < best) best = dist;
      idx = lower.indexOf(kw, idx + 1);
    }
  }
  return best;
}

// Tiered weight: closer keywords score higher, distant ones taper to 0.
// Same tiering used for both the positive (deadline-language) and negative
// (rollout-language) proximity signals -- only the sign differs at the call site.
function proximityWeight(distance) {
  if (distance == null) return 0;
  if (distance <= 20)  return 6;
  if (distance <= 60)  return 4;
  if (distance <= 160) return 2;
  return 0;
}

// The sentence (naive '.'/'!'/'?'-delimited) containing character offset
// `at` in `text`. Falls back to the whole text if no boundary is found (e.g.
// a single-sentence fragment). Used both for deadline evidence quotes and
// classification-provenance quotes.
function sentenceContaining(text, at) {
  const re = /[.!?](?:\s+|$)/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + 1;
    if (at >= start && at < end) return text.slice(start, end).trim();
    start = re.lastIndex;
  }
  if (at >= start) return text.slice(start).trim();
  return text.trim();
}

// True if `keywords` contains a phrase occurring anywhere inside `sentence`
// (case-insensitive). Used for the same-sentence cessation-verb bonus.
function sentenceContainsAny(sentence, keywords) {
  const lower = sentence.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// Same year+month as an ISO "yyyy-mm-dd"/"yyyy-mm-01" announcedDate string.
function sameYearMonth(date, announcedDateStr) {
  if (!announcedDateStr) return false;
  const [y, m] = announcedDateStr.split('-').map(Number);
  if (!y || !m) return false;
  return date.getFullYear() === y && (date.getMonth() + 1) === m;
}

// Collect every date candidate across all four formats (ISO, MDY, DMY, MY),
// each with its character offset (into `text`, not lowercased -- offsets are
// identical either way since lowercasing preserves length for ASCII) and its
// precision. Unlike the old code's un-flagged .match(), this uses matchAll
// so a date anywhere else in the body can no longer silently outrank the
// date that is actually the deadline just by matching an earlier-precedence
// format.
function collectDateCandidates(text) {
  const lower = text.toLowerCase();
  const candidates = [];
  const monthNames = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';

  for (const m of lower.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
    const d = new Date(`${m[0]}T00:00:00`);
    if (!isNaN(d)) candidates.push({ offset: m.index, length: m[0].length, date: d, precision: 'day' });
  }

  const mdyRe = new RegExp(`(${monthNames})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'g');
  for (const m of lower.matchAll(mdyRe)) {
    const d = new Date(+m[3], MONTHS[m[1]] - 1, +m[2]);
    if (!isNaN(d)) candidates.push({ offset: m.index, length: m[0].length, date: d, precision: 'day' });
  }

  const dmyRe = new RegExp(`(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})`, 'g');
  for (const m of lower.matchAll(dmyRe)) {
    const d = new Date(+m[3], MONTHS[m[2]] - 1, +m[1]);
    if (!isNaN(d)) candidates.push({ offset: m.index, length: m[0].length, date: d, precision: 'day' });
  }

  // MY candidates that fall INSIDE an already-collected day-precision span
  // are the same date matched twice (e.g. "15 March 2026" also matches
  // "March 2026") -- skip those, keep only standalone month-year mentions.
  const dayPrecisionSpans = candidates.map(c => [c.offset, c.offset + c.length]);
  const myRe = new RegExp(`(${monthNames})\\s+(\\d{4})`, 'g');
  for (const m of lower.matchAll(myRe)) {
    const start = m.index, end = m.index + m[0].length;
    const subsumed = dayPrecisionSpans.some(([s, e]) => start >= s && end <= e);
    if (subsumed) continue;
    // End-of-month convention: new Date(year, monthIndex(1-based), 0) is the
    // last day of the PREVIOUS month param, i.e. the last day of the stated
    // month -- e.g. "March 2026" -> new Date(2026, 3, 0) -> 2026-03-31.
    const d = new Date(+m[2], MONTHS[m[1]], 0);
    if (!isNaN(d)) candidates.push({ offset: m.index, length: m[0].length, date: d, precision: 'month' });
  }

  return candidates;
}

// Replaces the old first-match-wins extractDeadline. Scores every date
// candidate in the text and picks the best one, rather than accepting
// whichever format happens to match first (the old bug: an ISO date
// anywhere in the body beat the MDY date that was actually the deadline)
// and rather than bypassing the language check entirely for
// retirement/breaking (the old bug: ANY date in a retirement entry was
// accepted as the deadline, rollout language and all).
//
// Returns { deadline, deadlineConfidence, deadlineEvidence, deadlinePrecision }.
// `deadline` is a Date or null -- callers convert to ISO/compute
// daysRemaining exactly as before.
function extractDeadline(text, category, announcedDate) {
  const lower = text.toLowerCase();
  const candidates = collectDateCandidates(text);
  const nullResult = { deadline: null, deadlineConfidence: null, deadlineEvidence: null, deadlinePrecision: null };
  if (candidates.length === 0) return nullResult;

  const nowMs = Date.now();
  const scored = candidates.map(c => {
    const sentence = sentenceContaining(text, c.offset);
    const deadlineDist = nearestKeywordDistance(lower, c.offset, c.length, DEADLINE_LANGUAGE);
    const rolloutDist  = nearestKeywordDistance(lower, c.offset, c.length, ROLLOUT_LANGUAGE);
    const sameSentenceCessation = sentenceContainsAny(sentence, DEADLINE_LANGUAGE);
    const isFuture = c.date.getTime() > nowMs;

    let score = 0;
    score += proximityWeight(deadlineDist);          // positive: near deadline language
    if (sameSentenceCessation) score += 4;             // positive: cessation verb, same sentence
    if (c.precision === 'day') score += 2;              // positive: day-level precision
    score += isFuture ? 2 : -3;                          // positive/negative: future vs past
    score -= proximityWeight(rolloutDist);              // negative: near rollout language
    if (sameYearMonth(c.date, announcedDate)) score -= 3; // negative: same month as announcedDate

    let confidence;
    if (sameSentenceCessation) confidence = 'stated';
    else if (deadlineDist !== null && deadlineDist <= 160) confidence = 'derived';
    else confidence = 'inferred';

    return { ...c, score, sentence, confidence };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: for retirement/breaking, prefer the LATEST qualifying
    // future date, not the earliest -- a cutoff can't be walked back by an
    // earlier date incidentally scoring the same.
    if (category === 'retirement' || category === 'breaking') {
      return b.date.getTime() - a.date.getTime();
    }
    return 0;
  });

  const best = scored[0];

  // Outside retirement/breaking, a weakly-supported ("inferred") candidate
  // is not enough to assert a deadline -- e.g. a preview/new-feature entry
  // that happens to mention an unrelated date nearby shouldn't grow a
  // countdown. Only retirement/breaking accept an inferred date, because
  // those categories are much more likely to genuinely have a real cutoff
  // even when the prose doesn't spell it out clearly.
  if (category !== 'retirement' && category !== 'breaking' && best.confidence === 'inferred') {
    return nullResult;
  }

  return {
    deadline:           best.date,
    deadlineConfidence: best.confidence,
    deadlineEvidence:   best.sentence,
    deadlinePrecision:  best.precision,
  };
}

function deriveStatus(deadline) {
  if (!deadline) return 'green';
  const days = daysUntilUTC(deadline);
  if (days < -365) return 'expired';        // capped out of items[] later; status set defensively
  if (days <= -90) return 'expired';         // passed 91-365 days ago
  if (days <= 0)   return 'expired_recent';  // passed within last 90 days
  if (days <= 90)  return 'red';
  if (days <= 180) return 'yellow';
  return 'green';
}

function deriveImpact(category, text) {
  const l = text.toLowerCase();
  if (category === 'retirement' || category === 'breaking'
    || l.includes('all tenant') || l.includes('all user')
    || l.includes('critical') || l.includes('will fail')
    || l.includes('will break') || l.includes('every tenant')) return 'high';
  if (l.includes('some tenant') || l.includes('certain') || l.includes('specific')) return 'medium';
  return 'low';
}

function classifyByKeyword(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (CLASSIFIERS.retirement.some(k => text.includes(k))) return 'retirement';
  if (CLASSIFIERS.breaking.some(k => text.includes(k)))   return 'breaking';
  if (CLASSIFIERS.preview.some(k => text.includes(k)))    return 'preview';
  return 'new_feature';
}

// ── CLASSIFICATION PROVENANCE (evidence tiers) ──────────────────────────────
// Every item carries an `evidence` object recording HOW STRONG Microsoft's
// own signal was (tier) and WHICH mechanism produced the classification
// (basis), plus the literal quote and a link back to the source.
//
// Tier A: announced as a change with structured metadata (a **Type:** block,
//         a Graph changelog deprecation sentence).
// Tier B: official documentation content asserting the change, without
//         structured metadata (a doc changelog bullet, an FSLogix callout,
//         or a whats-new.md entry that lacked a parseable Type: field).
// Tier C: a repo signal that a document moved (the commits watch) -- an
//         indicator that something is coming, not an announcement of it.
const EVIDENCE_TIER_RANK = { A: 0, B: 1, C: 2 };
function evidenceTierRank(tier) {
  return EVIDENCE_TIER_RANK[tier] ?? 3;
}

// Finds the sentence that justifies a keyword-heuristic classification: the
// first sentence containing one of the category's own CLASSIFIERS keywords.
// Falls back to a leading slice of the text if no keyword sentence is found
// (e.g. classification fell through to the new_feature default).
function classificationQuote(category, contentText) {
  const keywords = CLASSIFIERS[category];
  if (keywords) {
    const lower = contentText.toLowerCase();
    for (const kw of keywords) {
      const idx = lower.indexOf(kw);
      if (idx !== -1) return sentenceContaining(contentText, idx).slice(0, 240);
    }
  }
  return contentText.slice(0, 160).trim();
}

function buildEvidence(tier, basis, quote, sourceUrl) {
  return { tier, basis, quote: (quote || '').slice(0, 240), sourceUrl: sourceUrl || null };
}

// Full-title normalisation for cross-run dedup keys: strip the leading
// "[Subtype]" prefix, lowercase, strip punctuation, collapse whitespace.
// Using the full title (not a 60-char slice) avoids collapsing distinct
// entries that share a long common prefix.
function normalizeTitleForDedup(title) {
  return String(title || '')
    .replace(/^\[[^\]]+\]\s+/, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// FNV-1a 32-bit over a string -> stable 8-hex-char id. Pure hash function,
// no identity semantics -- see makeId() for what gets hashed and why.
function fnv1a(s) {
  s = String(s || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

// Item identity: source + canonical link + normalised title, hashed. This
// replaces the old makeId(title) (a bare hash of the title alone, sometimes
// with an ad hoc prefix like `graph:` or `eic:` bolted on per-parser to fake
// source-scoping). A bare title hash meant ANY Microsoft rewording of a
// whats-new.md heading minted a new id, resetting firstSeen and re-firing
// the RSS feed for an item that hadn't actually changed in substance.
//
// Composing from source+link+title doesn't eliminate that on its own --
// most parsers' `link` is a constant per-source base URL, so title still
// does the discriminating work for those sources. What actually fixes the
// rewording problem is the similarity fallback in applyDiff(); this
// function only defines what "the same identity" is computed FROM.
//
// The id FORMAT is unchanged (8 hex chars) and stays stable for items whose
// (source, link, title) triple doesn't change. It is NOT byte-stable across
// THIS deploy for existing items, because the hash input formula itself
// changed (every parser used a different ad hoc input before). That one-time
// value change is absorbed by applyDiff's similarity fallback -- see the
// comment on TITLE_REWORD_SIMILARITY_THRESHOLD and the PR description.
function makeId(source, link, title) {
  return fnv1a(`${source}|${link || ''}|${normalizeTitleForDedup(title)}`);
}

// ── TWO-STAGE DEDUPE ─────────────────────────────────────────────────────────
// Stage 1 collapses identical titles repeated within one source (rare -- a
// real parser bug, not routine). Stage 2 merges the SAME Microsoft change as
// reported by more than one source (routine -- e.g. whats-new.md and a docs
// changelog both cover it). These are different phenomena with different
// expected frequencies, so they get separate counters: dedupeDropped (stage 1)
// and crossSourceMerged (stage 2).

// Until Phase 1 lands evidence tiers, rank sources by how authoritative/
// structured their provenance is. The winner of a merge supplies id, title,
// category, status, impact, namespace, etc.; the loser only contributes to
// sources[]/links[] and backfills null deadline/announcedDate.
const CROSS_SOURCE_RANK = {
  'entra-whatsnew-md':   0,
  'graph-changelog':     1,
  'external-id-docs':    2,
  'b2c-docs':            2,
  'fslogix-docs':        3,
  'external-id-commits': 4,
  // Lowest priority, explicit rather than relying on the implicit ?? 99
  // fallback -- if a roadmap item is EVER the winning side of a cross-source
  // merge (it shouldn't be: roadmap items that correlate attach to
  // announcements[] instead of merging, see correlateRoadmapItems), it
  // should never out-rank a Microsoft first-party source's own fields.
  'm365-roadmap':        5,
};
function sourceRank(source) {
  return CROSS_SOURCE_RANK[source] ?? 99;
}

// Token-set Jaccard similarity on normalised titles. 0..1. Used only for the
// cross-source near-duplicate path (exact-match is checked separately and
// doesn't need this).
function titleSimilarity(a, b) {
  const ta = new Set(normalizeTitleForDedup(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitleForDedup(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
// High bar on purpose: this is the only thing standing between "same change,
// worded differently by two sources" and "two different changes about the
// same feature area getting silently welded together". False negatives (a
// missed merge -> a duplicate card) are far cheaper than false positives (a
// bad merge -> a real distinct item silently disappearing).
const CROSS_SOURCE_SIMILARITY_THRESHOLD = 0.82;

// Absolute difference in months between two "yyyy-mm-dd"/"yyyy-mm-01" dates,
// or null if either is missing (near-duplicate matching requires both).
function monthDiff(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const [ya, ma] = dateA.split('-').map(Number);
  const [yb, mb] = dateB.split('-').map(Number);
  if (!ya || !ma || !yb || !mb) return null;
  return Math.abs((ya * 12 + (ma - 1)) - (yb * 12 + (mb - 1)));
}

// Stage 1: intra-source exact dedupe -- collapse items whose normalised title
// is identical WITHIN the same source. Returns the survivors plus a count of
// how many were dropped.
function dedupeIntraSource(items) {
  const kept = [];
  const seen = new Set();
  let dropped = 0;
  for (const item of items) {
    const key = `${item.source}:${normalizeTitleForDedup(item.title)}`;
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    kept.push(item);
  }
  return { items: kept, dedupeDropped: dropped };
}

// Stage 2: cross-source merge -- the SAME change reported by more than one
// Microsoft source becomes one item, carrying sources[]/links[] listing every
// contributor. external-id-commits items are exempt in both directions (never
// absorbed into another source's item, never absorb one) -- they are how-to
// docs surfaced ahead of the curated changelog, not the same announcement.
function mergeCrossSource(items) {
  const survivors = [];
  let crossSourceMerged = 0;

  for (const item of items) {
    let matchIdx = -1;

    if (item.source !== 'external-id-commits') {
      for (let i = 0; i < survivors.length; i++) {
        const candidate = survivors[i];
        if (candidate.source === 'external-id-commits') continue;
        if (candidate.source === item.source) continue; // stage 1 already handled same-source

        const exact = normalizeTitleForDedup(candidate.title) === normalizeTitleForDedup(item.title);
        const near  = !exact
          && titleSimilarity(candidate.title, item.title) >= CROSS_SOURCE_SIMILARITY_THRESHOLD
          && (monthDiff(candidate.announcedDate, item.announcedDate) ?? Infinity) <= 1;

        if (exact || near) { matchIdx = i; break; }
      }
    }

    if (matchIdx === -1) {
      survivors.push({ ...item, sources: [item.source], links: [item.link].filter(Boolean) });
      continue;
    }

    crossSourceMerged++;
    const existing = survivors[matchIdx];
    // Winner selection: higher evidence tier wins; the fixed CROSS_SOURCE_RANK
    // table (Phase 0.1's placeholder, kept for exactly this) only breaks ties
    // within the same tier. This is the wholesale swap Phase 0.1 anticipated.
    const itemTierRank     = evidenceTierRank(item.evidence && item.evidence.tier);
    const existingTierRank = evidenceTierRank(existing.evidence && existing.evidence.tier);
    const winnerIsIncoming = itemTierRank !== existingTierRank
      ? itemTierRank < existingTierRank
      : sourceRank(item.source) < sourceRank(existing.source);
    const base  = winnerIsIncoming ? item : existing;
    const other = winnerIsIncoming ? existing : item;

    survivors[matchIdx] = {
      ...base,
      sources:       Array.from(new Set([...existing.sources, item.source])),
      links:         Array.from(new Set([...existing.links, item.link].filter(Boolean))),
      deadline:      base.deadline ?? other.deadline,
      daysRemaining: base.deadline ? base.daysRemaining : other.daysRemaining,
      status:        base.deadline ? base.status        : other.status,
      announcedDate: base.announcedDate ?? other.announcedDate,
    };
  }

  return { items: survivors, crossSourceMerged };
}

function twoStageDedupe(allItems) {
  const stage1 = dedupeIntraSource(allItems);
  const stage2 = mergeCrossSource(stage1.items);
  return {
    items:            stage2.items,
    dedupeDropped:    stage1.dedupeDropped,
    crossSourceMerged: stage2.crossSourceMerged,
  };
}

// ── CSV HELPER ──────────────────────────────────────────────────────────────
function toCSV(items) {
  const COLS = ['title','category','impact','status','announcedDate','firstSeen','deadline','daysRemaining','namespace','link'];
  function field(v) {
    const s = v == null ? '' : String(v);
    return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  return [COLS.join(','), ...items.map(it => COLS.map(c => field(it[c])).join(','))].join('\r\n');
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toRSS(items, namespace) {
  const SITE = 'https://entratracker.aboutcloud.io';
  const SELF = 'https://api.aboutcloud.io/entra-tracker?format=rss'
               + (namespace === 'external-id' ? '&namespace=external-id' : '');
  const titleSuffix = namespace === 'external-id' ? ' (External ID)' : '';
  // newest-first by firstSeen, capped at 50. Falls back to announcedDate as
  // a secondary sort key when firstSeen values tie -- guards against a
  // future cold start flattening every item's firstSeen to one date and
  // collapsing the feed order to arbitrary arrival order (the 2026-08-14
  // incident, PR #22).
  const sorted = items.slice().sort((a, b) => {
    const da = a.firstSeen || a.announcedDate || '';
    const db = b.firstSeen || b.announcedDate || '';
    const cmp = db.localeCompare(da);
    if (cmp !== 0) return cmp;
    const aa = a.announcedDate || '';
    const ab = b.announcedDate || '';
    return ab.localeCompare(aa);
  }).slice(0, 50);
  const now = new Date().toUTCString();
  const entries = sorted.map(it => {
    const dateStr = it.firstSeen || it.announcedDate || new Date().toISOString().split('T')[0];
    const pub = new Date(dateStr + 'T00:00:00Z').toUTCString();
    const deadlineNote = it.deadline ? ` (deadline ${it.deadline}, ${it.daysRemaining} days left)` : '';
    const desc = (it.description || '') + deadlineNote;
    return [
      '    <item>',
      '      <title>' + xmlEscape(it.title) + '</title>',
      '      <link>' + xmlEscape(it.link || SITE) + '</link>',
      '      <guid isPermaLink="false">' + xmlEscape(it.id) + '</guid>',
      '      <pubDate>' + pub + '</pubDate>',
      '      <category>' + xmlEscape(it.category) + '</category>',
      '      <description>' + xmlEscape(desc) + '</description>',
      '    </item>'
    ].join('\n');
  }).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Entra Change Tracker' + titleSuffix + '</title>',
    '    <link>' + SITE + '</link>',
    '    <atom:link href="' + xmlEscape(SELF) + '" rel="self" type="application/rss+xml" />',
    '    <description>Microsoft Entra ID retirements, breaking changes, previews and new features' + titleSuffix + '</description>',
    '    <language>en</language>',
    '    <lastBuildDate>' + now + '</lastBuildDate>',
    entries,
    '  </channel>',
    '</rss>'
  ].join('\n');
}

function selectByNamespace(items, ns) {
  return ns === 'external-id' ? items.filter(i => i.namespace === 'external-id') : items;
}

// ── .ICS CALENDAR HELPER (frontend-redesign work order, Part B) ────────────
// Hand-built strings, no library (rule 4) -- the format is trivial for the
// one-event-type, all-day-only subset this needs.
const ICS_CATEGORY_LABELS = { retirement: 'Retiring', breaking: 'Breaking', preview: 'Preview', new_feature: 'New' };
const ICS_URGENCY_MARKER  = { red: '\u{1F534}', yellow: '\u{1F7E1}', green: '\u{1F7E2}', expired: '⚫', expired_recent: '⚫' };

// RFC 5545 TEXT escaping: backslash, then comma/semicolon, then newlines.
// Order matters -- escaping backslash first avoids double-escaping the
// backslashes this function itself just inserted.
function icsEscapeText(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n');
}

// RFC 5545 line folding: no content line may exceed 75 octets (UTF-8 bytes,
// not characters -- SUMMARY can carry an emoji urgency marker), continuation
// lines prefixed with a single space. Iterates by code point (not UTF-16
// code unit) so an astral character (emoji) is never split across a fold.
function foldICSLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '', curBytes = 0, limit = 75;
  for (const ch of line) {
    const chBytes = encoder.encode(ch).length;
    if (curBytes + chBytes > limit) {
      parts.push(cur);
      cur = ''; curBytes = 0;
      limit = 74; // continuation lines reserve 1 byte for the leading space
    }
    cur += ch;
    curBytes += chBytes;
  }
  if (cur) parts.push(cur);
  return parts.join('\r\n ');
}

// One VEVENT per item, or null (skipped, not thrown) for anything that
// can't build a valid all-day date -- non-fatal per event, per the work
// order's "a malformed single item must not corrupt the whole calendar"
// rule. Includes items whose deadline is 'inferred'-confidence (a leading
// "~" in SUMMARY marks it tentative, same hedge the frontend already shows
// as "possible date... unconfirmed" -- excluding them outright would throw
// away real information a subscriber might still want).
function icsEventLines(item, dtstamp) {
  const d = item.deadline;
  if (!d) return null;
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yN = Number(m[1]), moN = Number(m[2]), dayN = Number(m[3]);
  const start = new Date(Date.UTC(yN, moN - 1, dayN));
  const end   = new Date(Date.UTC(yN, moN - 1, dayN + 1)); // DTEND is exclusive for all-day events
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  // Date.UTC silently rolls over an out-of-range month/day (e.g. month 13
  // becomes January of the next year) instead of failing -- reject anything
  // that didn't round-trip back to the exact input, rather than silently
  // publishing a wrong date on a calendar a subscriber trusts.
  if (start.getUTCFullYear() !== yN || start.getUTCMonth() !== moN - 1 || start.getUTCDate() !== dayN) return null;
  const fmt = (dt) => dt.toISOString().split('T')[0].replace(/-/g, '');

  const marker    = ICS_URGENCY_MARKER[item.status] || '';
  const tentative = item.deadlineConfidence === 'inferred' ? '~' : '';
  const summary   = `${marker} ${tentative}${item.title || ''}`.trim();

  const descLines = [
    `Category: ${ICS_CATEGORY_LABELS[item.category] || item.category || 'Unknown'}`,
    item.serviceCategory ? `Service area: ${item.serviceCategory}` : null,
    item.evidence && item.evidence.tier ? `Evidence tier: ${item.evidence.tier}` : null,
    item.deadlineConfidence
      ? `Deadline confidence: ${item.deadlineConfidence}` + (item.deadlineConfidence === 'inferred' ? ' (unconfirmed -- verify against the source before relying on this date)' : '')
      : null,
    item.link ? `Source: ${item.link}` : null,
  ].filter(Boolean).join('\n');

  const uid = `${item.id}@entratracker.aboutcloud.io`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${fmt(start)}`,
    `DTEND;VALUE=DATE:${fmt(end)}`,
    `SUMMARY:${icsEscapeText(summary)}`,
    `DESCRIPTION:${icsEscapeText(descLines)}`,
    item.link ? `URL:${icsEscapeText(item.link)}` : null,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscapeText('Reminder: ' + (item.title || ''))}`,
    'TRIGGER:-P3D', // 3 days before DTSTART -- "a few days before"
    'END:VALARM',
    'END:VEVENT',
  ].filter(Boolean);
  return lines.map(foldICSLine).join('\r\n');
}

// One VEVENT per item with a real deadline, unfiltered by status -- past
// (expired) deadlines are included same as CSV's export does; a calendar
// client naturally shows a past event as past, no need to hide it
// server-side. Dateless items are skipped (nothing to put on a calendar).
function toICS(items, namespace) {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const suffix  = namespace === 'external-id' ? ' (External ID)' : '';
  const blocks  = [];
  for (const it of items) {
    if (!it.deadline) continue;
    try {
      const block = icsEventLines(it, dtstamp);
      if (block) blocks.push(block);
    } catch (e) {
      console.error('ics event build (non-fatal, skipped):', e && e.message);
    }
  }
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AboutCloud.io//Entra Change Tracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:Entra Change Tracker${suffix}`,
    `X-WR-CALNAME:Entra Change Tracker${suffix}`,
    `X-WR-CALDESC:${icsEscapeText('Deadlines for Microsoft Entra ID retirements, breaking changes and previews' + suffix)}`,
    'X-WR-TIMEZONE:UTC',
    'REFRESH-INTERVAL;VALUE=DURATION:PT4H', // matches the actual 4h cron cadence
  ].map(foldICSLine).join('\r\n');
  return [header, ...blocks, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

// ── FETCH HELPER ────────────────────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AboutCloud-EntraTracker/3.0 (https://entratracker.aboutcloud.io)' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ── PARSER 1: Main whats-new.md (H3 + Type/ServiceCategory blocks) ─────────
function parseWhatsNewMarkdown(markdown) {
  const results = [];
  const lines = markdown.split('\n');

  let currentMonth = '';  // "March 2026"
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Track month section headers: ## March 2026
    const h2 = line.match(/^##\s+([A-Za-z]+ \d{4})\s*$/);
    if (h2) { currentMonth = h2[1]; i++; continue; }

    // Entry starts with H3: ### Some title
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      const title = h3[1].trim().replace(/\*\*/g, '').trim();
      let typeVal        = '';
      let serviceCategory = '';
      let descLines      = [];

      // Scan forward to collect Type, Service category, description
      i++;
      while (i < lines.length) {
        const l = lines[i];

        // Next H3 or H2 means new entry -- stop
        if (l.match(/^#{2,3}\s/)) break;

        // Horizontal rule separator
        if (l.trim() === '---') { i++; break; }

        // **Type:** Plan for change
        const typeMatch = l.match(/\*\*Type:\*\*\s*(.+)/i);
        if (typeMatch) { typeVal = typeMatch[1].trim(); i++; continue; }

        // **Service category:** B2C - Consumer Identity Management
        const svcMatch = l.match(/\*\*Service category:\*\*\s*(.+)/i);
        if (svcMatch) { serviceCategory = svcMatch[1].trim(); i++; continue; }

        // **Product capability:** -- skip, not needed
        if (l.match(/\*\*Product capability:\*\*/i)) { i++; continue; }

        // Collect description text (non-empty, non-metadata lines)
        if (l.trim() && !l.match(/^\|/) && !l.match(/^<!--/)) {
          const clean = l.replace(/\*\*/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').trim();
          if (clean) descLines.push(clean);
        }
        i++;
      }

      if (!title || title.length < 5) continue;

      const description = descLines.slice(0, 4).join(' ').slice(0, 600);
      const link         = `https://learn.microsoft.com/en-us/entra/fundamentals/whats-new`;
      const announcedDate = monthHeaderToISO(currentMonth);

      // Derive category -- prefer explicit Type field
      const typeLower = typeVal.toLowerCase();
      const category  = TYPE_TO_CATEGORY[typeLower] || classifyByKeyword(title, description);

      // Extract deadline from CONTENT ONLY -- never from currentMonth (pub date != deadline)
      const contentText = `${title} ${description}`;
      const dl = extractDeadline(contentText, category, announcedDate);

      // Tier A when Microsoft labelled the entry with a **Type:** block
      // (structured metadata), even if that value isn't in TYPE_TO_CATEGORY.
      // Tier B (keyword-heuristic) when the entry has no Type: field at all
      // and category was derived from body text -- still official
      // whats-new.md content, just without structured metadata to point to.
      const evidence = typeVal
        ? buildEvidence('A', 'ms-type-field', `Type: ${typeVal}`, link)
        : buildEvidence('B', 'keyword-heuristic', classificationQuote(category, contentText), link);

      const namespace = isExternalId(title, serviceCategory) ? 'external-id' : 'entra-id';

      // whats-new.md is Microsoft's own curated changelog -- every entry is worth showing.
      // No additional filtering needed: if Microsoft put it on the page, it matters.
      // (The deadline gate is NOT applied here -- it was causing 85->28 drop by excluding
      //  all GA/Preview feature announcements that have no hard retirement deadline.)

      const status  = deriveStatus(dl.deadline);
      const impact  = deriveImpact(category, contentText);
      const days    = daysUntilUTC(dl.deadline);

      results.push({
        id:            makeId('entra-whatsnew-md', link, title),
        title,
        description,
        link,
        pubDate:       currentMonth,
        category,
        status,
        impact,
        deadline:            dl.deadline ? dl.deadline.toISOString().split('T')[0] : null,
        daysRemaining:       days,
        deadlineConfidence:  dl.deadlineConfidence,
        deadlineEvidence:    dl.deadlineEvidence,
        deadlinePrecision:   dl.deadlinePrecision,
        evidence,
        source:        'entra-whatsnew-md',
        namespace,
        serviceCategory,
        articleUrl:    null,
        announcedDate,
      });
      continue; // i already advanced inside the inner loop
    }

    i++;
  }

  return results;
}

// ── PARSER 2: Docs changelog (bullet * [Title](url) - description) ─────────
function parseDocsChangelog(markdown, sourceLabel, namespace, subtype, linkBase) {
  const results = [];
  const lines   = markdown.split('\n');
  let section   = '';
  const base    = linkBase || 'https://learn.microsoft.com/en-us/entra/external-id/';

  for (const line of lines) {
    // Month section header: "## January 2026". The "### Updated articles" /
    // "### New article" sub-headers and "# [tab](#...)" headers are ignored
    // (they need >=3 or exactly 1 hash, so neither matches ^##\s).
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { section = h2[1].trim(); continue; }

    // Bullet: "- [Title](url) - Description" or "* [Title](url) - Description".
    // Microsoft switched these changelogs from "*" to "-" markers; accept both.
    const bullet = line.match(/^[\*\-]\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*[-–]\s*(.+))?/);
    if (!bullet) continue;

    const title       = bullet[1].trim();
    const rawLink     = bullet[2].trim();
    const description = (bullet[3] || `Doc update: ${section}`).trim().slice(0, 400);

    if (title.length < 5) continue;

    // Resolve relative doc links against the source's base path. Strip leading
    // "./"/"../" segments and the ".md" extension so the published URL resolves.
    const cleanRel = rawLink.replace(/^(\.\.?\/)+/, '').replace(/\.md($|#)/, '$1');
    const link = rawLink.startsWith('http') ? rawLink : base + cleanRel;

    const fullText     = `${title} ${description} ${section}`;
    const category     = classifyByKeyword(title, description);
    const announcedDate = monthHeaderToISO(section);
    const dl           = extractDeadline(fullText, category, announcedDate);

    // Docs changelogs: only keep retirements, breaking, and previews -- skip plain updates
    if (category === 'new_feature') continue;

    const status  = deriveStatus(dl.deadline);
    const impact  = deriveImpact(category, fullText);
    const days    = daysUntilUTC(dl.deadline);
    const displayTitle = `[${subtype}] ${title}`;
    // Tier B: official documentation changelog content, no structured
    // **Type:** metadata block -- classification is always keyword-based here.
    const evidence = buildEvidence('B', 'doc-callout', classificationQuote(category, fullText), link);

    results.push({
      id:            makeId(sourceLabel, link, displayTitle),
      title:         displayTitle,
      description,
      link,
      pubDate:       section,
      category,
      status,
      impact,
      deadline:            dl.deadline ? dl.deadline.toISOString().split('T')[0] : null,
      daysRemaining:       days,
      deadlineConfidence:  dl.deadlineConfidence,
      deadlineEvidence:    dl.deadlineEvidence,
      deadlinePrecision:   dl.deadlinePrecision,
      evidence,
      source:        sourceLabel,
      namespace,
      subtype,
      articleUrl:    null,
      announcedDate,
    });
  }

  return results;
}

// ── PARSER 3: FSLogix learn.microsoft.com HTML -- warning/important callout blocks ──
// Fetches the rendered HTML page and extracts <div class="alert is-warning|is-important|is-caution">
// callout blocks plus any paragraph containing "action required" or "upcoming change".
// Generic: catches any future FSLogix breaking change Microsoft adds as a callout.
// Dedup via title prefix prevents duplicates if same warning appears in whats-new.md.
function parseFSLogixDocs(html) {
  const results = [];
  const seen = new Set();

  // Strategy 1: extract text from alert/callout div blocks
  // MS Learn uses: <div class="alert is-warning">, <div class="alert is-important">, etc.
  const alertPattern = /<div[^>]+class="[^"]*alert[^"]*is-(?:warning|important|caution|danger)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const blocks = [];

  for (const m of html.matchAll(alertPattern)) {
    const inner = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (inner.length > 20) blocks.push(inner);
  }

  // Strategy 2: also scan plain text paragraphs for "action required" / "upcoming change"
  // Strip all HTML tags first, then scan paragraphs
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const paraPattern = /(action required|upcoming change)[^.]{0,500}/gi;
  for (const m of plainText.matchAll(paraPattern)) {
    blocks.push(m[0].trim());
  }

  const link = 'https://learn.microsoft.com/en-us/fslogix/overview-release-notes';

  for (const text of blocks) {
    // Determine category first (breaking vs preview)
    const category = /action required|breaking|will fail|must|before.*update/i.test(text) ? 'breaking' : 'preview';

    // announcedDate is unknown for this source (page has no per-callout
    // date), so the scorer's "same month as announcedDate" negative signal
    // never fires here -- fine, the other signals still apply.
    const dl = extractDeadline(text, category, null);

    // Only keep items with a deadline date OR explicit breaking language
    const hasActionLang = /action required|upcoming change|breaking|will fail|access issues|disruption|must upgrade|before.*update/i.test(text);
    if (!dl.deadline && !hasActionLang) continue;

    const firstSentence = text.split(/\.\s/)[0].slice(0, 120);
    const title = `[FSLogix] ${firstSentence}`;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    const status = deriveStatus(dl.deadline);
    const days   = daysUntilUTC(dl.deadline);
    // Tier B, basis doc-callout: this parser IS the FSLogix-callout example
    // given in the work order's own tier-B definition.
    const evidence = buildEvidence('B', 'doc-callout', text.split(/\.\s/)[0].slice(0, 240), link);

    results.push({
      id:            makeId('fslogix-docs', link, title),
      title,
      description:   text.slice(0, 600),
      link,
      pubDate:       'FSLogix Docs',
      category,
      status,
      impact:        'high',
      deadline:            dl.deadline ? dl.deadline.toISOString().split('T')[0] : null,
      daysRemaining:       days,
      deadlineConfidence:  dl.deadlineConfidence,
      deadlineEvidence:    dl.deadlineEvidence,
      deadlinePrecision:   dl.deadlinePrecision,
      evidence,
      source:        'fslogix-docs',
      namespace:     'entra-id',
      serviceCategory: 'Azure Files / FSLogix',
      articleUrl:    null,
      announcedDate: null,
    });
  }
  return results;
}

function parseRSS(xml) {
  const items = [];

  // Support both RSS 2.0 (<item>) and Atom 1.0 (<entry>) formats
  // Azure Updates feed uses Atom; Tech Community used RSS 2.0
  const isAtom = xml.includes('<feed') && xml.includes('www.w3.org/2005/Atom');
  const tagName = isAtom ? 'entry' : 'item';

  for (const m of xml.matchAll(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'gi'))) {
    const item = m[1];

    let title, link, desc, pub;

    if (isAtom) {
      // Atom format
      title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      link  = (item.match(/<link[^>]+href="([^"]+)"/) || item.match(/<link>(.*?)<\/link>/s) || [])[1] || '';
      desc  = (item.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
               item.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] || '';
      pub   = (item.match(/<published>(.*?)<\/published>/i) ||
               item.match(/<updated>(.*?)<\/updated>/i) || [])[1] || '';
    } else {
      // RSS 2.0 format
      title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s) || item.match(/<title>(.*?)<\/title>/s) || [])[1] || '';
      link  = (item.match(/<link>(.*?)<\/link>/s) || [])[1] || '';
      desc  = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/s) || item.match(/<description>([\s\S]*?)<\/description>/s) || [])[1] || '';
      pub   = (item.match(/<pubDate>(.*?)<\/pubDate>/s) || [])[1] || '';
    }

    const clean = title.replace(/<[^>]+>/g, '').trim();
    if (!clean) continue;
    items.push({
      title:       clean,
      link:        link.trim(),
      description: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600),
      pubDate:     pub.trim()
    });
  }
  return items;
}

function transformRSSItems(raw) {
  const seen = new Set();
  const results = [];
  for (const item of raw) {
    const key = item.title.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    const text     = `${item.title} ${item.description}`;
    const category = classifyByKeyword(item.title, item.description);
    const announcedDate = pubDateToISO(item.pubDate);
    const dl       = extractDeadline(text, category, announcedDate);
    const status   = deriveStatus(dl.deadline);
    const impact   = deriveImpact(category, text);
    const days     = daysUntilUTC(dl.deadline);
    const namespace = isExternalId(item.title, '') ? 'external-id' : 'entra-id';
    // Editorially curated blog content, no structured metadata -> tier B.
    const evidence = buildEvidence('B', 'keyword-heuristic', classificationQuote(category, text), item.link);

    // Tech Community Entra blog is editorially curated -- include all posts.
    // Items with explicit dates get proper deadline status; others show as informational.

    results.push({
      id:            makeId('techcommunity', item.link, item.title),
      title:         item.title,
      description:   item.description,
      link:          item.link,
      pubDate:       item.pubDate,
      category,
      status,
      impact,
      deadline:            dl.deadline ? dl.deadline.toISOString().split('T')[0] : null,
      daysRemaining:       days,
      deadlineConfidence:  dl.deadlineConfidence,
      deadlineEvidence:    dl.deadlineEvidence,
      deadlinePrecision:   dl.deadlinePrecision,
      evidence,
      source:        'techcommunity',
      namespace,
      articleUrl:    null,
      announcedDate,
    });
  }
  return results;
}

// ── PARSER 5: External ID customer docs -- GitHub commits watch ─────────────
// Catches new passkey/FIDO2/how-to articles before MS adds them to the curated
// whats-new-docs.md index. De-dupes by message key to avoid repeat entries.
// GUARD: if GitHub returns a non-array body (rate-limit, error), returns [] safely.
function parseExternalIdCommits(jsonText) {
  let arr;
  try { arr = JSON.parse(jsonText); } catch (e) { return []; }
  if (!Array.isArray(arr)) return []; // handles 403/rate-limit error objects

  const KEEP = /passkey|fido2|webauthn|new (article|how-to)|add .*(how-to|guide)/i;
  const SKIP = /typo|frontmatter|copy-edit|style|link fix|editorial|merge pull request|pull request|pr review|review feedback|review checklist/i;

  const results = [];
  const seen    = new Set();

  for (const commit of arr) {
    if (!commit || !commit.commit) continue;
    const msg = (commit.commit.message || '').split('\n')[0].trim();
    if (!msg || !KEEP.test(msg) || SKIP.test(msg)) continue;

    const key = msg.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    const announcedDate = ((commit.commit.author && commit.commit.author.date) || '').split('T')[0] || null;
    const title    = `[External ID Docs] ${msg}`;
    const category = classifyByKeyword(title, msg);
    const link     = commit.html_url || '';
    // Tier C: a repo signal that a document moved, not an announcement --
    // this source exists specifically to surface how-tos BEFORE Microsoft
    // adds them to the curated changelog.
    const evidence = buildEvidence('C', 'repo-signal', msg.slice(0, 240), link);

    results.push({
      id:            makeId('external-id-commits', link, title),
      title,
      description:   msg,
      link,
      pubDate:       announcedDate || '',
      category,
      status:        'green',
      impact:        'low',
      deadline:            null,
      daysRemaining:       null,
      deadlineConfidence:  null,
      deadlineEvidence:    null,
      deadlinePrecision:   null,
      evidence,
      source:        'external-id-commits',
      namespace:     'external-id',
      articleUrl:    null,
      announcedDate,
    });
  }
  return results;
}

// ── PARSER 6: Microsoft Graph changelog (official dev-portal RSS) ───────────
// The changelog logs every Graph API surface edit (2500+ items, mostly additive
// "Added the X type" noise). We keep ONLY high-signal items: Entra-relevant
// workload AND a resource/API-LEVEL deprecation/retirement, AND (a real deadline
// OR announced within the last year). This catches the PIM iteration 2 API
// retirement and future Entra API deprecations without flooding the admin-focused
// tracker with developer-level minutiae.
// Entra-relevance is now decided by matchesAnyTaxonomyEntry() (Phase 2) --
// the taxonomy's combined term set was built as a superset of what this
// regex used to check, so this gate can only stay the same width or widen,
// never narrow (see api/__fixtures__/taxonomy/README.md for the term-by-term
// mapping and the live before/after verification in the Phase 2 PR).
// Headline deprecation/retirement semantics (future action), tested on the FIRST
// sentence only. Bare past-tense "Removed"/"Added" are intentionally excluded --
// the changelog bundles many edits per item, so we key on the lead change verb.
const GRAPH_DEPRECATION_RE = /\b(deprecated|deprecating|retiring|retired|sunset|will be retired|will be removed|will stop returning|will fail|will be blocked|no longer be (available|supported))\b/i;

// Minimal HTML entity decode + tag strip for changelog descriptions (the feed
// double-encodes HTML: &lt;div&gt;...). Numeric entities (e.g. &#xD;) -> space.
function graphHtmlDecode(s) {
  return String(s == null ? '' : s)
    .replace(/&#x?[0-9a-fA-F]+;/g, ' ')           // numeric entities (e.g. &#xD;) -> space
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')  // decode encoded tags FIRST...
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')                     // ...THEN strip the now-real tags
    .replace(/&amp;/g, '&')                       // decode &amp; last to avoid re-forming tags
    .replace(/\s+/g, ' ').trim();
}

function parseGraphChangelog(xml) {
  const results = [];
  const seen    = new Set();
  const nowMs   = Date.now();

  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block   = m[1];
    const rawDesc = (block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '';
    const desc    = graphHtmlDecode(rawDesc);
    if (!desc) continue;

    // The changelog <title> is just the workload ("Identity and access") and each
    // item bundles many edits. Key on the FIRST sentence (the headline change):
    // it must be a deprecation/retirement, and the item must be Entra-relevant.
    const firstSentence = desc.split(/\.\s/)[0];
    if (!GRAPH_DEPRECATION_RE.test(firstSentence)) continue;
    if (!matchesAnyTaxonomyEntry(desc)) continue;

    const pub           = (block.match(/<pubDate>(.*?)<\/pubDate>/i) || [])[1] || '';
    const announcedDate = pubDateToISO(pub);
    // The filter guarantees deprecation semantics, so treat as retirement --
    // this also puts it through the retirement/breaking tie-break rule
    // (latest qualifying future date wins) in the scorer.
    const category      = 'retirement';
    const link           = 'https://developer.microsoft.com/en-us/graph/changelog/';
    const dl            = extractDeadline(desc, category, announcedDate);

    // Keep only actionable items: a real deadline, or announced within the last
    // year. Drops ancient already-completed deprecations that carry no future date.
    const recent = announcedDate &&
      (nowMs - new Date(announcedDate + 'T00:00:00Z').getTime()) <= 366 * 86400000;
    if (!dl.deadline && !recent) continue;

    const title = `[Graph API] ${firstSentence.slice(0, 130)}`;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    const status    = deriveStatus(dl.deadline);
    const days      = daysUntilUTC(dl.deadline);
    const namespace = isExternalId(desc, '') ? 'external-id' : 'entra-id';
    // Tier A: the Graph changelog's own deprecation-sentence structure is
    // itself the structured metadata (this is the work order's own example).
    const evidence = buildEvidence('A', 'graph-changelog', firstSentence.slice(0, 240), link);

    results.push({
      id:            makeId('graph-changelog', link, title),
      title,
      description:   desc.slice(0, 600),
      link,
      pubDate:       pub,
      category,
      status,
      impact:        'high',
      deadline:            dl.deadline ? dl.deadline.toISOString().split('T')[0] : null,
      daysRemaining:       days,
      deadlineConfidence:  dl.deadlineConfidence,
      deadlineEvidence:    dl.deadlineEvidence,
      deadlinePrecision:   dl.deadlinePrecision,
      evidence,
      source:        'graph-changelog',
      namespace,
      articleUrl:    null,
      announcedDate,
    });
  }
  return results;
}

// ── PARSER 7: Microsoft 365 Roadmap API (Phase 5) ───────────────────────────
// Real response shape verified live before writing any of this (rule: do not
// assume field/tag names). Fetched 2026-08-16, 1813 total roadmap items:
//   - top-level: a bare JSON array (not {items: [...]})
//   - per item: id (number), title, description, moreInfoLink (string or
//     null -- populated on only 21/1813 items), publicDisclosureAvailabilityDate
//     and publicPreviewDate (both "<Month> CY<Year>", e.g. "September CY2026";
//     every non-empty occurrence across all 1813 items matched this exact
//     shape, no variants seen), created/modified (ISO datetime), status
//     ('Launched' | 'In development' | 'Rolling out' | 'Cancelled' -- exactly
//     these 4 values, nothing else), publicRoadmapStatus (constant
//     'Include this month' on every single item -- not a useful per-item
//     signal), tags (flat list) and tagsContainer (grouped: cloudInstances,
//     platforms, products, releasePhase -- each an array of {tagName}).
//   - tagsContainer.products[].tagName === 'Microsoft Entra' is the real
//     identity product tag: 12 of 1813 items carried it at verification
//     time. This is a CHEAP PRE-FILTER only, same role as GRAPH_ENTRA_RE
//     used to play before Phase 2 -- every item that survives it still goes
//     through the real scoping authority, the Phase 2 taxonomy.
const ROADMAP_PRODUCT_TAG = 'Microsoft Entra';

// The roadmap is inherently forward-looking (new capabilities being built),
// never a retirement -- map its 4 real status values accordingly. Cancelled
// is excluded entirely: nothing is happening, there's nothing to track.
const ROADMAP_STATUS_TO_CATEGORY = {
  'launched':        'new_feature',
  'rolling out':     'preview',
  'in development':  'preview',
};

// "September CY2026" -> end-of-month Date (matches extractDeadline's MY
// end-of-month convention) or null. Verified live: this exact shape covers
// every non-empty date string in the real feed, no fallback parsing needed.
function parseRoadmapMonthYear(str) {
  if (!str) return null;
  const m = String(str).match(/^([A-Za-z]+)\s+CY(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return new Date(+m[2], mo, 0);
}
function roadmapDateToISO(str) {
  const d = parseRoadmapMonthYear(str);
  return d ? d.toISOString().split('T')[0] : null;
}
// "September CY2026" -> "2026-09" -- the announcements[] schema wants the
// date "as roadmap gives it" (month precision), not a fabricated day.
function roadmapDateToDisplayMonth(str) {
  if (!str) return null;
  const m = String(str).match(/^([A-Za-z]+)\s+CY(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[2]}-${String(mo).padStart(2, '0')}`;
}

// Deliberately a SEPARATE similarity function from titleSimilarity()/
// normalizeTitleForDedup() -- those back Phase 0.1's 0.82 and Phase 1's
// 0.70 thresholds, both already live against real data; changing their
// normalisation for this phase risked silently perturbing already-shipped,
// already-tuned behaviour for an unrelated matching context (external
// roadmap titles are worded very differently from internal Microsoft-source
// titles).
//
// Two real, verified findings drove this design:
//  1. normalizeTitleForDedup() deletes hyphens outright, so "Cross-tenant"
//     becomes the single token "crosstenant" -- it then can never match
//     "cross"+"tenant" as separate words. Confirmed against a real pair: the
//     live roadmap item id 518221 ("Microsoft Entra: Cross-tenant security
//     group synchronization") vs. the real whats-new.md entry "General
//     Availability - Cross tenant group synchronization" (same feature,
//     confirmed by description text, both captured live 2026-08-16) scores
//     only 0.25 on titleSimilarity().
//  2. Roadmap titles and whats-new.md titles each carry their own
//     boilerplate lifecycle/product-label words ("General Availability -",
//     "Microsoft Entra:", "Public Preview -") that are near-universal noise
//     diluting the Jaccard score rather than describing what changed.
//     Stripping a small explicit list of them raises the SAME real pair to
//     0.8.
const ROADMAP_BOILERPLATE_WORDS = new Set([
  'general', 'availability', 'public', 'preview', 'private', 'plan', 'change',
  'upcoming', 'generally', 'available', 'microsoft', 'entra', 'feature', 'new',
]);
function roadmapNormalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function roadmapTitleSimilarity(a, b) {
  const strip = (t) => new Set(
    roadmapNormalizeTitle(t).split(' ').filter(w => w && !ROADMAP_BOILERPLATE_WORDS.has(w))
  );
  const ta = strip(a), tb = strip(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
// Set with margin below the real validated pair's score (0.8) -- same
// pattern Phase 1 used for its 0.70 threshold (real pair scored 0.75,
// threshold set at 0.70 to clear it with room). Deliberately conservative
// per this phase's core design principle: a wrong correlation is worse than
// no correlation. Do NOT loosen this without new real evidence -- see the
// carried-in note about the still-unfired Phase 0.1 0.82 threshold, which
// is exactly the mistake this value and the sub-threshold capture mechanism
// (see correlateRoadmapItems) exist to avoid repeating.
const STRONG_TITLE_DATE_SIMILARITY_THRESHOLD = 0.75;
const ROADMAP_DATE_WINDOW_MONTHS = 1;

// moreInfoLink is populated on only 21/1813 real items; for everything else,
// fall back to the roadmap site's own search-by-id URL pattern.
function roadmapPublicUrl(item) {
  if (item && item.moreInfoLink) return item.moreInfoLink;
  return `https://www.microsoft.com/en-us/microsoft-365/roadmap?searchterms=${item.id}`;
}

function parseM365Roadmap(jsonText) {
  let arr;
  try { arr = JSON.parse(jsonText); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];

  const results = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;

    const products = (it.tagsContainer && it.tagsContainer.products) || [];
    if (!products.some(p => p && p.tagName === ROADMAP_PRODUCT_TAG)) continue;

    const statusLower = String(it.status || '').toLowerCase();
    if (statusLower === 'cancelled') continue; // nothing is happening -- nothing to track
    const category = ROADMAP_STATUS_TO_CATEGORY[statusLower];
    if (!category) continue; // unrecognised status -- skip rather than guess at meaning

    const rawTitle = String(it.title || '').trim();
    const title = `[Roadmap] ${rawTitle}`;
    if (!rawTitle || title.length < 12) continue;

    const description  = String(it.description || '').slice(0, 600);
    const link          = roadmapPublicUrl(it);
    const announcedDate = (it.created || '').split('T')[0] || null;
    const statedDateSource = it.publicDisclosureAvailabilityDate || it.publicPreviewDate || '';
    const status = deriveStatus(null); // roadmap items carry no cutoff of their own -- always 'green'
    const impact = deriveImpact(category, `${title} ${description}`);
    // Tier A: roadmap items carry structured Microsoft metadata (feature id,
    // status, dates) -- per the Phase 1 evidence model this is the same
    // tier as a **Type:** block or a Graph changelog deprecation. 'roadmap'
    // is a new basis value, additive to the existing enum.
    const evidence = buildEvidence('A', 'roadmap', rawTitle.slice(0, 240), link);
    // No Microsoft-assigned service-category string exists for roadmap items
    // (products/platforms tags aren't that taxonomy) -- left '' like the
    // other sources that lack one (graph-changelog, external-id-commits),
    // so classifyTaxonomy() falls through to its Tier 2 title/description match.
    const serviceCategory = '';
    const namespace = isExternalId(title, serviceCategory) ? 'external-id' : 'entra-id';

    results.push({
      id:            makeId('m365-roadmap', link, title),
      title,
      description,
      link,
      pubDate:       it.created || '',
      category,
      status,
      impact,
      serviceCategory,
      deadline:            null,
      daysRemaining:       null,
      deadlineConfidence:  null,
      deadlineEvidence:    null,
      deadlinePrecision:   null,
      evidence,
      source:        'm365-roadmap',
      namespace,
      articleUrl:    null,
      announcedDate,
      announcements: [],
      dateConflict:  false,
      // Internal-only scratch data for correlateRoadmapItems() -- always
      // stripped before an item (standalone or otherwise) leaves that
      // function, never present on anything buildTrackerData returns.
      _roadmap: {
        roadmapId:        it.id,
        statedStatus:     it.status || '',
        statedDateISO:    roadmapDateToISO(statedDateSource),
        statedDateDisplay: roadmapDateToDisplayMonth(statedDateSource),
      },
    });
  }
  return results;
}

// Correlates each parsed roadmap item against every other already-taxonomy-
// scoped item. A match ATTACHES to the target's announcements[] (the
// roadmap item does not survive as its own item); no match means the
// roadmap item becomes its own standalone item (its _roadmap scratch field
// is stripped either way). Conservative by design (see
// STRONG_TITLE_DATE_SIMILARITY_THRESHOLD's comment) -- a wrong correlation
// is worse than none.
//
//   exact-id: the roadmap item's own numeric id appears as a whole word in
//     another item's title/description/deadlineEvidence. Attached
//     unconditionally, no date-window requirement -- an explicit id
//     reference is definitive proof of "same feature" regardless of what
//     dates are stated. This is also, deliberately, the ONLY case that can
//     produce a genuine dateConflict (see below): a date-windowed match
//     can't disagree by more than the window that let it match in the
//     first place.
//   strong-title-date: title similarity >= STRONG_TITLE_DATE_SIMILARITY_THRESHOLD
//     AND the roadmap's stated date falls within ROADMAP_DATE_WINDOW_MONTHS
//     of the target's own deadline/announcedDate.
//
// Note on the MC\d{6,7} (message-center id) pattern the work order
// mentions: the roadmap API exposes no MC-id cross-reference field, so
// there is no roadmap-side id to match an MC id found in tracked-item text
// AGAINST in this phase -- only the roadmap's own numeric id is usable for
// exact-id matching from this data source. Not implemented; flagged rather
// than faked.
//
// dateConflict: set on the TARGET item (never the roadmap item, which
// doesn't survive a successful match) when it already has its own
// `deadline` and that deadline falls in a different month than the
// roadmap's stated date. Deliberately does not compare against
// `announcedDate` -- that's "when this was announced", a different kind of
// date than "when this is available", and comparing them wouldn't be a
// meaningful disagreement.
//
// Sub-threshold near-misses (title similarity found something, but not
// enough to attach) are captured, never attached and never exposed
// publicly -- see persistRoadmapCandidates(). This is the mechanism that
// stops the still-unfired Phase 0.1 0.82 threshold problem from repeating
// here: real match-quality data accumulates so the bar can be loosened
// later from evidence, not guessed again.
function correlateRoadmapItems(allItems, nowISO) {
  const roadmapItems = allItems.filter(i => i.source === 'm365-roadmap');
  const otherItems   = allItems.filter(i => i.source !== 'm365-roadmap');
  const subThreshold = [];
  const survivors     = [];

  // Per-item try/catch, not just one around the whole function: a single
  // malformed roadmap item (unexpected shape from a future API change, a
  // missing _roadmap scratch field, etc.) must not cost every OTHER
  // roadmap item its chance to correlate in the same build -- side-band and
  // non-fatal at the finest grain that matters, matching the spirit of the
  // work order's "a matcher error must not prevent roadmap items from
  // publishing" rule as strictly as possible.
  for (const ri of roadmapItems) {
    try {
      const meta = ri._roadmap;
      let matched = null;
      let matchBasis = null;
      let matchScore = 1;

      const idRe = new RegExp(`\\b${meta.roadmapId}\\b`);
      for (const other of otherItems) {
        const text = `${other.title} ${other.description} ${other.deadlineEvidence || ''}`;
        if (idRe.test(text)) { matched = other; matchBasis = 'exact-id'; break; }
      }

      if (!matched) {
        let bestScore = 0, bestCandidate = null, bestGap = null;
        for (const other of otherItems) {
          const sim = roadmapTitleSimilarity(ri.title.replace(/^\[Roadmap\]\s*/, ''), other.title);
          const otherDateISO = other.deadline || other.announcedDate || null;
          const gap = monthDiff(meta.statedDateISO, otherDateISO);
          if (sim > bestScore) { bestScore = sim; bestCandidate = other; bestGap = gap; }
          if (sim >= STRONG_TITLE_DATE_SIMILARITY_THRESHOLD && gap !== null && gap <= ROADMAP_DATE_WINDOW_MONTHS) {
            matched = other; matchBasis = 'strong-title-date'; matchScore = sim;
            break;
          }
        }
        if (!matched && bestCandidate && bestScore > 0) {
          subThreshold.push({
            roadmapId:       meta.roadmapId,
            roadmapTitle:    ri.title,
            trackedItemId:   bestCandidate.id,
            trackedItemTitle: bestCandidate.title,
            score:           Math.round(bestScore * 1000) / 1000,
            dateGapMonths:   bestGap,
            capturedAt:      nowISO,
          });
        }
      }

      if (matched) {
        matched.announcements = [...(matched.announcements || []), {
          type:           'roadmap',
          id:             String(meta.roadmapId),
          url:            ri.link,
          statedStatus:   meta.statedStatus,
          statedDate:     meta.statedDateDisplay,
          matchBasis,
          matchConfidence: matchBasis === 'exact-id' ? 1 : matchScore,
        }];
        if (matched.deadline && meta.statedDateISO) {
          const gap = monthDiff(matched.deadline, meta.statedDateISO);
          if (gap !== null && gap >= 1) matched.dateConflict = true;
        }
      } else {
        const { _roadmap, ...clean } = ri;
        survivors.push(clean);
      }
    } catch (err) {
      console.error('correlateRoadmapItems: skipping one malformed roadmap item (non-fatal):', err && err.message);
      // Still publish it -- a correlation failure for this one item is not a
      // reason to drop it from the feed, just to leave it uncorrelated.
      const { _roadmap, ...clean } = ri;
      survivors.push(clean);
    }
  }

  return { items: [...otherItems, ...survivors], subThreshold };
}

// Diagnostic-only, side-band, non-fatal: never exposed via the public API
// or the UI. Bounded (most-recent-first, capped) so it can't grow forever.
const ROADMAP_CANDIDATES_KEY = 'entra_tracker_roadmap_candidates_v1';
const ROADMAP_CANDIDATES_CAP = 200;
async function persistRoadmapCandidates(env, newCandidates, nowISO) {
  if (!env || !env.ENTRA_CACHE || !newCandidates || !newCandidates.length) return;
  try {
    let existing = [];
    const stored = await env.ENTRA_CACHE.get(ROADMAP_CANDIDATES_KEY, 'text');
    if (stored) existing = JSON.parse(stored) || [];
    const merged = [...newCandidates, ...existing].slice(0, ROADMAP_CANDIDATES_CAP);
    await env.ENTRA_CACHE.put(ROADMAP_CANDIDATES_KEY, JSON.stringify(merged), { expirationTtl: KV_RETENTION_SECONDS });
  } catch (e) {
    console.error('roadmap candidate capture (non-fatal):', e && e.message);
  }
}

// ── CANDIDATE FEED HEALTH PROBE ─────────────────────────────────────────────
// Tries each candidate feed's known/plausible URLs. If one returns parseable RSS
// with a real item count (>=3, to reject empty-channel shells), push a warning so
// the maintainer knows the feed is back and can wire it in with proper filtering.
// All failures are swallowed -- these URLs are EXPECTED to fail until Microsoft
// restores them. Reuses parseRSS(). Adds a few cached fetches per build (cheap).
async function probeCandidateFeeds(warnings) {
  for (const cand of CANDIDATE_FEEDS) {
    for (const url of cand.urls) {
      try {
        const items = parseRSS(await fetchText(url));
        if (items.length >= 3) {
          warnings.push(`candidate source '${cand.name}' appears LIVE at ${url} (${items.length} items) - ask to wire it in`);
          break; // one working URL is enough for this candidate
        }
      } catch (e) { /* expected while the feed is unavailable -- swallow */ }
    }
  }
}

// ── REVISION STORE (Phase 3, write-path only) ────────────────────────────────
// D1 is side-band history: nothing reads it yet (Phase 4/5 will). Every
// access here is wrapped so a D1 outage -- connection failure, migration
// drift, constraint violation, timeout -- can NEVER prevent the KV write,
// alter the API response, or throw out of the caller. Diagnostics go to
// console.error only, never into the response's warnings[] array: the work
// order requires the API envelope to be byte-for-byte unchanged this phase,
// success or failure, and warnings[] is part of that envelope.

// JS item field name -> D1 column name for the fields this store tracks.
// daysRemaining/firstSeen/etc are deliberately excluded -- they change on
// their own every build (a countdown ticking down) without the item having
// actually changed; a "revision" should mean something Microsoft changed.
const REVISION_FIELD_COLUMNS = {
  title:              'title',
  category:           'category',
  status:             'status',
  deadline:           'deadline',
  deadlineConfidence: 'deadline_confidence',
  announcedDate:      'announced_date',
  serviceCategory:    'service_category',
};

function revisionContentHash(item) {
  const parts = Object.keys(REVISION_FIELD_COLUMNS).map(f => String(item[f] ?? ''));
  return fnv1a(parts.join('|'));
}

// Writes one row per item whose tracked-field content actually changed
// since its last stored revision (or has none yet); unchanged items write
// nothing. Two D1 round trips regardless of item count: one SELECT for
// every item_id's latest revision, one batched INSERT for the changed/new
// ones (D1's own batch() API, not the MCP-tool one-request limitation that
// applies only to provisioning this database, not to the deployed Worker).
//
// Cold-start note (required by the work order): this does NOT special-case
// KV's `coldStart` flag, and doesn't need to. D1 is its own persistent
// record, independent of the KV cache -- if KV goes cold (TTL lapse, bad
// deploy) but D1 still has prior revisions for these item_ids, unchanged
// items still write nothing; only genuinely new-or-changed items do. The
// only scenario that writes a full-corpus baseline is D1's OWN first-ever
// build (a freshly migrated, empty item_revisions table), which is the
// explicitly-accepted one-time baseline -- it cannot repeat on a later KV
// cold start, because by then D1 already has rows for those item_ids.
async function writeRevisions(env, items, observedAtISO) {
  if (!env || !env.TRACKER_DB) return;
  try {
    const cols = Object.values(REVISION_FIELD_COLUMNS).join(', ');
    // Tiebreak on the autoincrement PK (id), not observed_at: two rows CAN
    // share an observed_at (verified live -- a retried write after a
    // dropped connection produced exactly this), and id is the only column
    // guaranteed unique and monotonically insertion-ordered, so MAX(id)
    // always resolves to exactly one row per item_id.
    const { results: latest } = await env.TRACKER_DB.prepare(
      `SELECT item_id, content_hash, ${cols} FROM item_revisions
       WHERE id = (SELECT MAX(id) FROM item_revisions r2 WHERE r2.item_id = item_revisions.item_id)`
    ).all();

    const latestByItemId = new Map(latest.map(r => [r.item_id, r]));
    const inserts = [];

    for (const item of items) {
      const hash = revisionContentHash(item);
      const prev = latestByItemId.get(item.id);
      if (prev && prev.content_hash === hash) continue; // unchanged -- write nothing

      const changedFields = prev
        ? Object.entries(REVISION_FIELD_COLUMNS)
            .filter(([jsField, col]) => String(item[jsField] ?? '') !== String(prev[col] ?? ''))
            .map(([jsField]) => jsField)
        : []; // no prior revision -- baseline, nothing to diff against

      inserts.push(env.TRACKER_DB.prepare(
        `INSERT INTO item_revisions (item_id, observed_at, content_hash, ${cols}, changed_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        item.id, observedAtISO, hash,
        item.title ?? null, item.category ?? null, item.status ?? null,
        item.deadline ?? null, item.deadlineConfidence ?? null,
        item.announcedDate ?? null, item.serviceCategory ?? null,
        JSON.stringify(changedFields),
      ));
    }

    if (inserts.length) await env.TRACKER_DB.batch(inserts);
  } catch (e) {
    console.error('revision-store (non-fatal):', e && e.message);
  }
}

// ── SLIP-HISTORY READ PATH (net-new, read-only against the Phase 3 store) ──
// Strictly additive to the write path above -- writeRevisions() and the
// schema are untouched by anything below. Every D1 access here is wrapped
// exactly like the write path: a failure must never delay, shrink, or error
// the main feed, and must never corrupt the read endpoint's own response
// into something that looks like the tracker itself is broken.

// item ids are always the 8-hex-char output of fnv1a() (see makeId()) --
// reject anything else before it ever reaches a query, cheaper than a D1
// round trip for garbage input and closes off building an arbitrarily
// expensive WHERE clause from unvalidated input.
const ITEM_ID_RE = /^[0-9a-f]{8}$/;

// Row cap per single item's history -- generous relative to any real
// item's plausible revision count today, but bounds the worst case if a
// future bug ever caused runaway row growth for one id.
const HISTORY_ROW_CAP = 200;

// D1 column name -> JS field name, the inverse of REVISION_FIELD_COLUMNS,
// for shaping a raw D1 row into the same camelCase vocabulary the rest of
// the API already uses.
const REVISION_COLUMN_FIELDS = Object.fromEntries(
  Object.entries(REVISION_FIELD_COLUMNS).map(([jsField, col]) => [col, jsField])
);

function shapeRevisionRow(row) {
  const shaped = { observedAt: row.observed_at };
  for (const [col, jsField] of Object.entries(REVISION_COLUMN_FIELDS)) {
    shaped[jsField] = row[col] ?? null;
  }
  try { shaped.changedFields = JSON.parse(row.changed_fields || '[]'); }
  catch (e) { shaped.changedFields = []; }
  return shaped;
}

// Run-length-encodes the `deadline` column across an item's ordered
// revisions into the distinct-value sequence the work order calls the
// "headline" signal (e.g. "Jun -> Oct -> Mar"). Deliberately looks only at
// consecutive VALUE changes, not at revision count -- an item can pick up
// a new revision because its title or status changed with the deadline
// untouched (status legitimately drifts red/yellow/green as time passes
// even with nothing new to report), and that must not count as a "slip".
// null is a real, trackable value here too (an item can gain or lose a
// deadline entirely, not just move one), so comparisons use strict
// equality, not truthiness.
function computeDeadlineHistory(revisions) {
  const history = [];
  for (const r of revisions) {
    const last = history[history.length - 1];
    if (!last || last.deadline !== r.deadline) {
      history.push({ deadline: r.deadline, observedAt: r.observedAt });
    }
  }
  return history;
}

// Batch, build-time aggregate (§B): one query covering every item in the
// CURRENT build, not a per-request/per-card lookup -- this is what makes
// deadlineChangeCount safe to put on every item without an N+1 query per
// card. Scoped to only the current item set's ids (not the whole,
// ever-growing revision table) via WHERE item_id IN (...), so cost stays
// proportional to today's feed size, not to years of accumulated history
// for items that have long since aged out of the feed.
//
// LAG()/ROW_NUMBER() are real SQLite window functions, confirmed
// supported against the live D1 database before writing this (not
// assumed). A "change" is a revision whose own `deadline` differs from
// the immediately preceding revision for the SAME item_id (rn > 1 excludes
// each item's own baseline row, which has nothing to compare against).
// Non-fatal: on any failure, returns an empty map and every item falls
// back to deadlineChangeCount: 0 -- the main feed is never delayed,
// shrunk, or broken by this.
async function computeDeadlineChangeCounts(env, items) {
  const counts = new Map();
  if (!env || !env.TRACKER_DB || !items.length) return counts;
  try {
    const ids = items.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await env.TRACKER_DB.prepare(`
      SELECT item_id, COUNT(*) as changes FROM (
        SELECT item_id, deadline,
               LAG(deadline) OVER (PARTITION BY item_id ORDER BY id) AS prev_deadline,
               ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY id) AS rn
        FROM item_revisions
        WHERE item_id IN (${placeholders})
      ) t
      WHERE rn > 1 AND deadline IS NOT prev_deadline
      GROUP BY item_id
    `).bind(...ids).all();
    for (const row of results) counts.set(row.item_id, row.changes);
  } catch (e) {
    console.error('deadlineChangeCounts (non-fatal):', e && e.message);
  }
  return counts;
}

// The GET /entra-tracker/history/:itemId route (§A): a single indexed
// lookup by item_id (the existing Phase 3 index on (item_id, id DESC)
// serves this in either scan direction), ordered oldest-first, capped.
// Tiebreaks on `id` exactly like the write path's own "latest revision"
// query, for the same reason: observed_at can collide across a retried
// write, id cannot. Never fetches upstream, never triggers a rebuild --
// purely a read against whatever D1 already has.
async function fetchItemHistory(env, itemId) {
  if (!env || !env.TRACKER_DB) return null;
  try {
    const { results } = await env.TRACKER_DB.prepare(
      `SELECT observed_at, title, category, status, deadline, deadline_confidence,
              announced_date, service_category, changed_fields
       FROM item_revisions
       WHERE item_id = ?
       ORDER BY observed_at ASC, id ASC
       LIMIT ?`
    ).bind(itemId, HISTORY_ROW_CAP).all();

    if (!results.length) return { itemId, found: false, revisions: [], deadlineHistory: [], deadlineChangeCount: 0 };

    const revisions = results.map(shapeRevisionRow);
    const deadlineHistory = computeDeadlineHistory(revisions);
    return {
      itemId, found: true, revisions, deadlineHistory,
      deadlineChangeCount: Math.max(0, deadlineHistory.length - 1),
    };
  } catch (e) {
    console.error('fetchItemHistory (non-fatal):', e && e.message);
    return null; // caller distinguishes "D1 unavailable" from "genuinely no history"
  }
}

// ── HEALTH / DEGRADED MODE (Phase 4) ─────────────────────────────────────────
// Stored in KV (its own key, NOT inside the main cache blob or the public
// API response), not D1 -- deliberately. D1 (Phase 3) is explicitly allowed
// to fail non-fatally; tying health MONITORING to the one store that's
// designed to be ignorable would mean health could go dark exactly when
// something is already under stress. KV is the same store the primary feed
// already depends on, so this adds no entanglement beyond what already
// exists, and keeps GET /health a single cheap read with no D1 involved.
const HEALTH_KEY = 'entra_tracker_health_v1';
const HEALTH_HISTORY_WINDOW = 7;   // trailing successful-build count per source
const DEGRADED_RATIO = 0.5;        // below this fraction of the trailing median -> degraded
// Sources whose trailing median is at or below this are exempt from the
// ratio test entirely (including a drop to zero) -- b2c-docs legitimately
// sits at 0 items for long stretches (B2C is end-of-sale), and fslogix-docs/
// external-id-docs/graph-changelog normally run in the low single digits,
// where "half of 2 is 1" is normal noise, not a parser failure signal.
const SMALL_SOURCE_FLOOR = 5;

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Decides one source's degraded status for this build. `history` is the
// trailing window of past SUCCESSFUL builds' counts (oldest..newest), never
// including a degraded build's own count (see applyDegradedGate).
//
// No baseline yet (empty history) -> never degraded. There's nothing to
// compare against on rollout or a source's first-ever build; the window
// fills up over the following HEALTH_HISTORY_WINDOW successful builds
// (~28h at the 4h cron cadence) before the gate has real teeth. Stated here
// per the work order's explicit ask for how this behaves pre-fill.
function evaluateSourceHealth(currentCount, history) {
  const trailingMedian = history.length ? median(history) : null;
  if (trailingMedian === null) {
    return { degraded: false, trailingMedian: null, ratio: null };
  }
  if (trailingMedian <= SMALL_SOURCE_FLOOR) {
    return { degraded: false, trailingMedian, ratio: trailingMedian > 0 ? currentCount / trailingMedian : null };
  }
  const ratio = currentCount / trailingMedian;
  return { degraded: ratio < DEGRADED_RATIO, trailingMedian, ratio };
}

// Shapes the stored health-state blob into the public GET /health response.
// Pure function, no I/O -- the handler does the (single, cheap) KV read.
function buildHealthResponse(healthState) {
  const sources = {};
  for (const [source, s] of Object.entries((healthState && healthState.sources) || {})) {
    sources[source] = {
      lastSuccessAt:  s.lastSuccessAt ?? null,
      lastCount:      s.lastCount ?? null,
      trailingMedian: s.trailingMedian ?? null,
      ratio:          s.ratio ?? null,
      degraded:       !!s.degraded,
    };
  }
  const degraded = (healthState && healthState.degraded) || [];
  return {
    status:      degraded.length ? 'degraded' : 'ok',
    degraded,
    lastUpdated: (healthState && healthState.lastUpdated) || null,
    sources,
  };
}

// Reads stored per-source health state (non-fatal: a read failure just
// turns degraded detection off for this build, never breaks the feed),
// evaluates each source's current raw parse count against its trailing
// history, and for any degraded source REPLACES this build's items for
// that source with the previous good snapshot's items (from `prevItems`),
// flagged `stale: true`. Healthy sources' items pass through with
// `stale: false` and their count joins the trailing history; a degraded
// source's count does NOT join its history (a degraded build must not
// poison its own baseline, or the source could never recover its threshold).
//
// Returns the adjusted item list (replaces `allItems` entirely -- every
// source's contribution, fresh or carried, is already included) plus the
// list of degraded sources and the health snapshot to persist.
async function applyDegradedGate(env, allItems, rawCounts, prevItems, nowISO) {
  let healthState = { sources: {} };
  try {
    if (env && env.ENTRA_CACHE) {
      const stored = await env.ENTRA_CACHE.get(HEALTH_KEY, 'text');
      if (stored) healthState = JSON.parse(stored) || { sources: {} };
    }
  } catch (e) {
    console.error('health-state read (non-fatal):', e && e.message);
    healthState = { sources: {} };
  }

  const prevBySource = new Map();
  for (const p of (prevItems || [])) {
    const bucket = prevBySource.get(p.source);
    if (bucket) bucket.push(p); else prevBySource.set(p.source, [p]);
  }
  const itemsBySource = new Map();
  for (const item of allItems) {
    const bucket = itemsBySource.get(item.source);
    if (bucket) bucket.push(item); else itemsBySource.set(item.source, [item]);
  }

  const degradedSources = [];
  const nextHealthSources = {};
  const resultItems = [];

  for (const source of Object.keys(rawCounts)) {
    const currentCount = rawCounts[source];
    const prevSourceState = (healthState.sources && healthState.sources[source]) || {};
    const history = Array.isArray(prevSourceState.history) ? prevSourceState.history : [];
    const { degraded, trailingMedian, ratio } = evaluateSourceHealth(currentCount, history);

    if (degraded) {
      degradedSources.push(source);
      const carried = (prevBySource.get(source) || []).map(it => ({ ...it, stale: true }));
      resultItems.push(...carried);
      nextHealthSources[source] = {
        lastSuccessAt: prevSourceState.lastSuccessAt ?? null, // unchanged -- this build wasn't a success
        lastCount: currentCount,
        history, // unchanged -- do not poison the baseline with a degraded count
        trailingMedian,
        ratio,
        degraded: true,
      };
    } else {
      const fresh = (itemsBySource.get(source) || []).map(it => ({ ...it, stale: false }));
      resultItems.push(...fresh);
      const newHistory = [...history, currentCount].slice(-HEALTH_HISTORY_WINDOW);
      nextHealthSources[source] = {
        lastSuccessAt: nowISO,
        lastCount: currentCount,
        history: newHistory,
        trailingMedian: median(newHistory),
        ratio,
        degraded: false,
      };
    }
  }

  const nextHealthState = { lastUpdated: nowISO, sources: nextHealthSources, degraded: degradedSources };
  try {
    if (env && env.ENTRA_CACHE) {
      await env.ENTRA_CACHE.put(HEALTH_KEY, JSON.stringify(nextHealthState), { expirationTtl: KV_RETENTION_SECONDS });
    }
  } catch (e) {
    console.error('health-state write (non-fatal):', e && e.message);
  }

  // Fire-and-forget, non-fatal, transition-only webhook (4e). Only if
  // env.DEGRADED_WEBHOOK_URL is set (absent -> silently off, same pattern
  // as REFRESH_TOKEN). Fires once per source per transition INTO degraded,
  // not on every build while still degraded.
  if (env && env.DEGRADED_WEBHOOK_URL) {
    for (const source of degradedSources) {
      const wasDegraded = !!(healthState.sources && healthState.sources[source] && healthState.sources[source].degraded);
      if (wasDegraded) continue; // already degraded last build -- not a new transition
      try {
        await fetch(env.DEGRADED_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source, transitionedAt: nowISO,
            currentCount: rawCounts[source],
            trailingMedian: nextHealthSources[source].trailingMedian,
          }),
        });
      } catch (e) { console.error('degraded webhook (non-fatal):', e && e.message); }
    }
  }

  return { items: resultItems, degraded: degradedSources };
}

// ── BUILD FULL DATASET ─────────────────────────────────────────────────────
async function buildTrackerData(prevItems, env) {
  let allItems = [];
  const errors   = [];
  const warnings = [];

  // Source 1: Main Entra What's New markdown
  let countWN = 0;
  try {
    const md    = await fetchText(WHATS_NEW_URL);
    const items = parseWhatsNewMarkdown(md);
    allItems.push(...items);
    countWN = items.length;
    if (countWN === 0) warnings.push('whats-new.md: 0 items parsed - PRIMARY source format may have changed');
    console.log(`whats-new.md: ${items.length} items`);
  } catch (err) { errors.push(`whats-new: ${err.message}`); console.error(err.message); }

  // Source 2: FSLogix Release Notes -- breaking change warnings affecting Azure Files + Entra Kerberos
  // Generic parser: catches any [!WARNING]/[!IMPORTANT] callout or "action required" notice.
  // Deduplication (title prefix) prevents duplicates if same warning appears elsewhere.
  let countFS = 0;
  try {
    const md    = await fetchText(FSLOGIX_RELEASE_NOTES_URL);
    const items = parseFSLogixDocs(md);
    allItems.push(...items);
    countFS = items.length;
    console.log(`fslogix-docs: ${items.length} items`);
  } catch (err) { errors.push(`fslogix-docs: ${err.message}`); console.error(err.message); }

  // Source 3: External ID docs changelog
  let countEI = 0;
  try {
    const md    = await fetchText(EXTERNAL_ID_DOCS_URL);
    const rawBullets = (md.match(/^[\*\-]\s+\[/gm) || []).length;
    const items = parseDocsChangelog(md, 'external-id-docs', 'external-id', 'External ID',
                                     'https://learn.microsoft.com/en-us/entra/external-id/');
    allItems.push(...items);
    countEI = items.length;
    if (rawBullets === 0) warnings.push('external-id-docs: no bullet entries matched - upstream format may have changed');
    console.log(`external-id-docs: ${items.length} items (${rawBullets} raw bullets)`);
  } catch (err) { errors.push(`external-id-docs: ${err.message}`); console.error(err.message); }

  // Source 4: B2C docs changelog
  let countB2C = 0;
  try {
    const md    = await fetchText(B2C_DOCS_URL);
    const rawBullets = (md.match(/^[\*\-]\s+\[/gm) || []).length;
    const items = parseDocsChangelog(md, 'b2c-docs', 'external-id', 'Azure AD B2C',
                                     'https://learn.microsoft.com/en-us/azure/active-directory-b2c/');
    allItems.push(...items);
    countB2C = items.length;
    if (rawBullets === 0) warnings.push('b2c-docs: no bullet entries matched - upstream format may have changed');
    console.log(`b2c-docs: ${items.length} items (${rawBullets} raw bullets)`);
  } catch (err) { errors.push(`b2c-docs: ${err.message}`); console.error(err.message); }

  // Source 5: External ID customer docs -- direct commit watch (pre-changelog, passkey/FIDO2 coverage)
  // Anonymous GitHub API: 60 req/hr; 4h cron + KV caching keeps us well under limit.
  // fetchText sends User-Agent (required by GitHub API). Non-OK responses throw and are
  // caught here; parseExternalIdCommits also guards against non-array JSON bodies.
  let countEIC = 0;
  try {
    const json  = await fetchText(COMMITS_API_URL);
    const items = parseExternalIdCommits(json);
    allItems.push(...items);
    countEIC = items.length;
    console.log(`external-id-commits: ${items.length} items`);
  } catch (err) { errors.push(`external-id-commits: ${err.message}`); console.error(err.message); }

  // Source 6: Microsoft Graph changelog -- Entra API resource/endpoint deprecations
  // (e.g. PIM iteration 2 retirement). Heavily filtered; see parseGraphChangelog.
  let countGC = 0;
  try {
    const xml   = await fetchText(GRAPH_CHANGELOG_URL);
    const rawItems = (xml.match(/<item>/gi) || []).length;
    const items = parseGraphChangelog(xml);
    allItems.push(...items);
    countGC = items.length;
    if (rawItems === 0) warnings.push('graph-changelog: no <item> entries found - feed format may have changed');
    console.log(`graph-changelog: ${items.length} items (${rawItems} raw feed items)`);
  } catch (err) { errors.push(`graph-changelog: ${err.message}`); console.error(err.message); }

  // Source 7: Microsoft 365 Roadmap API (Phase 5) -- external source, so a
  // fetch failure here must be exactly as non-fatal as any other source's:
  // caught, logged to errors[], and left to the degraded gate below rather
  // than allowed to shrink or break the rest of the build.
  let countRM = 0;
  try {
    const json  = await fetchText(M365_ROADMAP_URL);
    const items = parseM365Roadmap(json);
    allItems.push(...items);
    countRM = items.length;
    console.log(`m365-roadmap: ${items.length} items`);
  } catch (err) { errors.push(`m365-roadmap: ${err.message}`); console.error(err.message); }

  // Health probe: detect if a currently-unavailable official feed (Entra blog) has
  // been restored, so it can be promoted to a real source. Surfaces via warnings[].
  await probeCandidateFeeds(warnings);

  // Universal announcements[]/dateConflict defaulting (Phase 5): only the
  // roadmap parser sets these itself; every other source's items need them
  // too so correlateRoadmapItems() can attach to ANY item regardless of
  // which source produced it, and so the additive fields are always present
  // on every item in the public response (never sometimes-missing).
  for (const item of allItems) {
    if (!Array.isArray(item.announcements)) item.announcements = [];
    if (typeof item.dateConflict !== 'boolean') item.dateConflict = false;
  }

  // Degraded gate (Phase 4): compare each source's RAW parse count (before
  // taxonomy/dedupe touch anything) against its trailing baseline. A source
  // that silently shrank has its items REPLACED with the previous good
  // snapshot's items for that source (flagged stale), rather than
  // publishing the shrunken set -- see applyDegradedGate()'s own comment.
  // 'm365-roadmap' gets its own trailing baseline like every other source --
  // a zero-count hard failure this build must not poison ITS OWN history,
  // exactly the same guarantee every pre-existing source already has.
  const rawSourceCounts = {
    'entra-whatsnew-md':   countWN,
    'fslogix-docs':        countFS,
    'external-id-docs':    countEI,
    'b2c-docs':            countB2C,
    'external-id-commits': countEIC,
    'graph-changelog':     countGC,
    'm365-roadmap':        countRM,
  };
  const buildTimestamp = new Date().toISOString();
  const { items: gatedItems, degraded } = await applyDegradedGate(env, allItems, rawSourceCounts, prevItems, buildTimestamp);
  allItems = gatedItems;

  // Route every item through the service taxonomy exactly once, before
  // sort/dedupe/retention touch anything. Drops items matching no taxonomy
  // entry -- never silently, see routeThroughTaxonomy()'s unmatched/
  // unmatchedSamples output, surfaced on the envelope below. Roadmap items
  // go through this exactly like any other source's -- the roadmap's own
  // product tag (ROADMAP_PRODUCT_TAG) was only ever a cheap pre-filter; this
  // taxonomy pass is the real scoping authority.
  const { items: taxonomyItems, unmatched, unmatchedSamples } = routeThroughTaxonomy(allItems);
  allItems = taxonomyItems;

  // Correlate roadmap items against everything else (Phase 5). Side-band and
  // non-fatal by design: a matcher error must never prevent roadmap items
  // from publishing or the build from completing, so it's wrapped exactly
  // like the D1/health/KV access patterns elsewhere in this file. On error,
  // the roadmap items parsed above simply fall through as standalone items
  // (still tier-A, still taxonomy-scoped) rather than being lost.
  let subThresholdCandidates = [];
  try {
    const { items: correlated, subThreshold } = correlateRoadmapItems(allItems, buildTimestamp);
    allItems = correlated;
    subThresholdCandidates = subThreshold;
  } catch (err) {
    console.error('correlateRoadmapItems (non-fatal):', err && err.message);
    // Strip the internal-only _roadmap scratch field so a matcher error
    // can't leak it into the public response -- roadmap items still
    // publish as standalone items, just uncorrelated.
    allItems = allItems.map(i => { const { _roadmap, ...clean } = i; return clean; });
  }
  await persistRoadmapCandidates(env, subThresholdCandidates, buildTimestamp);

  // Sort: expired_recent (still actionable) -> expired -> red -> yellow ->
  // green, then days asc, then announcedDate desc (newest first) as tiebreak
  // when status+days are equal. expired_recent ranks top because a deadline
  // that just passed may mean the viewer is already affected.
  const ORDER = { expired_recent:0, expired:1, red:2, yellow:3, green:4 };
  allItems.sort((a, b) => {
    const sd = (ORDER[a.status]??4) - (ORDER[b.status]??4);
    if (sd !== 0) return sd;
    if (a.daysRemaining !== null && b.daysRemaining !== null) {
      const dd = a.daysRemaining - b.daysRemaining;
      if (dd !== 0) return dd;
    } else if (a.daysRemaining !== null) {
      return -1;
    } else if (b.daysRemaining !== null) {
      return 1;
    }
    // Tiebreak: announcedDate desc (newest first)
    const da = a.announcedDate || '';
    const db = b.announcedDate || '';
    if (da && db) return db.localeCompare(da);
    if (da) return -1;
    if (db) return 1;
    return 0;
  });

  // Two-stage dedupe: stage 1 collapses exact repeats within one source
  // (dedupeDropped); stage 2 merges the same change reported by more than
  // one source into a single item with sources[]/links[] (crossSourceMerged).
  // See twoStageDedupe() for the external-id-commits carve-out and the
  // source-rank tiebreak used to pick each merge's surviving fields.
  const { items: deduped, dedupeDropped, crossSourceMerged } = twoStageDedupe(allItems);

  // Retention: keep the feed bounded and relevance-decayed.
  //  - Dated items: drop once the deadline is >DEADLINE_RETENTION_DAYS in the past
  //    (consistent with deriveStatus, which also drops at -365).
  //  - Dateless items: age out by announcedDate per category (RETENTION_DAYS).
  //    Unknown announcedDate -> kept (fall back to Microsoft pruning the source).
  const nowMs = Date.now();
  const capped = deduped.filter(it => {
    if (it.deadline) {
      return daysUntilUTC(new Date(it.deadline + 'T00:00:00Z')) >= -DEADLINE_RETENTION_DAYS;
    }
    if (!it.announcedDate) return true;
    const horizon = RETENTION_DAYS[it.category] ?? RETENTION_DEFAULT_DAYS;
    const ageDays = (nowMs - new Date(it.announcedDate + 'T00:00:00Z').getTime()) / 86400000;
    return ageDays <= horizon;
  });

  // cold start: no prior snapshot, or prior snapshot predates firstSeen field.
  // Computed BEFORE the diff (not after, as before Phase 1) because applyDiff
  // needs it to decide how to seed firstSeen when no prior match is found --
  // see the 2026-08-14 cold-start incident (PR #22) that flattened every
  // item's firstSeen to one date; this is the repair for that failure mode.
  const coldStart = !prevItems || prevItems.length === 0
                    || !prevItems.some(i => i.firstSeen);
  const diffed = applyDiff(capped, prevItems, coldStart);
  const newCount = coldStart ? 0 : diffed.filter(i => i.isNew).length;

  const externalIdCount = diffed.filter(i => i.namespace === 'external-id').length;

  const lastUpdated = buildTimestamp;

  // Revision store write (Phase 3, side-band, non-fatal -- see
  // writeRevisions()'s own comment). Item set is fully finalised here:
  // post-dedupe, post-taxonomy, post-retention, post-diff. Never awaited in
  // a way that could throw past this point -- writeRevisions swallows its
  // own errors internally.
  await writeRevisions(env, diffed, lastUpdated);

  // Slip-history batch aggregate (net-new, read-only against the store
  // above): runs AFTER the write so a genuine slip detected by THIS build
  // is reflected in its own deadlineChangeCount, not lagging one build
  // behind. Non-fatal -- a failure yields an empty map and every item
  // below falls back to 0, never delaying or shrinking the response.
  const deadlineChangeCounts = await computeDeadlineChangeCounts(env, diffed);
  for (const item of diffed) {
    item.deadlineChangeCount = deadlineChangeCounts.get(item.id) ?? 0;
  }

  return {
    lastUpdated,
    count:          diffed.length,
    externalIdCount,
    newCount,
    coldStart,
    dedupeDropped,
    crossSourceMerged,
    unmatched,
    unmatchedSamples,
    degraded,
    sources: {
      'whats-new-md':        countWN,
      'fslogix-docs':        countFS,
      'external-id-docs':    countEI,
      'b2c-docs':            countB2C,
      'external-id-commits': countEIC,
      'graph-changelog':     countGC,
      'm365-roadmap':        countRM,
    },
    errors:         errors.length   ? errors   : undefined,
    warnings:       warnings.length ? warnings : undefined,
    items:          diffed,
  };
}

// ── CORS ────────────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o));
  return {
    'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    // The allowed origin echoed above varies per request Origin header, so any
    // shared/edge cache must key on it too -- otherwise one origin's CORS
    // headers get served to a different origin's request.
    'Vary':                         'Origin',
  };
}

// ── WORKER ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (request.method !== 'GET' || !url.pathname.startsWith('/entra-tracker'))
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });

    // Static in-memory structure -- no auth, never touches KV or upstream
    // sources, so it's always available regardless of cache state. Single
    // definition the frontend pills and the /methodology coverage statement
    // both read from.
    if (url.pathname === '/entra-tracker/taxonomy') {
      const taxonomy = SERVICE_TAXONOMY.map(e => ({ id: e.id, name: e.name }));
      return new Response(JSON.stringify({ taxonomy }, null, 2), {
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
          ...corsHeaders(origin),
        },
      });
    }

    // Read-only, cheap, no auth (rule 6): a single KV read of the stored
    // health snapshot, nothing more. Never fetches a source, never triggers
    // a rebuild, never queries D1. Safe to poll in a loop.
    if (url.pathname === '/entra-tracker/health') {
      let healthState = null;
      try {
        if (env.ENTRA_CACHE) {
          const stored = await env.ENTRA_CACHE.get(HEALTH_KEY, 'text');
          if (stored) healthState = JSON.parse(stored);
        }
      } catch (e) { console.error('health read:', e.message); }

      return new Response(JSON.stringify(buildHealthResponse(healthState), null, 2), {
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
          ...corsHeaders(origin),
        },
      });
    }

    // Read-only slip history for one item (net-new). No auth (rule 6, same
    // posture as /health and /taxonomy): a single indexed D1 lookup, row-
    // capped, never fetches upstream or triggers a rebuild. Invalid/unknown
    // ids get a clean 404 with a well-formed empty body, never a 500 that
    // reads as "the tracker is broken".
    const historyMatch = url.pathname.match(/^\/entra-tracker\/history\/([^/]+)$/);
    if (historyMatch) {
      const itemId = historyMatch[1];
      if (!ITEM_ID_RE.test(itemId)) {
        return new Response(JSON.stringify({ itemId, found: false, revisions: [], deadlineHistory: [], deadlineChangeCount: 0 }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
      const history = await fetchItemHistory(env, itemId);
      if (history === null) {
        // D1 itself unavailable -- distinct from "genuinely no history",
        // but still a clean, well-formed response, not a 500.
        return new Response(JSON.stringify({ itemId, found: false, revisions: [], deadlineHistory: [], deadlineChangeCount: 0 }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
      return new Response(JSON.stringify(history, null, 2), {
        status: history.found ? 200 : 404,
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
          ...corsHeaders(origin),
        },
      });
    }

    // refresh=1 forces 6 upstream fetches per call, one of which (the GitHub
    // commits API) is rate-limited to 60/hr anonymously -- so it must be gated
    // behind a shared secret rather than honoured for any caller. If the
    // REFRESH_TOKEN secret isn't configured, refresh=1 is ignored (never honoured).
    const refreshToken     = request.headers.get('X-Refresh-Token') || '';
    const forceRefresh     = url.searchParams.get('refresh') === '1'
                           && !!env.REFRESH_TOKEN
                           && refreshToken === env.REFRESH_TOKEN;
    const format       = url.searchParams.get('format');
    const nsParam      = url.searchParams.get('namespace');

    if (env.ENTRA_CACHE && !forceRefresh) {
      try {
        const cached = await env.ENTRA_CACHE.get(CACHE_KEY, 'text');
        if (cached) {
          if (format === 'csv') {
            // Reuse cached dataset -- do not refetch sources
            const data = JSON.parse(cached);
            return new Response(toCSV(data.items || []), {
              headers: {
                'Content-Type':        'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename="entra-tracker.csv"',
                'X-Cache':             'HIT',
                ...corsHeaders(origin),
              },
            });
          }
          if (format === 'rss') {
            const data = JSON.parse(cached);
            return new Response(toRSS(selectByNamespace(data.items || [], nsParam), nsParam), {
              headers: {
                'Content-Type':  'application/rss+xml; charset=utf-8',
                'X-Cache':       'HIT',
                'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
                ...corsHeaders(origin),
              },
            });
          }
          if (format === 'ics') {
            const data = JSON.parse(cached);
            return new Response(toICS(selectByNamespace(data.items || [], nsParam), nsParam), {
              headers: {
                'Content-Type':  'text/calendar; charset=utf-8',
                'X-Cache':       'HIT',
                'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
                ...corsHeaders(origin),
              },
            });
          }
          return new Response(cached, {
            headers: {
              'Content-Type':  'application/json',
              'X-Cache':       'HIT',
              'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
              ...corsHeaders(origin),
            },
          });
        }
      } catch (e) { console.error('KV read:', e.message); }
    }

    // Read current snapshot BEFORE overwriting -- this is the prev for diffing.
    // Only reached on MISS (the HIT branch returns early above).
    let prevItems = [];
    if (env.ENTRA_CACHE) {
      try {
        const old = await env.ENTRA_CACHE.get(CACHE_KEY, 'text');
        if (old) prevItems = (JSON.parse(old).items) || [];
      } catch (e) { console.error('prev read:', e.message); }
    }

    try {
      const data = await buildTrackerData(prevItems, env);
      const json = JSON.stringify(data, null, 2);

      if (env.ENTRA_CACHE) {
        try {
          await env.ENTRA_CACHE.put(CACHE_KEY, json, { expirationTtl: KV_RETENTION_SECONDS });
        } catch (e) { console.error('KV write:', e.message); }
      }

      if (format === 'csv') {
        return new Response(toCSV(data.items || []), {
          headers: {
            'Content-Type':        'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="entra-tracker.csv"',
            'X-Cache':             'MISS',
            ...corsHeaders(origin),
          },
        });
      }

      if (format === 'rss') {
        return new Response(toRSS(selectByNamespace(data.items || [], nsParam), nsParam), {
          headers: {
            'Content-Type':  'application/rss+xml; charset=utf-8',
            'X-Cache':       'MISS',
            'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
            ...corsHeaders(origin),
          },
        });
      }

      if (format === 'ics') {
        return new Response(toICS(selectByNamespace(data.items || [], nsParam), nsParam), {
          headers: {
            'Content-Type':  'text/calendar; charset=utf-8',
            'X-Cache':       'MISS',
            'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
            ...corsHeaders(origin),
          },
        });
      }

      return new Response(json, {
        headers: {
          'Content-Type':  'application/json',
          'X-Cache':       'MISS',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
          ...corsHeaders(origin),
        },
      });
    } catch (err) {
      console.error('Worker error:', err.message);
      return new Response(JSON.stringify({ error: 'Failed', detail: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        let prevItems = [];
        if (env.ENTRA_CACHE) {
          try {
            const old = await env.ENTRA_CACHE.get(CACHE_KEY, 'text');
            if (old) prevItems = (JSON.parse(old).items) || [];
          } catch (e) { console.error('prev read:', e.message); }
        }
        const data = await buildTrackerData(prevItems, env);
        const json = JSON.stringify(data, null, 2);
        if (env.ENTRA_CACHE) {
          await env.ENTRA_CACHE.put(CACHE_KEY, json, { expirationTtl: KV_RETENTION_SECONDS });
          console.log(`Cron OK -- ${data.count} items (${data.externalIdCount} External ID, ${data.newCount} new)`);
        }
      } catch (err) { console.error('Cron:', err.message); }
    })());
  },
};

// ── TEST-ONLY EXPORTS ────────────────────────────────────────────────────────
// Named exports alongside the default {fetch, scheduled} export. Wrangler
// deploys only the default export's handlers, so these add nothing to the
// deployed bundle -- they exist so api/worker.test.js can unit-test internal
// logic (dedupe/merge, date parsing, classification) without a live network
// fetch or a KV binding.
export {
  normalizeTitleForDedup,
  titleSimilarity,
  monthDiff,
  sourceRank,
  dedupeIntraSource,
  mergeCrossSource,
  twoStageDedupe,
  extractDeadline,
  collectDateCandidates,
  classifyByKeyword,
  classificationQuote,
  buildEvidence,
  evidenceTierRank,
  makeId,
  fnv1a,
  applyDiff,
  parseWhatsNewMarkdown,
  parseDocsChangelog,
  parseFSLogixDocs,
  parseGraphChangelog,
  parseExternalIdCommits,
  toCSV,
  toRSS,
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
  M365_ROADMAP_URL,
  ROADMAP_PRODUCT_TAG,
  ROADMAP_STATUS_TO_CATEGORY,
  parseRoadmapMonthYear,
  roadmapDateToISO,
  roadmapDateToDisplayMonth,
  roadmapNormalizeTitle,
  roadmapTitleSimilarity,
  STRONG_TITLE_DATE_SIMILARITY_THRESHOLD,
  ROADMAP_DATE_WINDOW_MONTHS,
  roadmapPublicUrl,
  parseM365Roadmap,
  correlateRoadmapItems,
  persistRoadmapCandidates,
  ROADMAP_CANDIDATES_KEY,
  ROADMAP_CANDIDATES_CAP,
  toICS,
  icsEventLines,
  icsEscapeText,
  foldICSLine,
  selectByNamespace,
  ITEM_ID_RE,
  HISTORY_ROW_CAP,
  shapeRevisionRow,
  computeDeadlineHistory,
  computeDeadlineChangeCounts,
  fetchItemHistory,
};
