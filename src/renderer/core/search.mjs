import { isTextPath, resolveHref } from './utils.mjs';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchRegExp(query, options = {}) {
  if (!query) return null;
  let pattern = options.regex ? String(query) : escapeRegExp(query);
  if (options.wholeWord) pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(pattern, options.caseSensitive ? 'gmu' : 'gimu');
  } catch (error) {
    error.name = 'SearchPatternError';
    throw error;
  }
}

export function findMatches(text, query, options = {}) {
  const regex = buildSearchRegExp(query, options);
  if (!regex) return [];
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[0] === '') {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      groups: match.slice(1),
    });
  }
  return matches;
}

export function expandReplacement(template, match, options = {}) {
  if (!options.regex) return String(template ?? '');
  return String(template ?? '').replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, key) => {
    if (key === '$') return '$';
    if (key === '&') return match.text;
    if (key === '`') return '';
    if (key === "'") return '';
    if (/^\d+$/.test(key)) return match.groups[Number(key) - 1] ?? '';
    return '';
  });
}

export function replaceMatches(text, query, replacement, options = {}) {
  const matches = findMatches(text, query, options);
  if (!matches.length) return { text, count: 0 };
  let cursor = 0;
  let result = '';
  for (const match of matches) {
    result += text.slice(cursor, match.start);
    result += expandReplacement(replacement, match, options);
    cursor = match.end;
  }
  result += text.slice(cursor);
  return { text: result, count: matches.length };
}

export function replaceMatchesAtOffsets(text, matches, replacement, options = {}) {
  const sorted = [...matches]
    .filter((match) => Number.isInteger(match.start) && Number.isInteger(match.end))
    .sort((a, b) => b.start - a.start);
  let result = text;
  let cursor = text.length;
  let count = 0;
  for (const match of sorted) {
    if (match.start < 0 || match.end > text.length || match.end < match.start) continue;
    if (match.end > cursor) continue;
    result = result.slice(0, match.start)
      + expandReplacement(replacement, match, options)
      + result.slice(match.end);
    cursor = match.start;
    count += 1;
  }
  return { text: result, count };
}

export function searchBook(book, query, options = {}, scopePaths = null) {
  const results = [];
  const allowed = scopePaths ? new Set(scopePaths) : null;
  for (const [filePath, entry] of book.entries) {
    if (!entry.text || !isTextPath(filePath)) continue;
    if (allowed && !allowed.has(filePath)) continue;
    let matches;
    try { matches = findMatches(entry.text, query, options); }
    catch (error) { return { error, results: [] }; }
    if (!matches.length) continue;
    const lines = entry.text.split(/\n/);
    const fileMatches = matches.map((match) => {
      let offset = 0;
      let line = 1;
      let lineStart = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const end = offset + lines[index].length + 1;
        if (match.start < end) {
          line = index + 1;
          lineStart = offset;
          break;
        }
        offset = end;
      }
      const excerpt = lines[line - 1]?.trim().slice(0, 240) || '';
      return { ...match, line, column: match.start - lineStart + 1, excerpt };
    });
    results.push({ path: filePath, matches: fileMatches });
  }
  return { results, error: null };
}

export function findInBookByHref(book, href, basePath = '') {
  const resolved = resolveHref(basePath, href);
  if (!resolved.path) return null;
  const entry = book.getResource(resolved.path);
  if (!entry?.text) return null;
  const index = resolved.hash ? entry.text.indexOf(`id="${resolved.hash}"`) : 0;
  return { path: resolved.path, index: Math.max(0, index) };
}
