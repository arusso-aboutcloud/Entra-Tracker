# Security Policy

## Supported Versions

Entra Change Tracker is a continuously deployed service hosted on Cloudflare
Pages. Users always receive the latest version automatically. Security fixes
are applied to `main` and promoted to production within one business day.

| Version | Status |
|---------|--------|
| Latest deployed (`main`) | Supported |
| Any pinned or self-hosted fork | Not supported |

---

## Reporting a Vulnerability

**Please do not open a public GitHub Issue for security vulnerabilities.**

Report privately via
[GitHub Security Advisories](https://github.com/arusso-aboutcloud/Entra-Tracker/security/advisories/new).

Include as much as possible:

- A clear description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept
- Browser and OS (for frontend issues) or HTTP trace (for API issues)

### Response timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | Within 48 hours |
| Initial triage | Within 5 business days |
| Fix or mitigation | Dependent on severity (see below) |
| Public disclosure | Coordinated with the reporter |

| Severity | Fix target |
|----------|------------|
| Critical (worker exploit, data exfiltration) | Within 24–48 hours |
| High (XSS, injection, information disclosure) | Within 7 days |
| Medium (CORS misconfiguration, CSP bypass) | Within 30 days |
| Low (hardening improvements) | Next regular release |

---

## Security Architecture

### What Entra Change Tracker does

- Serves a **public, unauthenticated** static frontend and a Cloudflare
  Worker API that returns Microsoft Entra ID change data (retirements,
  breaking changes, preview features)
- All data consists of **publicly available Microsoft announcements** —
  no user data or PII is stored or processed
- Change data is fetched from Microsoft's official sources by an automated
  pipeline and stored in the Cloudflare Worker's KV store
- No user authentication is required or collected

### What Entra Change Tracker does not do

- Collect, store, or process any user data or credentials
- Accept write input from external users
- Hold secrets in source code

### Trust boundaries

| Boundary | Notes |
|----------|-------|
| Internet → Cloudflare Worker | Cloudflare WAF; unauthenticated public API |
| Worker → KV | Cloudflare-internal binding; no network exposure |
| GitHub Actions → Cloudflare | API token scoped to Worker deploy + KV write |

---

## In-Scope Vulnerabilities

- **XSS** — script injection via change tracking data rendered in the frontend
- **Worker exploit** — remote code execution or data exfiltration from the
  Cloudflare Worker process
- **Injection** — malicious input reaching KV keys or response construction
  in the Worker
- **CORS misconfiguration** — cross-origin access from unintended origins
- **CSP bypass** — circumventing the `Content-Security-Policy` header
- **Sensitive data in source** — credentials or API tokens committed to the
  public repository
- **Supply chain** — malicious code introduced via a dependency

---

## Out-of-Scope

- Vulnerabilities in **Microsoft's Entra ID documentation** or announcement
  channels that are the data sources for this tracker
- Vulnerabilities in **Cloudflare's platform** — report to
  [Cloudflare](https://www.cloudflare.com/disclosure/)
- The fact that all tracked content is publicly available Microsoft data
- Scanner findings with no demonstrated impact (automated reports without a PoC)
- Social engineering or physical attacks

---

## Dependency Security

- **Trivy** runs a filesystem vulnerability scan on every push
  (`trivy-scan.yml`), with results uploaded to GitHub Security → Code
  scanning alerts and reflected in the repository badge

---

## Security Contact

Report vulnerabilities via
[GitHub Security Advisories](https://github.com/arusso-aboutcloud/Entra-Tracker/security/advisories/new)
or contact [security@aboutcloud.io](mailto:security@aboutcloud.io).
