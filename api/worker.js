/**
 * Entra Tracker — Cloudflare Worker v3
 * Endpoint: api.aboutcloud.io/entra-tracker
 *
 * Sources (all GitHub raw — MicrosoftDocs official repos):
 *   1. entra-docs: fundamentals/whats-new.md       → core Entra ID (+ B2C/ExternalID items inside)
 *   2. techcommunity RSS                            → Entra blog announcements
 *   3. entra-docs: external-id/whats-new-docs.md   → External ID docs changelog
 *   4. azure-docs: active-directory-b2c/whats-new-docs.md → B2C docs changelog
 *
 * Parsing strategy:
 *   - Source 1: H3 + **Type:** + **Service category:** blocks (feature releases)
 *   - Source 2: RSS XML
 *   - Sources 3-4: bullet * [Title](url) - description (docs change logs)
 */

const ALLOWED_ORIGINS = [
  'https://aboutcloud.io',
  'https://tracker.aboutcloud.io',
  'https://entratracker.aboutcloud.io',
  'http://localhost:3000',
  'http://localhost:2368',
];

const CACHE_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const CACHE_KEY         = 'entra_tracker_v3';

// ── SOURCES ────────────────────────────────────────────────────────────────

// Primary: GitHub raw markdown — the actual What's New page
const WHATS_NEW_URL = 'https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/fundamentals/whats-new.md';

// FSLogix Release Notes — fetched from learn.microsoft.com (markdown source is private repo)
// Parser handles HTML callout divs (is-warning, is-important, is-caution) and NOTE blocks
const FSLOGIX_RELEASE_NOTES_URL = 'https://learn.microsoft.com/en-us/fslogix/overview-release-notes';

// External ID docs changelog (bullet format)
const EXTERNAL_ID_DOCS_URL = 'https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/external-id/whats-new-docs.md';

// B2C docs changelog (bullet format)
const B2C_DOCS_URL = 'https://raw.githubusercontent.com/MicrosoftDocs/azure-docs/main/articles/active-directory-b2c/whats-new-docs.md';

// ── EXTERNAL ID DETECTION ──────────────────────────────────────────────────
const EXTERNAL_ID_SERVICE_CATEGORIES = [
  'b2c', 'external id', 'external-id', 'ciam', 'consumer identity',
  'b2b', 'b2b collaboration', 'b2b direct connect', 'cross-tenant',
  'workforce and external',
];

const EXTERNAL_ID_TITLE_KEYWORDS = [
  'b2c', 'external id', 'external tenant', 'customer identity',
  'guest user', 'external user', 'cross-tenant', 'b2b',
  'user flow', 'custom policy', 'identity experience framework',
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
function extractDeadline(text) {
  const lower = text.toLowerCase();

  const isoM = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoM) { const d = new Date(`${isoM[1]}-${isoM[2]}-${isoM[3]}`); if (!isNaN(d)) return d; }

  const mdyM = lower.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdyM) { const d = new Date(+mdyM[3], MONTHS[mdyM[1]]-1, +mdyM[2]); if (!isNaN(d)) return d; }

  const dmyM = lower.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/);
  if (dmyM) { const d = new Date(+dmyM[3], MONTHS[dmyM[2]]-1, +dmyM[1]); if (!isNaN(d)) return d; }

  const myM = lower.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/);
  if (myM) { const d = new Date(+myM[2], MONTHS[myM[1]], 0); if (!isNaN(d)) return d; }

  return null;
}

