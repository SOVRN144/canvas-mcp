#!/usr/bin/env bash
#
# Scorecard Alert Dismissal Helper
#
# This script provides examples for dismissing false-positive Scorecard alerts
# that cannot be "fixed" without breaking CodeQL functionality or CI reliability.
#
# IMPORTANT: This script is NOT executed automatically. Run manually when needed.
#
# Usage:
#   - Set REPO env var to target another repo (optional)
#   - Run the list command to view open alerts
#   - Copy a commented loop, review alert numbers, then uncomment and execute
#   - Script is manual; not invoked by CI
#
# Example:
#   REPO=owner/repo bash scripts/scorecard-dismiss.sh
#

set -euo pipefail

# Allow REPO override; default to GITHUB_REPOSITORY or fallback
REPO="${REPO:-${GITHUB_REPOSITORY:-SOVRN144/canvas-mcp}}"

# Verify gh CLI is available
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install & authenticate: https://cli.github.com/" >&2
  exit 1
fi

echo "⚠️  Scorecard Alert Dismissal Helper"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Repo: $REPO"
echo ""
echo "This script contains COMMENTED-OUT examples for dismissing"
echo "false-positive Scorecard findings. Review and uncomment as needed."
echo ""

# ────────────────────────────────────────────────────────────────────
# Example 1: Token-Permissions (CodeQL workflow)
# ────────────────────────────────────────────────────────────────────
# The CodeQL workflow requires 'security-events: write' permission to upload
# SARIF results. This is documented in GitHub's official CodeQL documentation.
#
# Dismiss reason: "won't fix" (this is required behavior, not a security issue)
#
# Example (COMMENTED OUT - uncomment to use):
#
# for n in $(gh api "/repos/$REPO/code-scanning/alerts" --paginate \
#   --jq '.[] | select(.state=="open" and .tool.name=="Scorecard" and .rule.id=="TokenPermissionsID") | .number'); do
#   gh api -X PATCH "/repos/$REPO/code-scanning/alerts/$n" \
#     -f state=dismissed \
#     -f dismissed_reason="won't fix" \
#     -f dismissed_comment="CodeQL requires security-events:write to upload SARIF; documented in workflow."; done

echo "Example 1: Dismiss Token-Permissions Alerts"
echo "─────────────────────────────────────────────────────────────"
echo "# for n in \$(gh api \"/repos/$REPO/code-scanning/alerts\" --paginate \\"
echo "#   --jq '.[] | select(.state==\"open\" and .tool.name==\"Scorecard\" and .rule.id==\"TokenPermissionsID\") | .number'); do"
echo "#   gh api -X PATCH \"/repos/$REPO/code-scanning/alerts/\$n\" \\"
echo "#     -f state=dismissed \\"
echo "#     -f dismissed_reason=\"won't fix\" \\"
echo "#     -f dismissed_comment=\"CodeQL requires security-events:write to upload SARIF; documented in workflow.\"; done"
echo ""

# ────────────────────────────────────────────────────────────────────
# Example 2: Pinned-Dependencies
# ────────────────────────────────────────────────────────────────────
# Dependencies are already pinned via package-lock.json and installed
# deterministically with 'npm ci'. Scorecard may flag npm commands.
#
# Dismiss reason: "won't fix" (dependencies are properly pinned)
#
# Example (COMMENTED OUT - uncomment to use):
#
# for n in $(gh api "/repos/$REPO/code-scanning/alerts" --paginate \
#   --jq '.[] | select(.state=="open" and .tool.name=="Scorecard" and .rule.id=="PinnedDependenciesID") | .number'); do
#   gh api -X PATCH "/repos/$REPO/code-scanning/alerts/$n" \
#     -f state=dismissed \
#     -f dismissed_reason="won't fix" \
#     -f dismissed_comment="Deterministic installs via npm ci; package-lock.json pins deps."; done

echo "Example 2: Dismiss Pinned-Dependencies Alerts"
echo "─────────────────────────────────────────────────────────────"
echo "# for n in \$(gh api \"/repos/$REPO/code-scanning/alerts\" --paginate \\"
echo "#   --jq '.[] | select(.state==\"open\" and .tool.name==\"Scorecard\" and .rule.id==\"PinnedDependenciesID\") | .number'); do"
echo "#   gh api -X PATCH \"/repos/$REPO/code-scanning/alerts/\$n\" \\"
echo "#     -f state=dismissed \\"
echo "#     -f dismissed_reason=\"won't fix\" \\"
echo "#     -f dismissed_comment=\"Deterministic installs via npm ci; package-lock.json pins deps.\"; done"
echo ""

# ────────────────────────────────────────────────────────────────────
# Example 3: SAST
# ────────────────────────────────────────────────────────────────────
# CodeQL is already configured and running successfully (0 current findings).
# Scorecard may flag this if it doesn't detect the SAST tool in the expected way.
#
# Dismiss reason: "false positive" (SAST is active via CodeQL)
#
# Example (COMMENTED OUT - uncomment to use):
#
# for n in $(gh api "/repos/$REPO/code-scanning/alerts" --paginate \
#   --jq '.[] | select(.state=="open" and .tool.name=="Scorecard" and .rule.id=="SASTID") | .number'); do
#   gh api -X PATCH "/repos/$REPO/code-scanning/alerts/$n" \
#     -f state=dismissed \
#     -f dismissed_reason="false positive" \
#     -f dismissed_comment="CodeQL SAST is configured and 0 alerts."; done

echo "Example 3: Dismiss SAST Alerts"
echo "─────────────────────────────────────────────────────────────"
echo "# for n in \$(gh api \"/repos/$REPO/code-scanning/alerts\" --paginate \\"
echo "#   --jq '.[] | select(.state==\"open\" and .tool.name==\"Scorecard\" and .rule.id==\"SASTID\") | .number'); do"
echo "#   gh api -X PATCH \"/repos/$REPO/code-scanning/alerts/\$n\" \\"
echo "#     -f state=dismissed \\"
echo "#     -f dismissed_reason=\"false positive\" \\"
echo "#     -f dismissed_comment=\"CodeQL SAST is configured and 0 alerts.\"; done"
echo ""

# ────────────────────────────────────────────────────────────────────
# List all open alerts with tool names
# ────────────────────────────────────────────────────────────────────
echo "Current Open Alerts:"
echo "─────────────────────────────────────────────────────────────"
gh api "/repos/$REPO/code-scanning/alerts" --paginate \
  --jq '.[] | select(.state=="open") | "\(.number)\t\(.tool.name)\t\(.rule.id)\t\(.rule.description)"' 2>/dev/null |
  awk -F'\t' 'BEGIN{printf("%-6s  %-18s  %-26s  %s\n","#","tool","rule","description")} {printf("%-6s  %-18s  %-26s  %s\n",$1,$2,$3,$4)}' \
  || echo "  (Unable to fetch alerts - ensure gh is authenticated)"
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "To dismiss an alert:"
echo "  1. Review the commented examples above"
echo "  2. Copy the appropriate loop command"
echo "  3. Review the alert numbers in the table"
echo "  4. Uncomment and run the loop"
echo ""
echo "Documentation:"
echo "  https://docs.github.com/en/rest/code-scanning"
echo "════════════════════════════════════════════════════════════════"
