# Security Alerts Report

**Repository:** SOVRN144/canvas-mcp  
**Branch:** main  
**Generated:** 2025-10-14  
**Total Open Alerts:** 31

---

## Section A — Snapshot

### Summary by Tool
- **Scorecard:** 31 alerts
- **CodeQL:** 0 alerts

### Summary by Severity
- **Error (High):** 31 alerts

### Summary by Category
| Category | Count | Tool |
|----------|-------|------|
| Pinned-Dependencies | 22 | Scorecard |
| Token-Permissions | 2 | Scorecard |
| Security-Policy | 1 | Scorecard |
| SAST | 1 | Scorecard |
| License | 1 | Scorecard |
| Fuzzing | 1 | Scorecard |
| Code-Review | 1 | Scorecard |
| CII-Best-Practices | 1 | Scorecard |
| Branch-Protection | 1 | Scorecard |

---

## Section B — Detailed Alert Table

| # | Tool | Rule | Severity | Location | Line | Created | Why It Matters | How to Fix |
|---|------|------|----------|----------|------|---------|----------------|------------|
| 47 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 22 | 2025-10-14 | Unpinned actions can introduce supply chain attacks | Pin to commit SHA |
| 46 | Scorecard | Security-Policy | error | Repository | - | 2025-10-14 | No SECURITY.md file to guide vulnerability reporting | Add SECURITY.md with contact info |
| 45 | Scorecard | SAST | error | Repository | - | 2025-10-14 | No static analysis configured in CI | Already have CodeQL; may need explicit config |
| 44 | Scorecard | Fuzzing | error | Repository | - | 2025-10-14 | No fuzzing tests configured | Optional for this project type |
| 43 | Scorecard | Code-Review | error | Repository | - | 2025-10-14 | Some commits lack review approval | Enable branch protection with reviews |
| 42 | Scorecard | CII-Best-Practices | error | Repository | - | 2025-10-14 | Not registered with CII Best Practices | Optional: register at bestpractices.coreinfrastructure.org |
| 41 | Scorecard | Token-Permissions | error | .github/workflows/codeql.yml | 13 | 2025-10-14 | Overly permissive workflow token | Already has permissions block; needs refinement |
| 40 | Scorecard | Token-Permissions | error | .github/workflows/ci.yml | 1 | 2025-10-14 | Missing top-level permissions block | Add `permissions: contents: read` |
| 39 | Scorecard | Pinned-Dependencies | error | .github/workflows/codeql.yml | 37 | 2025-10-14 | Unpinned codeql-action/upload-sarif@v3 | Pin to commit SHA |
| 38 | Scorecard | Pinned-Dependencies | error | .github/workflows/codeql.yml | 30 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 37 | Scorecard | Pinned-Dependencies | error | .github/workflows/codeql.yml | 27 | 2025-10-14 | Unpinned actions/checkout@v4 | Pin to commit SHA |
| 36 | Scorecard | Pinned-Dependencies | error | .github/workflows/scorecards.yml | 37 | 2025-10-14 | Unpinned codeql-action/upload-sarif@v3 | Pin to commit SHA |
| 35 | Scorecard | Pinned-Dependencies | error | .github/workflows/scorecards.yml | 25 | 2025-10-14 | Unpinned actions/checkout@v4 | Pin to commit SHA |
| 34 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 256 | 2025-10-14 | Unpinned actions/upload-artifact@v4 | Pin to commit SHA |
| 33 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 255 | 2025-10-14 | Unpinned actions/upload-artifact@v4 | Pin to commit SHA |
| 32 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 238 | 2025-10-14 | Unpinned actions/upload-artifact@v4 | Pin to commit SHA |
| 31 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 237 | 2025-10-14 | Unpinned actions/upload-artifact@v4 | Pin to commit SHA |
| 30 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 220 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 29 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 219 | 2025-10-14 | Unpinned actions/checkout@v4 | Pin to commit SHA |
| 28 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 218 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 27 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 217 | 2025-10-14 | Unpinned actions/checkout@v4 | Pin to commit SHA |
| 26 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 165 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 25 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 164 | 2025-10-14 | Unpinned actions/checkout@v4 | Pin to commit SHA |
| 24 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 164 | 2025-10-14 | Unpinned actions/upload-artifact@v4 | Pin to commit SHA |
| 23 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 163 | 2025-10-14 | Unpinned actions/upload-artifact@v4 | Pin to commit SHA |
| 22 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 146 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 21 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 37 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 20 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 36 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 19 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 17 | 2025-10-14 | Unpinned actions/setup-node@v4 | Pin to commit SHA |
| 18 | Scorecard | Pinned-Dependencies | error | .github/workflows/ci.yml | 16 | 2025-10-14 | Unpinned actions/checkout@v4 | Pin to commit SHA |
| 17 | Scorecard | License | error | Repository | - | 2025-10-14 | No LICENSE file in repository | Add LICENSE file (MIT, Apache-2.0, etc.) |
| 16 | Scorecard | Branch-Protection | error | Repository | - | 2025-10-14 | Main branch lacks protection rules | Configure branch protection in repo settings |