function deriveStatus(deadline) {
  if (!deadline) return 'green';
  const days = Math.ceil((deadline - new Date()) / 86400000);
  if (days <= 0)   return 'expired';
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
  return btoa(unescape(encodeURIComponent(title.slice(0, 40)))).replace(/[^a-zA-Z0-9]/g,'').slice(0,16);
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

        // Next H3 or H2 means new entry — stop
        if (l.match(/^#{2,3}\s/)) break;

        // Horizontal rule separator
        if (l.trim() === '---') { i++; break; }

        // **Type:** Plan for change
        const typeMatch = l.match(/\*\*Type:\*\*\s*(.+)/i);
        if (typeMatch) { typeVal = typeMatch[1].trim(); i++; continue; }

        // **Service category:** B2C - Consumer Identity Management
        const svcMatch = l.match(/\*\*Service category:\*\*\s*(.+)/i);
        if (svcMatch) { serviceCategory = svcMatch[1].trim(); i++; continue; }

        // **Product capability:** — skip, not needed
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

      // ⚠️  Extract deadline from CONTENT ONLY — never from currentMonth (publication date ≠ deadline)
      const contentText = `${title} ${description}`;
      const deadline    = extractDeadline(contentText);

      // Derive category — prefer explicit Type field
      const typeLower = typeVal.toLowerCase();
      const category  = TYPE_TO_CATEGORY[typeLower] || classifyByKeyword(title, description);

      const namespace = isExternalId(title, serviceCategory) ? 'external-id' : 'entra-id';

      // whats-new.md is Microsoft's own curated changelog — every entry is worth showing.
      // No additional filtering needed: if Microsoft put it on the page, it matters.
      // (The deadline gate is NOT applied here — it was causing 85→28 drop by excluding
      //  all GA/Preview feature announcements that have no hard retirement deadline.)

      const status  = deriveStatus(deadline);
      const impact  = deriveImpact(category, contentText);
      const days    = deadline ? Math.ceil((deadline - new Date()) / 86400000) : null;

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
      });
      continue; // i already advanced inside the inner loop
    }

    i++;
  }

  return results;
}

// ── PARSER 2: Docs changelog (bullet * [Title](url) - description) ─────────
function parseDocsChangelog(markdown, sourceLabel, namespace, subtype) {
  const results = [];
  const lines   = markdown.split('\n');
  let section   = '';

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { section = h2[1].trim(); continue; }

    // * [Article title](url) - Description
    const bullet = line.match(/^\*\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*[-–]\s*(.+))?/);
    if (!bullet) continue;

    const title       = bullet[1].trim();
    const rawLink     = bullet[2].trim();
    const description = (bullet[3] || `Doc update: ${section}`).trim().slice(0, 400);

    if (title.length < 5) continue;

    const link = rawLink.startsWith('http')
      ? rawLink
      : `https://learn.microsoft.com/en-us/entra/external-id/${rawLink}`;

    const fullText = `${title} ${description} ${section}`;
    const category = classifyByKeyword(title, description);
    const deadline = extractDeadline(fullText);

    // Docs changelogs: only keep retirements, breaking, and previews — skip plain updates
    if (category === 'new_feature') continue;

    const status = deriveStatus(deadline);
    const impact = deriveImpact(category, fullText);
    const days   = deadline ? Math.ceil((deadline - new Date()) / 86400000) : null;

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
    });
  }

  return results;
}

// ── PARSER 3: FSLogix learn.microsoft.com HTML — warning/important callout blocks ──
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
    // Only keep items with a deadline date OR explicit breaking language
    const hasDeadline = extractDeadline(text) !== null;
    const hasActionLang = /action required|upcoming change|breaking|will fail|access issues|disruption|must upgrade|before.*update/i.test(text);
    if (!hasDeadline && !hasActionLang) continue;

    const firstSentence = text.split(/\.\s/)[0].slice(0, 120);
    const title = `[FSLogix] ${firstSentence}`;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    const deadline  = extractDeadline(text);
    const category  = /action required|breaking|will fail|must|before.*update/i.test(text) ? 'breaking' : 'preview';
    const status    = deriveStatus(deadline);
    const days      = deadline ? Math.ceil((deadline - new Date()) / 86400000) : null;

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
    const deadline = extractDeadline(text);
    const status   = deriveStatus(deadline);
    const impact   = deriveImpact(category, text);
    const days     = deadline ? Math.ceil((deadline - new Date()) / 86400000) : null;
    const namespace = isExternalId(item.title, '') ? 'external-id' : 'entra-id';

    // Tech Community Entra blog is editorially curated — include all posts.
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
    });
  }
  return results;
}

