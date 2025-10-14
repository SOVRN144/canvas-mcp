# Contributing to Canvas MCP

Thank you for your interest in contributing to Canvas MCP!

## Code Review Policy

All changes to the `main` branch require review and approval:

- **Required**: At least 1 approving review from a project maintainer
- **Branch Protection**: GitHub branch protection rules enforce this requirement
- **CI Validation**: All pull requests must pass CI checks before merging:
  - Build (`npm run build`)
  - Type checking (`npm run typecheck`)
  - Linting (`npm run lint`)
  - Tests (`npm run test:coverage`)
  - Security audit (`npm run audit:ci`)

### Security-Sensitive Changes

For changes involving:
- Authentication or authorization
- Data validation or sanitization
- File handling or uploads
- API endpoint modifications
- Workflow permissions or secrets

Please:
1. Tag `@SOVRN144` for review
2. Reference any relevant security guidelines in SECURITY.md
3. Ensure CodeQL analysis passes with no new alerts

## Development Setup

### Prerequisites

- Node.js >= 20.10.0
- npm (comes with Node.js)

### Getting Started

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Development Workflow

### Running Tests

```bash
npm test
```

Run tests with coverage:
```bash
npm test -- --coverage
```

### Type Checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

Auto-fix linting issues:
```bash
npm run lint -- --fix
```

### Formatting

```bash
npm run format
```

### Building

```bash
npm run build
```

## Before Submitting a PR

1. Ensure all tests pass: `npm test`
2. Ensure type checking passes: `npm run typecheck`
3. Ensure linting passes: `npm run lint`
4. Format your code: `npm run format`

## Code Style

- We use ESLint and Prettier for code quality and formatting
- TypeScript strict mode is enabled
- Follow the existing code style in the project

## Questions?

Feel free to open an issue for any questions or concerns.
