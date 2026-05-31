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

const CACHE_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const CACHE_KEY         = 'entra_tracker_v3';

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

// ── EXTERNAL ID DETECTION ──────────────────────────────────────────────────
const EXTERNAL_ID_SERVICE_CATEGORIES = [
  'b2c', 'external id', 'external-id', 'ciam', 'consumer identity',
  'b2b', 'b2b collaboration', 'b2b direct connect', 'cross-tenant',
  'workforce and external',
];

// Title-level keywords only -- passkey items use "Authentications (Logins)" service category
// (a workforce category) so we match by title alone, not service category, to avoid
// blanket-reclassifying all workforce passkey announcements.
const EXTERNAL_ID_TITLE_KEYWORDS = [
  'b2c', 'external id', 'external tenant', 'customer identity',
  'guest user', 'external user', 'cross-tenant', 'b2b',
  'user flow', 'custom policy', 'identity experience framework',
  'passkey', 'fido2', 'webauthn', 'native auth', 'native authentication',
];

function isExternalId(title, serviceCategory) {
  const t = (title || '').toLowerCase();
  const s = (serviceCategory || '').toLowerCase();
  return EXTERNAL_ID_SERVICE_CATEGORIES.some(k => s.includes(k))
      || EXTERNAL_ID_TITLE_KEYWORDS.some(k => t.includes(k));
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

// Diff current items against the previous snapshot's ids. Tags isNew, and
// carries firstSeen forward so an item's first-seen date is stable across runs.
function applyDiff(currentItems, prevItems) {
  const prevById = new Map((prevItems || []).map(i => [i.id, i]));
  const nowISO = new Date().toISOString().split('T')[0];
  for (const item of currentItems) {
    const prev = prevById.get(item.id);
    item.isNew     = !prev;
    item.firstSeen = (prev && prev.firstSeen) ? prev.firstSeen : nowISO;
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

// True if any expiry phrase occurs within `window` chars of the matched
// date string inside text. Keeps "deprecated ... 2026-10-28" (deadline)
// distinct from "deprecated basic auth" sitting paragraphs away from an
// unrelated "Starting May 2026" (not a deadline for THIS date).
function hasExpiryLanguageNear(text, dateStr, window) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(dateStr.toLowerCase());
  if (idx === -1) return false;
  const from = Math.max(0, idx - window);
  const to   = Math.min(lower.length, idx + dateStr.length + window);
  const slice = lower.slice(from, to);
  return DEADLINE_LANGUAGE.some(k => slice.includes(k));
}

function extractDeadline(text, category) {
  const lower = text.toLowerCase();

  // Try each date format in order (ISO, MDY, DMY, MY)
  // Return the first matching date only if rule A or B is satisfied.

  const isoM = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoM) {
    const d = new Date(`${isoM[1]}-${isoM[2]}-${isoM[3]}`);
    if (!isNaN(d)) {
      if (category === 'retirement' || category === 'breaking') return d;
      if (hasExpiryLanguageNear(text, isoM[0], 160)) return d;
      return null;
    }
  }

  const mdyM = lower.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdyM) {
    const d = new Date(+mdyM[3], MONTHS[mdyM[1]]-1, +mdyM[2]);
    if (!isNaN(d)) {
      if (category === 'retirement' || category === 'breaking') return d;
      if (hasExpiryLanguageNear(text, mdyM[0], 160)) return d;
      return null;
    }
  }

  const dmyM = lower.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/);
  if (dmyM) {
    const d = new Date(+dmyM[3], MONTHS[dmyM[2]]-1, +dmyM[1]);
    if (!isNaN(d)) {
      if (category === 'retirement' || category === 'breaking') return d;
      if (hasExpiryLanguageNear(text, dmyM[0], 160)) return d;
      return null;
    }
  }

  const myM = lower.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/);
  if (myM) {
    const d = new Date(+myM[2], MONTHS[myM[1]], 0);
    if (!isNaN(d)) {
      if (category === 'retirement' || category === 'breaking') return d;
      if (hasExpiryLanguageNear(text, myM[0], 160)) return d;
      return null;
    }
  }

  return null;
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