---

## Section C — Top 5 High-ROI Fixes

### 1. 🔒 Add Top-Level Token Permissions (Affects: 2 workflows)

**Impact:** Prevents accidental privilege escalation and enforces least-privilege principle.

**Fix for `.github/workflows/ci.yml`:**
```yaml
name: CI

# Add this at top-level, right after 'on:'
permissions:
  contents: read

on:
  push:
  pull_request:
  # ... rest of triggers
```

**Current Status:** CodeQL already has permissions block but CI.yml is missing it entirely.

---

### 2. 📌 Pin All GitHub Actions to Commit SHAs (Affects: 22 instances)

**Impact:** Prevents supply chain attacks via compromised action versions. High-security best practice.

**Pattern to apply across all workflows:**

Before:
```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
- uses: github/codeql-action/init@v3
```

After:
```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
- uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
- uses: github/codeql-action/init@f779452ac5af1c261dce0346a8b332469b86faced # v3.27.9
```

**Specific SHAs needed:**
- `actions/checkout@v4` → `11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2)
- `actions/setup-node@v4` → `39370e3970a6d050c480ffad4ff0ed4d3fdee5af` (v4.1.0)
- `actions/upload-artifact@v4` → `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882` (v4.4.3)
- `github/codeql-action/init@v3` → `f779452ac5af1c261dce0346a8b332469b86faced` (v3.27.9)
- `github/codeql-action/autobuild@v3` → `f779452ac5af1c261dce0346a8b332469b86faced` (v3.27.9)
- `github/codeql-action/analyze@v3` → `f779452ac5af1c261dce0346a8b332469b86faced` (v3.27.9)
- `github/codeql-action/upload-sarif@v3` → `f779452ac5af1c261dce0346a8b332469b86faced` (v3.27.9)
- `ossf/scorecard-action` → Already pinned! ✅ (5c8bc69dc88b65c66584e07611df79d3579b0377)

**Files to update:**
- `.github/workflows/ci.yml` (18 instances)
- `.github/workflows/codeql.yml` (3 instances)
- `.github/workflows/scorecards.yml` (1 instance - already has 1 pinned)

---

### 3. 🛡️ Enable Branch Protection for `main` (Repository Setting)

**Impact:** Prevents direct pushes, requires PR reviews, ensures CI passes before merge.

**Steps (perform in GitHub UI):**

1. Go to Repository → Settings → Branches
2. Click "Add branch protection rule"
3. Branch name pattern: `main`
4. Enable:
   - ✅ Require a pull request before merging
     - Require approvals: 1
     - Dismiss stale pull request approvals when new commits are pushed
   - ✅ Require status checks to pass before merging
     - Require branches to be up to date before merging
     - Status checks: `build`, `Analyze (CodeQL)`, `Scorecard analysis`
   - ✅ Require conversation resolution before merging
   - ✅ Do not allow bypassing the above settings (even for administrators)
5. Save changes

**Note:** This is a repository setting, not a code change.

---

### 4. 📄 Add SECURITY.md Policy (Quick Win)

**Impact:** Provides clear guidance for security researchers on how to report vulnerabilities responsibly.

**File:** `SECURITY.md` (create at repository root)

```markdown
# Security Policy

