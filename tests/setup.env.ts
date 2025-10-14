// Force NODE_ENV='test' for all Vitest runs to prevent error masking in raiseCanvasError.
// This ensures validation errors (e.g., "File X: content type not allowed") are visible
// in tests, regardless of the shell's NODE_ENV setting.
process.env.NODE_ENV = 'test';
