# Security Hardening Checklist

Quick action items to resolve all 31 Scorecard alerts.

## ✅ Immediate Actions (P0 - ~20 min)

### 1. Add Token Permissions to CI Workflow
**File:** `.github/workflows/ci.yml`

Add after line 1:
```yaml
name: CI

permissions:
  contents: read

on:
  push:
  # ... rest remains same
```

### 2. Pin All Actions to Commit SHAs
**Files:** All 3 workflow files

**Find/Replace Pattern:**
```bash
# actions/checkout@v4
→ actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

# actions/setup-node@v4  
→ actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0

# actions/upload-artifact@v4
→ actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3

# github/codeql-action/init@v3
→ github/codeql-action/init@f779452ac5af1c261dce0346a8b332469b86faced # v3.27.9

# github/codeql-action/autobuild@v3
→ github/codeql-action/autobuild@f779452ac5af1c261dce0346a8b332469b86faced # v3.27.9

# github/codeql-action/analyze@v3
→ github/codeql-action/analyze@f779452ac5af1c261dce0346a8b332469b86faced # v3.27.9

# github/codeql-action/upload-sarif@v3
→ github/codeql-action/upload-sarif@f779452ac5af1c261dce0346a8b332469b86faced # v3.27.9
```

**Affected locations:**
- `.github/workflows/ci.yml`: 18 instances
- `.github/workflows/codeql.yml`: 3 instances  
- `.github/workflows/scorecards.yml`: 1 instance

---

## ✅ Quick Documentation (P1 - ~10 min)

### 3. Add Security Policy
**File:** `SECURITY.md` (create at root)

```markdown
# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

## Reporting a Vulnerability

**DO NOT** open a public GitHub issue for security vulnerabilities.

Please report security issues to: [your-email@example.com]

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

Response timeline: 48 hours

## Security Measures

This project uses:
- OSSF Scorecard monitoring
- GitHub CodeQL analysis
- Dependabot security updates
- Pinned GitHub Actions (commit SHAs)
- Least-privilege CI/CD tokens
```

### 4. Add License
**File:** `LICENSE` (create at root)

**Option A - MIT License (recommended for open source):**
```text
MIT License

Copyright (c) 2025 [Your Name/Organization]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Then update `package.json`:**
```json
{
  "license": "MIT",
  // ... rest of package.json
}
```

---

## ✅ Repository Settings (P1 - ~5 min, UI only)

### 5. Enable Branch Protection

**Steps:**
1. Go to: `https://github.com/SOVRN144/canvas-mcp/settings/branches`
2. Click "Add branch protection rule"
3. Branch name pattern: `main`
4. Enable these settings:
   - [x] Require a pull request before merging
     - Required approvals: 1
     - [x] Dismiss stale pull request approvals when new commits are pushed
   - [x] Require status checks to pass before merging
     - [x] Require branches to be up to date before merging
     - Search and add: `build`, `Analyze (CodeQL)`, `Scorecard analysis`
   - [x] Require conversation resolution before merging
   - [x] Do not allow bypassing the above settings
5. Click "Create" / "Save changes"

---

## 📋 Optional Items (P3-P5)

### 6. SAST Configuration
**Status:** ✅ Already have CodeQL  
**Action:** None needed. Alert may be false positive.

### 7. Fuzzing
**Status:** Not applicable for this project type  
**Action:** Mark as "won't fix" or ignore

### 8. CII Best Practices Badge
**Status:** Optional certification  
**Action:** Register at [https://bestpractices.coreinfrastructure.org](https://bestpractices.coreinfrastructure.org) if desired

---

## 🔍 Verification

After applying fixes, verify:

```bash
# Check that workflows are valid
gh workflow list

# Trigger a test run
gh workflow run ci.yml

# Monitor the security dashboard
open https://github.com/SOVRN144/canvas-mcp/security/code-scanning
```

Expected result: Alerts should drop from 31 → ~5 (only optional items remain)

---

## 📊 Progress Tracking

- [ ] Token permissions added to ci.yml
- [ ] All actions pinned to commit SHAs (22 instances)
- [ ] SECURITY.md created
- [ ] LICENSE file created
- [ ] package.json license field updated
- [ ] Branch protection enabled for main
- [ ] Verified in security dashboard

**Time estimate:** 30-40 minutes total

---

## 🚀 Quick Commands

**Check current branch protection:**
```bash
gh api repos/SOVRN144/canvas-mcp/branches/main/protection 2>/dev/null || echo "No protection configured"
```

**List all unpinned actions:**
```bash
grep -r "uses:.*@v[0-9]" .github/workflows/
```

**Verify security alerts:**
```bash
gh api repos/SOVRN144/canvas-mcp/code-scanning/alerts --jq 'length'
```

---

**Note:** This checklist addresses all 31 current alerts. New alerts may appear as code changes or new Scorecard rules are added. Monitor the security dashboard regularly.