// ── BUILD FULL DATASET ─────────────────────────────────────────────────────
async function buildTrackerData() {
  const allItems = [];
  const errors   = [];

  // Source 1: Main Entra What's New markdown
  let countWN = 0;
  try {
    const md    = await fetchText(WHATS_NEW_URL);
    const items = parseWhatsNewMarkdown(md);
    allItems.push(...items);
    countWN = items.length;
    console.log(`whats-new.md: ${items.length} items`);
  } catch (err) { errors.push(`whats-new: ${err.message}`); console.error(err.message); }

  // Source 2: FSLogix Release Notes — breaking change warnings affecting Azure Files + Entra Kerberos
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
    const items = parseDocsChangelog(md, 'external-id-docs', 'external-id', 'External ID');
    allItems.push(...items);
    countEI = items.length;
    console.log(`external-id-docs: ${items.length} items`);
  } catch (err) { errors.push(`external-id-docs: ${err.message}`); console.error(err.message); }

  // Source 4: B2C docs changelog
  let countB2C = 0;
  try {
    const md    = await fetchText(B2C_DOCS_URL);
    const items = parseDocsChangelog(md, 'b2c-docs', 'external-id', 'Azure AD B2C');
    allItems.push(...items);
    countB2C = items.length;
    console.log(`b2c-docs: ${items.length} items`);
  } catch (err) { errors.push(`b2c-docs: ${err.message}`); console.error(err.message); }

  // Sort: expired → red → yellow → green, then days asc
  const ORDER = { expired:0, red:1, yellow:2, green:3 };
  allItems.sort((a, b) => {
    const sd = (ORDER[a.status]??4) - (ORDER[b.status]??4);
    if (sd !== 0) return sd;
    if (a.daysRemaining !== null && b.daysRemaining !== null) return a.daysRemaining - b.daysRemaining;
    return 0;
  });

  // Deduplicate by title prefix (strip subtype prefix for comparison)
  const deduped = [];
  const seen    = new Set();
  for (const item of allItems) {
    const key = item.title.replace(/^\[[^\]]+\]\s+/,'').toLowerCase().slice(0,60);
    if (!seen.has(key)) { seen.add(key); deduped.push(item); }
  }

  const externalIdCount = deduped.filter(i => i.namespace === 'external-id').length;

  return {
    lastUpdated:    new Date().toISOString(),
    count:          deduped.length,
    externalIdCount,
    sources: { 'whats-new-md': countWN, 'fslogix-docs': countFS, 'external-id-docs': countEI, 'b2c-docs': countB2C },
    errors:         errors.length ? errors : undefined,
    items:          deduped,
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

    if (env.ENTRA_CACHE && !forceRefresh) {
      try {
        const cached = await env.ENTRA_CACHE.get(CACHE_KEY, 'text');
        if (cached)
          return new Response(cached, {
            headers: { 'Content-Type':'application/json','X-Cache':'HIT',
                       'Cache-Control':`public, max-age=${CACHE_TTL_SECONDS}`,...corsHeaders(origin) },
          });
      } catch (e) { console.error('KV read:', e.message); }
    }

    try {
      const data = await buildTrackerData();
      const json = JSON.stringify(data, null, 2);

      if (env.ENTRA_CACHE) {
        try {
          await env.ENTRA_CACHE.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL_SECONDS });
        } catch (e) { console.error('KV write:', e.message); }
      }

      return new Response(json, {
        headers: { 'Content-Type':'application/json','X-Cache':'MISS',
                   'Cache-Control':`public, max-age=${CACHE_TTL_SECONDS}`,...corsHeaders(origin) },
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
        const data = await buildTrackerData();
        const json = JSON.stringify(data, null, 2);
        if (env.ENTRA_CACHE) {
          await env.ENTRA_CACHE.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL_SECONDS });
          console.log(`Cron OK — ${data.count} items (${data.externalIdCount} External ID)`);
        }
      } catch (err) { console.error('Cron:', err.message); }
    })());
  },
};

