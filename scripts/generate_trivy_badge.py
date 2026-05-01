#!/usr/bin/env python3
"""Generate Trivy security badge SVG from scan results JSON."""

import json
import sys
from datetime import datetime, timezone

def generate_badge(results_path="trivy-results.json", output_path="trivy-badge.svg"):
    with open(results_path) as f:
        data = json.load(f)

    results = data.get("Results", [])
    total_secrets = 0
    total_misconfig = 0
    total_vulns = 0
    secret_critical = 0
    misconfig_critical = 0

    for r in results:
        secrets = r.get("Secrets", [])
        total_secrets += len(secrets)
        for s in secrets:
            if s.get("Severity", "").upper() == "CRITICAL":
                secret_critical += 1

        misconfigs = r.get("Misconfigurations", [])
        total_misconfig += len(misconfigs)
        for m in misconfigs:
            if m.get("Severity", "").upper() == "CRITICAL":
                misconfig_critical += 1

        vulns = r.get("Vulnerabilities", [])
        total_vulns += len(vulns)

    total_findings = total_secrets + total_misconfig + total_vulns

    if total_findings == 0:
        color = "#28a745"
        label = "CLEAN"
    elif total_findings <= 3:
        color = "#f0883e"
        label = "{} FINDINGS".format(total_findings)
    else:
        color = "#cb2431"
        label = "{} FINDINGS".format(total_findings)

    if secret_critical > 0 or misconfig_critical > 0:
        label += " \u2022 {} CRIT".format(secret_critical + misconfig_critical)
        color = "#cb2431"

    scan_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    svg = """<svg xmlns="http://www.w3.org/2000/svg" width="380" height="28">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#161b22"/>
    </linearGradient>
  </defs>
  <rect width="380" height="28" rx="6" fill="url(#bg)" stroke="#30363d" stroke-width="1"/>
  <circle cx="14" cy="14" r="5" fill="__COLOR__" opacity="0.8">
    <animate attributeName="opacity" values="0.8;0.4;0.8" dur="2s" repeatCount="indefinite"/>
  </circle>
  <text x="26" y="14" fill="#8b949e" font-family="monospace" font-size="11" font-weight="600" dominant-baseline="middle">trivy</text>
  <line x1="68" y1="6" x2="68" y2="22" stroke="#30363d" stroke-width="1"/>
  <text x="200" y="14" fill="__COLOR__" font-family="monospace" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="middle">__LABEL__</text>
  <circle cx="360" cy="14" r="4" fill="__COLOR__" opacity="0.6">
    <animate attributeName="r" values="4;6;4" dur="1.5s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.6;0.2;0.6" dur="1.5s" repeatCount="indefinite"/>
  </circle>
  <text x="380" y="14" fill="#484f58" font-family="monospace" font-size="8" text-anchor="end" dominant-baseline="middle">__DATE__</text>
</svg>"""

    svg = svg.replace("__COLOR__", color).replace("__LABEL__", label).replace("__DATE__", scan_date)

    with open(output_path, "w") as f:
        f.write(svg)

    print("Badge: {} (secrets={}, misconfigs={}, vulns={})".format(
        label, total_secrets, total_misconfig, total_vulns))

if __name__ == "__main__":
    generate_badge()