function makeId(title) {
  // FNV-1a 32-bit over the full title -> stable, collision-resistant id.
  const s = String(title || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
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
  // newest-first by firstSeen, capped at 50
  const sorted = items.slice().sort((a, b) => {
    const da = a.firstSeen || a.announcedDate || '';
    const db = b.firstSeen || b.announcedDate || '';
    return db.localeCompare(da);
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

      // Derive category -- prefer explicit Type field
      const typeLower = typeVal.toLowerCase();
      const category  = TYPE_TO_CATEGORY[typeLower] || classifyByKeyword(title, description);

      // Extract deadline from CONTENT ONLY -- never from currentMonth (pub date != deadline)
      const contentText = `${title} ${description}`;
      const deadline    = extractDeadline(contentText, category);

      const namespace = isExternalId(title, serviceCategory) ? 'external-id' : 'entra-id';

      // whats-new.md is Microsoft's own curated changelog -- every entry is worth showing.
      // No additional filtering needed: if Microsoft put it on the page, it matters.
      // (The deadline gate is NOT applied here -- it was causing 85->28 drop by excluding
      //  all GA/Preview feature announcements that have no hard retirement deadline.)

      const status  = deriveStatus(deadline);
      const impact  = deriveImpact(category, contentText);
      const days    = daysUntilUTC(deadline);

      results.push({
        id:            makeId(title),
        title,
        description,
        link:          `https://learn.microsoft.com/en-us/entra/fundamentals/whats-new`,
        pubDate:       currentMonth,
        category,
        status,
        impact,
        deadline:      deadline ? deadline.toISOString().split('T')[0] : null,
        daysRemaining: days,
        source:        'entra-whatsnew-md',
        namespace,
        serviceCategory,
        articleUrl:    null,
        announcedDate: monthHeaderToISO(currentMonth),
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

    const fullText = `${title} ${description} ${section}`;
    const category = classifyByKeyword(title, description);
    const deadline = extractDeadline(fullText, category);

    // Docs changelogs: only keep retirements, breaking, and previews -- skip plain updates
    if (category === 'new_feature') continue;

    const status = deriveStatus(deadline);
    const impact = deriveImpact(category, fullText);
    const days   = daysUntilUTC(deadline);

    results.push({
      id:            makeId(`${subtype}:${title}`),
      title:         `[${subtype}] ${title}`,
      description,
      link,
      pubDate:       section,
      category,
      status,
      impact,
      deadline:      deadline ? deadline.toISOString().split('T')[0] : null,
      daysRemaining: days,
      source:        sourceLabel,
      namespace,
      subtype,
      articleUrl:    null,
      announcedDate: monthHeaderToISO(section),
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

  for (const text of blocks) {
    // Determine category first (breaking vs preview)
    const category = /action required|breaking|will fail|must|before.*update/i.test(text) ? 'breaking' : 'preview';

    // Only keep items with a deadline date OR explicit breaking language
    const hasDeadline = extractDeadline(text, category) !== null;
    const hasActionLang = /action required|upcoming change|breaking|will fail|access issues|disruption|must upgrade|before.*update/i.test(text);
    if (!hasDeadline && !hasActionLang) continue;

    const firstSentence = text.split(/\.\s/)[0].slice(0, 120);
    const title = `[FSLogix] ${firstSentence}`;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    const deadline = extractDeadline(text, category);
    const status    = deriveStatus(deadline);
    const days      = daysUntilUTC(deadline);

    results.push({
      id:            makeId(title),
      title,
      description:   text.slice(0, 600),
      link:          'https://learn.microsoft.com/en-us/fslogix/overview-release-notes',
      pubDate:       'FSLogix Docs',
      category,
      status,
      impact:        'high',
      deadline:      deadline ? deadline.toISOString().split('T')[0] : null,
      daysRemaining: days,
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
    const deadline = extractDeadline(text, category);
    const status   = deriveStatus(deadline);
    const impact   = deriveImpact(category, text);
    const days     = daysUntilUTC(deadline);
    const namespace = isExternalId(item.title, '') ? 'external-id' : 'entra-id';

    // Tech Community Entra blog is editorially curated -- include all posts.
    // Items with explicit dates get proper deadline status; others show as informational.

    results.push({
      id:            makeId(item.title),
      title:         item.title,
      description:   item.description,
      link:          item.link,
      pubDate:       item.pubDate,
      category,
      status,
      impact,
      deadline:      deadline ? deadline.toISOString().split('T')[0] : null,
      daysRemaining: days,
      source:        'techcommunity',
      namespace,
      articleUrl:    null,
      announcedDate: pubDateToISO(item.pubDate),
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

    results.push({
      id:            makeId(`eic:${msg}`),
      title,
      description:   msg,
      link:          commit.html_url || '',
      pubDate:       announcedDate || '',
      category,
      status:        'green',
      impact:        'low',
      deadline:      null,
      daysRemaining: null,
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
const GRAPH_ENTRA_RE = /privilegedaccess|privileged identity|conditionalaccess|conditional access|directoryrole|directory role|\bsignin\b|authenticationmethod|crosstenant|\bentra\b|identityprotection|riskyuser|namedlocation|azure ad role|microsoft entra/i;
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
    if (!GRAPH_ENTRA_RE.test(desc)) continue;

    const pub           = (block.match(/<pubDate>(.*?)<\/pubDate>/i) || [])[1] || '';
    const announcedDate = pubDateToISO(pub);
    // The filter guarantees deprecation semantics, so treat as retirement -- this
    // also lets extractDeadline (rule A) capture a date stated later in the block.
    const category      = 'retirement';
    const deadline      = extractDeadline(desc, category);

    // Keep only actionable items: a real deadline, or announced within the last
    // year. Drops ancient already-completed deprecations that carry no future date.
    const recent = announcedDate &&
      (nowMs - new Date(announcedDate + 'T00:00:00Z').getTime()) <= 366 * 86400000;
    if (!deadline && !recent) continue;

    const title = `[Graph API] ${firstSentence.slice(0, 130)}`;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    const status    = deriveStatus(deadline);
    const days      = daysUntilUTC(deadline);
    const namespace = isExternalId(desc, '') ? 'external-id' : 'entra-id';

    results.push({
      id:            makeId(`graph:${title}`),
      title,
      description:   desc.slice(0, 600),
      link:          'https://developer.microsoft.com/en-us/graph/changelog/',
      pubDate:       pub,
      category,
      status,
      impact:        'high',
      deadline:      deadline ? deadline.toISOString().split('T')[0] : null,
      daysRemaining: days,
      source:        'graph-changelog',
      namespace,
      articleUrl:    null,
      announcedDate,
    });
  }
  return results;
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

// ── BUILD FULL DATASET ─────────────────────────────────────────────────────
async function buildTrackerData(prevItems) {
  const allItems = [];
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

  // Health probe: detect if a currently-unavailable official feed (Entra blog) has
  // been restored, so it can be promoted to a real source. Surfaces via warnings[].
  await probeCandidateFeeds(warnings);

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

  // Deduplicate by title prefix (strip subtype prefix for comparison).
  // external-id-commits items use a source-scoped key so a commits item
  // is never collapsed into a same-titled changelog item from source 3.
  // parseExternalIdCommits already de-dupes its own batch, so this only
  // prevents cross-source loss of the passkey how-to entries.
  const deduped = [];
  const seen    = new Set();
  for (const item of allItems) {
    const stripped = item.title.replace(/^\[[^\]]+\]\s+/,'').toLowerCase().slice(0,60);
    const key = item.source === 'external-id-commits' ? `eic:${stripped}` : stripped;
    if (!seen.has(key)) { seen.add(key); deduped.push(item); }
  }

  // 1-year retention cap: drop items whose deadline passed more than 365 days
  // ago. Items with no deadline, or future/recent deadlines, are always kept.
  // Keying on daysUntilUTC keeps this consistent with deriveStatus.
  const capped = deduped.filter(it => {
    if (!it.deadline) return true;
    const d = daysUntilUTC(new Date(it.deadline + 'T00:00:00Z'));
    return d >= -365;
  });

  const diffed = applyDiff(capped, prevItems);
  // cold start: no prior snapshot, or prior snapshot predates firstSeen field
  const coldStart = !prevItems || prevItems.length === 0
                    || !prevItems.some(i => i.firstSeen);
  const newCount = coldStart ? 0 : diffed.filter(i => i.isNew).length;

  const externalIdCount = diffed.filter(i => i.namespace === 'external-id').length;

  return {
    lastUpdated:    new Date().toISOString(),
    count:          diffed.length,
    externalIdCount,
    newCount,
    coldStart,
    sources: {
      'whats-new-md':        countWN,
      'fslogix-docs':        countFS,
      'external-id-docs':    countEI,
      'b2c-docs':            countB2C,
      'external-id-commits': countEIC,
      'graph-changelog':     countGC,
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

    const forceRefresh = url.searchParams.get('refresh') === '1';
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
      const data = await buildTrackerData(prevItems);
      const json = JSON.stringify(data, null, 2);

      if (env.ENTRA_CACHE) {
        try {
          await env.ENTRA_CACHE.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL_SECONDS });
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
        const data = await buildTrackerData(prevItems);
        const json = JSON.stringify(data, null, 2);
        if (env.ENTRA_CACHE) {
          await env.ENTRA_CACHE.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL_SECONDS });
          console.log(`Cron OK -- ${data.count} items (${data.externalIdCount} External ID, ${data.newCount} new)`);
        }
      } catch (err) { console.error('Cron:', err.message); }
    })());
  },
};
