import { describe, it, expect } from 'vitest';
import { truncateText, TRUNCATE_SUFFIX } from '../src/files.js';

describe('truncateText edge cases', () => {
  it('never exceeds maxChars even for very small limits', () => {
    const longText = 'This is a very long piece of text that needs to be truncated properly.';
    
    // Test edge cases around TRUNCATE_SUFFIX length
    for (let maxChars = 1; maxChars <= TRUNCATE_SUFFIX.length + 2; maxChars++) {
      const result = truncateText(longText, maxChars);
      expect(result.text.length).toBeLessThanOrEqual(maxChars);
      expect(result.truncated).toBe(true);
    }
  });

  it('handles maxChars of 1', () => {
    const result = truncateText('Hello world', 1);
    expect(result.text).toBe('H');
    expect(result.text.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('handles maxChars equal to TRUNCATE_SUFFIX length', () => {
    const result = truncateText('Hello world', TRUNCATE_SUFFIX.length);
    expect(result.text.length).toBe(TRUNCATE_SUFFIX.length);
    expect(result.truncated).toBe(true);
    // Should not contain the suffix when maxChars is too small
    expect(result.text).not.toContain('…');
  });

  it('handles normal truncation when maxChars > TRUNCATE_SUFFIX length', () => {
    const result = truncateText('Hello world', 10);
    expect(result.text.length).toBe(10);
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('…');
    expect(result.truncated).toBe(true);
  });

  it('does not truncate when text fits', () => {
    const result = truncateText('Short', 10);
    expect(result.text).toBe('Short');
    expect(result.text.length).toBe(5);
    expect(result.truncated).toBe(false);
  });
});