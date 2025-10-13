# Contributing to Canvas MCP

Thank you for your interest in contributing to Canvas MCP!

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
