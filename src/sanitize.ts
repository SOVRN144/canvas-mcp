// src/sanitize.ts
import sanitizeHtml from 'sanitize-html';
import he from 'he';

/** Opinionated, safe default sanitizer for Canvas assignment descriptions. */
export function sanitizeHtmlSafe(input: string, opts?: Partial<sanitizeHtml.IOptions>): string {
  const base: sanitizeHtml.IOptions = {
    allowedTags: [
      'p','div','span','br','hr',
      'strong','em','b','i','u','s','code','pre','blockquote',
      'ul','ol','li',
      'h1','h2','h3','h4','h5','h6',
      'table','thead','tbody','tr','th','td',
      'a','img'
    ],
    allowedAttributes: {
      a: ['href','name','target','rel'],
      img: ['src','alt','title'],
    },
    allowedSchemes: ['http','https','mailto'],
    transformTags: {
      a: (tagName, attribs) => {
        const rel = attribs.rel?.toLowerCase() || '';
        const set = new Set(rel.split(/\s+/).filter(Boolean));
        ['noopener','noreferrer','nofollow'].forEach(x => set.add(x));
        return { tagName: 'a', attribs: { ...attribs, rel: Array.from(set).join(' ') } };
      }
    },
    allowedSchemesAppliedToAttributes: ['href','src'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    parseStyleAttributes: false
  };
  return sanitizeHtml(input || '', { ...base, ...(opts || {}) });
}

/** Lightweight HTML → text: preserves basic line breaks, decodes entities. */
export function htmlToText(input: string): string {
  if (!input) return '';
  const withBreaks = input
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '</$1>\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n');
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  const normalized = stripped
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return he.decode(normalized);
}

/** Truncate to max characters with ellipsis and flag. */
export function truncate(input: string, maxChars: number) {
  const text = input || '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { text, truncated: false };
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return { text: `${slice}…`, truncated: true };
}
