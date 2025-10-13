# TypeScript Strict Mode Tracking

This document tracks TypeScript strict mode issues and their resolutions.

## Current Status

✅ All strict mode issues have been addressed as of 2025-10-11.

## Strict Flags Enabled

The following strict TypeScript compiler flags are enabled in `tsconfig.json`:

- `strict: true` - Enables all strict type checking options
- `noImplicitAny: true` - Disallow implicit `any` types
- `exactOptionalPropertyTypes: true` - Differentiate between `undefined` and missing properties
- `noUncheckedIndexedAccess: true` - Add `undefined` to index signature results
- `noFallthroughCasesInSwitch: true` - Report errors for fallthrough cases in switch
- `noImplicitOverride: true` - Require explicit `override` keyword
- `noUnusedLocals: true` - Report errors on unused local variables
- `noUnusedParameters: true` - Report errors on unused parameters
- `noImplicitReturns: true` - Report error when not all code paths return a value
- `forceConsistentCasingInFileNames: true` - Ensure consistent casing in imports

## Resolved Issues

### 1. Unused Imports (noUnusedLocals)

**Issue**: Several imports were unused after code refactoring.

**Resolution**: 
- Removed genuinely unused imports (`fs`, `CanvasAssignment`, `OcrMode`, `FileAttachmentContentItem`)
- Implemented lazy loading for OCR helpers (`performOcr`, `isImageOnly`, `ocrDisabledHint`) in `src/http.ts` to avoid top-level imports when OCR is not configured or not needed

**Files affected**:
- `src/http.ts` - Lazy import of OCR helpers
- `src/ocr.ts` - Removed unused type import

### 2. Unused Parameters (noUnusedParameters)

**Issue**: Callback functions had unused parameters required by library APIs.

**Resolution**: Prefixed unused parameters with underscore (`_tagName`)

**Files affected**:
- `src/sanitize.ts` - Transform callback parameter

### 3. Type Compatibility (JSZip)

**Issue**: Buffer type not recognized as compatible with JSZip's InputFileFormat in strict mode.

**Resolution**: Cast Buffer to Uint8Array (Buffer extends Uint8Array, so this is type-safe)

**Files affected**:
- `src/files.ts` - JSZip.loadAsync() call

## Best Practices

### Lazy Imports for Optional Features

When a feature is optional or conditional (like OCR), use dynamic imports:

```typescript
// Instead of top-level import that may be unused:
// import { performOcr } from './ocr.js';

// Use lazy import when actually needed:
if (needsOcr) {
  const { performOcr } = await import('./ocr.js');
  // use performOcr...
}
```

Benefits:
- Satisfies `noUnusedLocals` without disabling the check
- Reduces initial bundle size
- Makes dependencies explicit and conditional

### Unused Parameters

When a parameter is required by an API but not used in your implementation:

```typescript
// Prefix with underscore to indicate intentionally unused
transformTags: {
  a: (_tagName, attribs) => {
    // tagName required by API but not used here
    return { tagName: 'a', attribs };
  }
}
```

## Future Considerations

If new strict mode issues arise:

1. **First choice**: Fix the issue properly by using the value or removing it
2. **Second choice**: Use lazy imports for conditional dependencies
3. **Last resort**: Add a `// @ts-expect-error` with detailed explanation for genuine edge cases

Never disable strict flags globally. They catch real bugs and improve code quality.
