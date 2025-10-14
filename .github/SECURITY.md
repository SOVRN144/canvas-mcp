# Security Policy

## Supported Versions
We support the latest `main` branch and the most recent tagged release.

## Reporting a Vulnerability
Please report security issues via **GitHub Security Advisories** (preferred) or email **security@sovrn144.dev**.
We aim to acknowledge within **48 hours** and provide a remediation plan or patch ETA within **7 days**.

## Scope
This policy covers the code and workflows in this repository. Do not include secrets or production data in reports.

## Automated Security Scanning

This repository uses automated security scanning tools to maintain code quality and security:

### CodeQL Static Analysis (SAST)
- **Schedule**: Runs weekly (Mondays 03:15 UTC) + on all PRs
- **Current Status**: ✅ 0 alerts
- **Coverage**: SQL injection, XSS, command injection, path traversal, insecure cryptography
- **Workflow**: `.github/workflows/codeql.yml`

### OpenSSF Scorecard
- **Schedule**: Runs weekly (Saturdays 00:36 UTC) + on all PRs
- **Current Status**: Monitored via Security tab
- **Checks**: Pinned dependencies, token permissions, SAST integration, code review, maintenance indicators
- **Workflow**: `.github/workflows/scorecards.yml`
- **Key Mitigations**:
  - All GitHub Actions pinned to immutable SHAs
  - Minimal GITHUB_TOKEN permissions (top-level `contents: read`)
  - Dependencies pinned via `package-lock.json` + deterministic `npm ci`
  - SARIF results uploaded only on non-PR events

### Dependency Security
- **npm audit**: Runs on every CI build (`npm run audit:ci`)
- **Dependabot**: Weekly automated dependency updates with security focus
- **Lock File**: `package-lock.json` ensures deterministic, pinned dependency resolution
