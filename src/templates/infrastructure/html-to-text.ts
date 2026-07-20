// Pure, dependency-free HTML→text fallback used when a template has no
// explicit `bodyText` (see `TemplateRenderer`'s contract). Deliberately
// simple: strip tags, turn block-ish boundaries into newlines, decode the
// handful of entities Handlebars' own escaping produces, collapse whitespace.
// Not a general HTML parser — good enough for a plain-text mirror of a
// merge-field email body, not for arbitrary third-party HTML.

const SCRIPT_OR_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_BOUNDARY_RE = /<\/?(?:br|p|div|li|tr|h[1-6])\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Derives a plain-text rendering from a rendered HTML string. */
export function htmlToText(html: string): string {
  const withoutScripts = html.replace(SCRIPT_OR_STYLE_RE, '');
  const withBreaks = withoutScripts.replace(BLOCK_BOUNDARY_RE, '\n');
  const withoutTags = withBreaks.replace(TAG_RE, '');
  const decoded = decodeEntities(withoutTags);

  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
