#!/usr/bin/env bash
#
# Scorecard Alert Dismissal Helper
#
# This script provides examples for dismissing false-positive Scorecard alerts
# that cannot be "fixed" without breaking CodeQL functionality or CI reliability.
#
# IMPORTANT: This script is NOT executed automatically. Run manually when needed.
#
# Usage: bash scripts/scorecard-dismiss.sh
#

set -euo pipefail

REPO="SOVRN144/canvas-mcp"

echo "⚠️  Scorecard Alert Dismissal Helper"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "This script contains COMMENTED-OUT examples for dismissing"
echo "false-positive Scorecard findings. Review and uncomment as needed."
echo ""
echo "Repository: $REPO"
echo ""

# Alert #48: Token-Permissions on CodeQL workflow
# ────────────────────────────────────────────────
# The CodeQL workflow requires 'security-events: write' permission to upload
# SARIF results. This is documented in GitHub's official CodeQL documentation.
#
# Dismiss reason: "codeql_required_permission" or "accepted risk"
#
# Example (COMMENTED OUT - uncomment to use):
#
# gh api \
#   --method PATCH \
#   -H "Accept: application/vnd.github+json" \
#   "/repos/$REPO/code-scanning/alerts/48" \
#   -f dismissed_reason='used in tests' \
#   -f dismissed_comment='CodeQL requires security-events:write to upload SARIF. This is documented and necessary for the analysis to function. Top-level permissions restrict to contents:read, with job-level escalation only for SARIF upload.'

echo "Example 1: Dismiss Alert #48 (Token-Permissions on CodeQL)"
echo "─────────────────────────────────────────────────────────────"
echo "# gh api --method PATCH \\"
echo "#   -H \"Accept: application/vnd.github+json\" \\"
echo "#   \"/repos/$REPO/code-scanning/alerts/48\" \\"
echo "#   -f dismissed_reason='used in tests' \\"
echo "#   -f dismissed_comment='CodeQL requires security-events:write to upload SARIF. Required permission documented in workflow.'"
echo ""

# Alert #45: SAST
# ────────────────
# CodeQL is already configured and running successfully (0 current findings).
# Scorecard may flag this if it doesn't detect the SAST tool in the expected way.
#
# Dismiss reason: "codeql_configured" or "false positive"
#
# Example (COMMENTED OUT - uncomment to use):
#
# gh api \
#   --method PATCH \
#   -H "Accept: application/vnd.github+json" \
#   "/repos/$REPO/code-scanning/alerts/45" \
#   -f dismissed_reason='false positive' \
#   -f dismissed_comment='SAST is active via CodeQL (workflow: .github/workflows/codeql.yml). Current status: 0 alerts. Runs weekly + on all PRs.'

echo "Example 2: Dismiss Alert #45 (SAST)"
echo "─────────────────────────────────────────────────────────────"
echo "# gh api --method PATCH \\"
echo "#   -H \"Accept: application/vnd.github+json\" \\"
echo "#   \"/repos/$REPO/code-scanning/alerts/45\" \\"
echo "#   -f dismissed_reason='false positive' \\"
echo "#   -f dismissed_comment='SAST active via CodeQL. Current: 0 alerts. See .github/workflows/codeql.yml'"
echo ""

# List all open Scorecard alerts
echo "Current Open Alerts:"
echo "─────────────────────────────────────────────────────────────"
gh api "/repos/$REPO/code-scanning/alerts" \
  --jq '.[] | select(.state=="open" and .tool.name=="Scorecard") | "  #\(.number) - \(.rule.id) - \(.rule.description)"' \
  || echo "  (Unable to fetch alerts - ensure gh is authenticated)"
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "To dismiss an alert:"
echo "  1. Review the commented examples above"
echo "  2. Uncomment the appropriate gh api command"
echo "  3. Adjust the alert number if needed"
echo "  4. Run this script"
echo ""
echo "Documentation:"
echo "  https://docs.github.com/en/rest/code-scanning"
echo "════════════════════════════════════════════════════════════════"
