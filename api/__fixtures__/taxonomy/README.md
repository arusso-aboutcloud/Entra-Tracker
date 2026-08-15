Fixtures here are real captured Microsoft text (whats-new.md entries, a real Graph changelog description), per the "real fixtures where parsing is involved" rule. Captured 2026-08-14 from the same live fetches used for Phase 1's fixtures.

## Bugs found and fixed during Phase 2 development (documented for posterity)

Building the taxonomy against real data (not just imagined test cases) surfaced three real classification bugs before this PR was opened. All three are covered by regression fixtures/tests in this directory and `api/worker.test.js`.

1. **`signin` embedded in `assigning`.** An early taxonomy draft carried `signin`/`sign-in` as Microsoft-Graph-identity-APIs terms, ported from the old `GRAPH_ENTRA_RE`'s `\bsignin\b`. The old regex used a word boundary; the taxonomy's plain substring check didn't, so `assigning` (contains `s-i-g-n-i-n` starting at its 3rd character) matched it. A real whats-new.md entry about token lifetime policies — nothing to do with Graph API sign-in resources — got wrongly classified via this. Fixed by dropping `signin`/`sign-in` from the taxonomy entirely; `graph api`/`microsoft graph` still cover genuinely Graph-relevant items without the risk. See `token-lifetime-policies.json`.

2. **`app registration` too generic.** Mentioned in passing in an audit-log entry that has nothing to do with the Microsoft identity platform / MSAL developer story. Dropped from `identity-platform-msal`'s terms.

3. **Incidental mentions outranking the authoritative signal.** Real Microsoft prose routinely name-drops other Entra features in passing (an "Entra Backup and Recovery" entry listing "Conditional Access policies, named locations" among the object types it backs up). A flat "check every entry's terms against combined text, first match in array order wins" design let those incidental mentions win primary classification over the entry an item is actually about. Fixed by making `classifyTaxonomy` two-tier: the raw Microsoft **Service category:** field (Tier 1, authoritative) always decides the primary when present; title/description terms (Tier 2) only decide it when there's no Tier 1 match. See `backup-and-recovery.json` and `domainless-saml-b2b.json`.

4. **(Relevance-gate variant of #3) `provisioning` embedded in `cloudPcProvisioningPolicy`.** A real Graph changelog item about Windows 365 Cloud PC provisioning policy properties — not an identity topic at all — passed the Entra-relevance gate because `matchesAnyTaxonomyEntry` was checking a merged term list that included `serviceCategoryTerms` (short labels meant only for matching Microsoft's own category field) against arbitrary free text, and `provisioning` is a substring of `cloudPcProvisioningPolicy`. Fixed by making `matchesAnyTaxonomyEntry` check `titleTerms` only, never `serviceCategoryTerms`, against free text. See `cloud-pc-off-topic.txt` — this item is correctly excluded by `parseGraphChangelog` as of this PR.

## Raw → canonical `serviceCategory` mapping (live data, 2026-08-14 fetch)

Every raw Microsoft `serviceCategory` string seen in the current live `whats-new.md`, and what it now normalises to. 99 of 105 currently-live items changed their `serviceCategory` string value as a result (expected — this is the normalisation the taxonomy exists to do); zero items were dropped.

| Raw Microsoft string | → Canonical taxonomy name |
|---|---|
| Audit | Entra ID (workforce) |
| Authentications (Logins) | Authentication methods |
| B2B | Entra External ID / Azure AD B2C |
| B2C - Consumer Identity Management | Entra External ID / Azure AD B2C |
| BYOD / BYOD support | Entra ID (workforce) |
| Device Access Management | Entra ID (workforce) |
| Device Registration and Management | Entra ID (workforce) |
| Entitlement Management (+ Lifecycle Workflows) | Entra ID Governance |
| Entra Backup and Recovery | Entra ID (workforce) |
| Entra Connect | Entra Connect and Cloud Sync |
| Group Management | Entra ID (workforce) |
| Internet Access | Global Secure Access (Private Access / Internet Access) |
| iOS client | Global Secure Access (Private Access / Internet Access) |
| Lifecycle Workflows | Entra ID Governance |
| MFA | Authentication methods |
| Microsoft Authenticator App | Authentication methods |
| Microsoft Identity Manager | Entra Connect and Cloud Sync |
| Modernized My Account pages | Entra ID (workforce) |
| MS Graph | Microsoft Graph identity APIs |
| My Profile/Account | Entra ID (workforce) |
| Other | Entra ID (workforce) |
| Private Access | Global Secure Access (Private Access / Internet Access) |
| Provisioning | Entra ID (workforce) |
| RBAC | Entra ID (workforce) |
| Reporting | Entra ID (workforce) |
| Tenant Governance | Entra ID Governance |
| User Experience and Management | Entra ID (workforce) |
| User Management | Entra ID (workforce) |
| Conditional Access | Conditional Access *(unchanged — raw string already matches canonical)* |
| Privileged Identity Management | Privileged Identity Management *(unchanged)* |

Sources without a raw `serviceCategory` field (fslogix-docs, external-id-docs, b2c-docs, external-id-commits, graph-changelog) are classified entirely from title/description text (Tier 2). `fslogix-docs`'s previous hardcoded `'Azure Files / FSLogix'` label is gone, replaced by real per-item classification (both current live FSLogix items classify as `Authentication methods`, since both are Kerberos-related).

## `Other` and `Provisioning` → `Entra ID (workforce)`

Both fold into the broad workforce catch-all rather than getting their own taxonomy entries. `Other` is Microsoft's own miscellaneous bucket (currently covers 2 live items: "Microsoft Entra Agent ID platform" and "Agent Registry consolidation into Microsoft Agent 365" — both genuinely core-Entra-ID feature areas, just not yet categorized narrowly by Microsoft itself). `Provisioning` is a real, recurring Entra ID category (HR-driven provisioning, SCIM, AD group enforcement) that isn't in the work order's starter taxonomy list; extending `Entra ID (workforce)`'s terms to include it, rather than adding a 15th top-level entry for what is fundamentally a core Entra ID administrative capability, was the more conservative choice — flagged here per the "extend only with justification recorded in the PR" rule.
