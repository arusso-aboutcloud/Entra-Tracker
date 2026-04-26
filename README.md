# Entra Tracker

Onboarded from Cloudflare standalone to GitHub management.

## Architecture & Infrastructure

### 1. API (Cloudflare Worker)
- **Directory**: `/api`
- **Worker Name**: `entra-tracker`
- **Worker Tag**: `b4408e5d540d44b1a1f87d2fd7d0fbaa`
- **KV Binding**: `ENTRA_CACHE`
- **KV Namespace ID**: `7f7ec741df00421cbdefc462630c7b75`
- **Routes**: No direct routes; served via custom domain CNAMEs.

### 2. Frontend (Cloudflare Pages)
- **Directory**: `/web`
- **Project Name**: `0eeac592-ca6a-4f96-8665-152467c1ff4c` (entra-tracker)
- **Subdomain**: `entra-tracker.pages.dev`
- **Custom Domains**:
  - `entratracker.aboutcloud.io`
  - `tracker.aboutcloud.io`

### 3. Secrets & Environment
- **Secrets**: None found in current Cloudflare configuration (Workers/Pages).
- **GitHub Secrets needed for CI/CD (Planned)**:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`

---
*Last sync: Sun Apr 26 01:25:30 PM UTC 2026*