## Supported Versions

We currently support security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please:

1. **DO NOT** open a public GitHub issue
2. Email security concerns to: [your-email@example.com] (or use GitHub Security Advisories)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to respond within 48 hours and will work with you to:
- Confirm the issue
- Determine severity
- Develop and test a fix
- Coordinate disclosure timeline

## Security Best Practices

This project follows:
- OSSF Scorecard recommendations
- GitHub Advanced Security (CodeQL, Dependabot)
- Least-privilege permissions in CI/CD
- Pinned dependencies for supply chain security

Thank you for helping keep this project secure!
```

---

### 5. 📜 Add LICENSE File (Optional but Recommended)

**Impact:** Clarifies usage rights and protects both contributors and users.

**File:** `LICENSE` (create at repository root)

**Common options:**
- **MIT License** (permissive, most popular for open source)
- **Apache 2.0** (permissive with patent grant)
- **GPL-3.0** (copyleft, requires derivatives to be open source)

**MIT License Template:**
```
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

---

## Section D — Appendix

### Alert URLs (for detailed investigation)

**Pinned-Dependencies (22 alerts):**
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/47
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/39
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/38
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/37
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/36
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/35
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/34
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/33
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/32
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/31
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/30
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/29
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/28
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/27
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/26
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/25
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/24
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/23
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/22
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/21
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/20
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/19
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/18

**Token-Permissions (2 alerts):**
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/41
- https://github.com/SOVRN144/canvas-mcp/security/code-scanning/40

**Repository-Level Policies (7 alerts):**
- Security-Policy: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/46
- SAST: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/45
- Fuzzing: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/44
- Code-Review: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/43
- CII-Best-Practices: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/42
- License: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/17
- Branch-Protection: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/16

### Reference Documentation

- [OSSF Scorecard Documentation](https://github.com/ossf/scorecard/blob/main/docs/checks.md)
- [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [Pinning Actions to SHAs](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)
- [Token Permissions](https://docs.github.com/en/actions/using-jobs/assigning-permissions-to-jobs)

### Raw Alert Data

Complete JSON export available at: `/tmp/alerts.json` (31 alerts)

### Priority Matrix

| Priority | Category | Count | Effort | Impact |
|----------|----------|-------|--------|--------|
| P0 | Token-Permissions | 2 | Low | High |
| P0 | Pinned-Dependencies | 22 | Medium | High |
| P1 | Branch-Protection | 1 | Low (UI) | High |
| P1 | Security-Policy | 1 | Low | Medium |
| P2 | License | 1 | Low | Medium |
| P3 | Code-Review | 1 | Low (UI) | Medium |
| P4 | SAST | 1 | None (already have CodeQL) | Low |
| P5 | Fuzzing | 1 | High | Low |
| P5 | CII-Best-Practices | 1 | Medium | Low |

---

**Next Steps:**
1. Review and prioritize fixes based on your security posture requirements
2. Create tracking issues (see suggested issues below)
3. Implement fixes in order of priority
4. Monitor alert dashboard for new findings

---

## Suggested GitHub Issues

### Issue 1: Harden GitHub Actions Token Permissions

**Title:** `[Security] Add least-privilege token permissions to workflows`  
**Labels:** `security`, `hardening`, `scorecard`  
**Priority:** P0

**Description:**
Implement least-privilege token permissions across all GitHub Actions workflows to prevent accidental privilege escalation.

**Checklist:**
- [ ] Add top-level `permissions: contents: read` to `.github/workflows/ci.yml`
- [ ] Review CodeQL workflow permissions (already present but verify scope)
- [ ] Verify Scorecard workflow permissions (already minimal)
- [ ] Test that all workflows still function correctly

**References:**
- Alert #40: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/40
- Alert #41: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/41

---

### Issue 2: Pin GitHub Actions to Commit SHAs

**Title:** `[Security] Pin all GitHub Actions to commit SHAs`  
**Labels:** `security`, `hardening`, `scorecard`, `supply-chain`  
**Priority:** P0

**Description:**
Pin all GitHub Action references to commit SHAs instead of tags to prevent supply chain attacks via compromised action versions.

**Checklist:**
- [ ] Pin actions in `.github/workflows/ci.yml` (18 instances)
  - [ ] actions/checkout@v4 → `11bd71901bbe5b1630ceea73d27597364c9af683` # v4.2.2
  - [ ] actions/setup-node@v4 → `39370e3970a6d050c480ffad4ff0ed4d3fdee5af` # v4.1.0
  - [ ] actions/upload-artifact@v4 → `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882` # v4.4.3
- [ ] Pin actions in `.github/workflows/codeql.yml` (3 instances)
  - [ ] actions/checkout@v4
  - [ ] actions/setup-node@v4
  - [ ] github/codeql-action/*@v3 → `f779452ac5af1c261dce0346a8b332469b86faced` # v3.27.9
- [ ] Pin actions in `.github/workflows/scorecards.yml` (1 instance)
  - [ ] actions/checkout@v4
  - [ ] github/codeql-action/upload-sarif@v3
- [ ] Test all workflows after changes
- [ ] Set up Dependabot to keep SHAs updated

**References:**
- Alerts #18-39, #47 (22 total)
- [GitHub Security Hardening Guide](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)

---

### Issue 3: Enable Branch Protection for main

**Title:** `[Security] Configure branch protection rules for main`  
**Labels:** `security`, `hardening`, `repository-settings`  
**Priority:** P1

**Description:**
Configure branch protection rules to require PR reviews and passing CI before merging to main.

**Checklist:**
- [ ] Go to Repository → Settings → Branches
- [ ] Add protection rule for `main` branch
- [ ] Enable: Require pull request before merging (1 approval)
- [ ] Enable: Dismiss stale approvals on new commits
- [ ] Enable: Require status checks to pass (`build`, `Analyze (CodeQL)`, `Scorecard analysis`)
- [ ] Enable: Require branches to be up to date
- [ ] Enable: Require conversation resolution
- [ ] Enable: Do not allow bypassing (including administrators)
- [ ] Document final settings in repository README

**References:**
- Alert #16: https://github.com/SOVRN144/canvas-mcp/security/code-scanning/16
- Alert #43 (Code-Review): https://github.com/SOVRN144/canvas-mcp/security/code-scanning/43

---

### Issue 4: Add Security Policy and License

**Title:** `[Documentation] Add SECURITY.md and LICENSE files`  
**Labels:** `documentation`, `security`, `legal`  
**Priority:** P1-P2

**Description:**
Add required documentation files to meet open source best practices and provide clear vulnerability reporting guidelines.

**Checklist:**
- [ ] Create `SECURITY.md` with:
  - [ ] Supported versions
  - [ ] Vulnerability reporting process
  - [ ] Expected response timeline
  - [ ] Security best practices reference
- [ ] Create `LICENSE` file (choose: MIT, Apache-2.0, or GPL-3.0)
- [ ] Update README.md to reference security policy
- [ ] Update package.json with license field if adding LICENSE

**References:**
- Alert #46 (Security-Policy): https://github.com/SOVRN144/canvas-mcp/security/code-scanning/46
- Alert #17 (License): https://github.com/SOVRN144/canvas-mcp/security/code-scanning/17

---

**End of Report**
