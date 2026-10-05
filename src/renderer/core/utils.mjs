const TEXT_EXTENSIONS = new Set([
  'xhtml', 'html', 'htm', 'xml', 'opf', 'ncx', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md',
]);

const MIME_TYPES = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  opf: 'application/oebps-package+xml', ncx: 'application/x-dtbncx+xml', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4',
  webm: 'video/webm', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection', vtt: 'text/vtt',
  smil: 'application/smil+xml', pls: 'application/pls+xml', xhtml11: 'application/xhtml+xml',
  epub: 'application/epub+zip',
};

export function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function normalizePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

export function dirname(filePath) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

export function basename(filePath) {
  const normalized = normalizePath(filePath);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function extension(filePath) {
  const name = basename(filePath);
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLowerCase();
}

export function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function resolveHref(baseFile, href) {
  if (!href) return { path: '', hash: '', query: '', external: false };
  const value = String(href).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    return { path: value, hash: '', query: '', external: true };
  }
  const hashIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  let splitAt = value.length;
  if (hashIndex >= 0) splitAt = Math.min(splitAt, hashIndex);
  if (queryIndex >= 0) splitAt = Math.min(splitAt, queryIndex);
  const rawPath = value.slice(0, splitAt);
  const hash = hashIndex >= 0 ? value.slice(hashIndex + 1).split('?')[0] : '';
  const query = queryIndex >= 0 ? value.slice(queryIndex + 1).split('#')[0] : '';
  const baseDir = dirname(baseFile);
  const resolved = rawPath ? normalizePath(joinPath(baseDir, safeDecode(rawPath))) : normalizePath(baseFile);
  return { path: resolved, hash: safeDecode(hash), query, external: false };
}

export function relativeHref(fromFile, toFile, hash = '') {
  const from = dirname(fromFile).split('/').filter(Boolean);
  const to = normalizePath(toFile).split('/').filter(Boolean);
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const prefix = from.map(() => '..');
  const result = [...prefix, ...to].join('/') || basename(toFile);
  return hash ? `${result}#${encodeURIComponent(hash)}` : result;
}

export function isTextPath(filePath) {
  return TEXT_EXTENSIONS.has(extension(filePath));
}

export function isHtmlPath(filePath) {
  return ['xhtml', 'html', 'htm'].includes(extension(filePath));
}

export function isCssPath(filePath) {
  return extension(filePath) === 'css';
}

export function isXmlPath(filePath) {
  return ['xhtml', 'html', 'htm', 'xml', 'opf', 'ncx', 'svg', 'smil'].includes(extension(filePath));
}

export function mimeForPath(filePath) {
  return MIME_TYPES[extension(filePath)] || 'application/octet-stream';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeXml(value) {
  return escapeHtml(value);
}

export function attr(element, name, fallback = '') {
  if (!element) return fallback;
  if (element.hasAttribute?.(name)) return element.getAttribute(name);
  const match = [...element.attributes || []].find((item) => item.localName === name || item.name.endsWith(`:${name}`));
  return match?.value ?? fallback;
}

export function elementChildren(element) {
  return [...(element?.children || [])];
}

export function descendants(root, predicate = () => true) {
  return [...(root?.querySelectorAll?.('*') || [])].filter(predicate);
}

export function buildHeadingHierarchy(headings = []) {
  const roots = [];
  const stack = [];
  for (const source of headings) {
    const level = Math.max(1, Math.min(6, Number(source.level) || 1));
    const node = { ...source, level, children: [] };
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    if (stack.length) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export function textOf(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

export function parseXml(source, mimeType = 'application/xml') {
  const document = new DOMParser().parseFromString(String(source), mimeType);
  const parserError = document.querySelector('parsererror');
  if (parserError) {
    const error = new Error(parserError.textContent.trim().replace(/\s+/g, ' '));
    error.name = 'XMLParseError';
    throw error;
  }
  return document;
}

export function tryParseXml(source, mimeType = 'application/xml') {
  try { return { document: parseXml(source, mimeType), error: null }; }
  catch (error) { return { document: null, error }; }
}

export function serializeXml(documentOrNode) {
  return new XMLSerializer()
    .serializeToString(documentOrNode)
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, '');
}

export function firstChildByLocalName(root, localName) {
  return [...(root?.children || [])].find((child) => child.localName === localName) || null;
}

export function childrenByLocalName(root, localName) {
  return [...(root?.children || [])].filter((child) => child.localName === localName);
}

export function descendantByLocalName(root, localName) {
  return [...(root?.getElementsByTagName?.('*') || [])].find((child) => child.localName === localName) || null;
}

export function decodeBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(data.subarray(3));
  }
  if (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(data.subarray(2));
  }
  if (data.length >= 2 && data[0] === 0xFE && data[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(data.subarray(2));
  }
  let initial = new TextDecoder('utf-8').decode(data.slice(0, Math.min(data.length, 512)));
  const match = initial.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
  if (match) {
    try { return new TextDecoder(match[1]).decode(data); } catch { /* fall through */ }
  }
  return new TextDecoder('utf-8').decode(data);
}

export function encodeText(value) {
  return new TextEncoder().encode(String(value));
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return doc.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

export function stripTags(value) {
  return htmlToText(value);
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    const value = char === 'x' ? random : (random & 0x3 | 0x8);
    return value.toString(16);
  });
}

export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLocaleLowerCase() || 'item';
}

export function uniqueId(existing, base = 'id') {
  const set = new Set(existing);
  if (!set.has(base)) return base;
  let index = 2;
  while (set.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

const MARKUP_INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br', 'button', 'cite', 'code', 'data',
  'del', 'dfn', 'em', 'font', 'i', 'image', 'img', 'input', 'ins', 'kbd', 'label', 'map',
  'mark', 'meter', 'nobr', 'object', 'output', 'picture', 'progress', 'q', 'ruby', 'rp', 'rt',
  's', 'samp', 'select', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'textarea', 'time',
  'tt', 'u', 'var', 'wbr',
]);
const MARKUP_VOID_TAGS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img',
  'input', 'keygen', 'link', 'meta', 'param', 'source', 'spacer', 'track', 'wbr',
]);
const MARKUP_PRESERVE_TAGS = new Set(['code', 'pre', 'script', 'style', 'textarea']);
const MARKUP_TEXT_HOLDER_TAGS = new Set([
  'address', 'caption', 'dd', 'div', 'dt', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'legend', 'li', 'option', 'p', 'td', 'th', 'title',
]);

function markupTagName(token, closing = false) {
  const pattern = closing ? /^<\s*\/\s*([^\s/>]+)/ : /^<\s*([^\s/>]+)/;
  return token.match(pattern)?.[1]?.toLocaleLowerCase() || '';
}

function findMarkupTokenEnd(source, start) {
  let quote = '';
  let brackets = 0;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === '>' && brackets === 0) return index + 1;
  }
  return source.length;
}

function appendMarkupText(parent, value) {
  if (!value) return;
  const previous = parent.children.at(-1);
  if (previous?.type === 'text') previous.value += value;
  else parent.children.push({ type: 'text', value });
}

function parseMarkup(source) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) {
      appendMarkupText(stack.at(-1), source.slice(cursor));
      break;
    }
    appendMarkupText(stack.at(-1), source.slice(cursor, start));

    let end;
    if (source.startsWith('<!--', start)) {
      const close = source.indexOf('-->', start + 4);
      end = close < 0 ? source.length : close + 3;
    } else if (source.startsWith('<![CDATA[', start)) {
      const close = source.indexOf(']]>', start + 9);
      end = close < 0 ? source.length : close + 3;
    } else if (source.startsWith('<?', start)) {
      const close = source.indexOf('?>', start + 2);
      end = close < 0 ? source.length : close + 2;
    } else if (source.startsWith('<!', start) || /^<\/?[A-Za-z][\w:.-]*/.test(source.slice(start))) {
      end = findMarkupTokenEnd(source, start);
    } else {
      appendMarkupText(stack.at(-1), '<');
      cursor = start + 1;
      continue;
    }

    const token = source.slice(start, end);
    if (/^<\//.test(token)) {
      const name = markupTagName(token, true);
      let matchingIndex = -1;
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].name === name) {
          matchingIndex = index;
          break;
        }
      }
      if (matchingIndex < 0) {
        appendMarkupText(stack.at(-1), token);
      } else {
        stack[matchingIndex].close = token;
        stack.length = matchingIndex;
      }
    } else if (/^<[A-Za-z][\w:.-]*/.test(token)) {
      const name = markupTagName(token);
      const node = { type: 'element', name, open: token, close: '', children: [] };
      stack.at(-1).children.push(node);
      const selfClosing = /\/\s*>$/.test(token);
      if (!selfClosing && !MARKUP_VOID_TAGS.has(name)) stack.push(node);
    } else {
      stack.at(-1).children.push({ type: 'raw', value: token });
    }
    cursor = end;
  }
  return root;
}

function normalizeMarkupInlineText(value) {
  return String(value).replace(/[\t\n\f\r ]+/g, ' ');
}

function appendMarkupInline(current, value) {
  if (!value) return current;
  let next = String(value);
  if (/\s$/.test(current) && /^\s/.test(next)) next = next.replace(/^\s+/, '');
  return current + next;
}

function hasMarkupBlockChild(node) {
  return (node.children || []).some((child) => {
    if (child.type !== 'element') return false;
    return !MARKUP_INLINE_TAGS.has(child.name) || hasMarkupBlockChild(child);
  });
}

function isInlineMarkupNode(node) {
  return node.type === 'element'
    && MARKUP_INLINE_TAGS.has(node.name)
    && !hasMarkupBlockChild(node);
}

function renderMarkupRaw(node) {
  if (node.type === 'text' || node.type === 'raw') return node.value;
  if (node.type === 'element') {
    return node.open + (node.children || []).map(renderMarkupRaw).join('') + node.close;
  }
  return (node.children || []).map(renderMarkupRaw).join('');
}

function renderMarkupInlineChildren(children) {
  let result = '';
  for (const child of children || []) {
    if (child.type === 'text') result = appendMarkupInline(result, normalizeMarkupInlineText(child.value));
    else if (child.type === 'raw') result = appendMarkupInline(result, child.value);
    else if (isInlineMarkupNode(child)) result = appendMarkupInline(result, renderMarkupInlineNode(child));
    else result = appendMarkupInline(result, renderMarkupRaw(child));
  }
  return result;
}

function renderMarkupInlineNode(node) {
  if (MARKUP_VOID_TAGS.has(node.name) || /\/\s*>$/.test(node.open)) return node.open;
  if (MARKUP_PRESERVE_TAGS.has(node.name)) return node.open + renderMarkupRaw({ type: 'root', children: node.children }) + node.close;
  return node.open + renderMarkupInlineChildren(node.children) + node.close;
}

function markupIndent(level) {
  return '  '.repeat(Math.max(0, level));
}

function renderMarkupBlockChildren(children, level) {
  const lines = [];
  let inline = '';
  const flushInline = () => {
    const value = inline.trim();
    if (value) lines.push(`${markupIndent(level)}${value}`);
    inline = '';
  };

  for (const child of children || []) {
    if (child.type === 'text') {
      const value = normalizeMarkupInlineText(child.value);
      if (value.trim()) inline = appendMarkupInline(inline, value);
      continue;
    }
    if (isInlineMarkupNode(child)) {
      inline = appendMarkupInline(inline, renderMarkupInlineNode(child));
      continue;
    }
    flushInline();
    if (child.type === 'raw') {
      if (child.value.trim()) lines.push(`${markupIndent(level)}${child.value.trim()}`);
    } else if (child.type === 'element') {
      lines.push(renderMarkupBlockNode(child, level));
    }
  }
  flushInline();
  return lines.filter((line) => line !== '').join('\n');
}

function renderMarkupBlockNode(node, level) {
  const prefix = markupIndent(level);
  if (MARKUP_VOID_TAGS.has(node.name) || /\/\s*>$/.test(node.open)) return `${prefix}${node.open}`;
  if (MARKUP_PRESERVE_TAGS.has(node.name)) {
    return `${prefix}${node.open}${renderMarkupRaw({ type: 'root', children: node.children })}${node.close}`;
  }

  const hasBlockChild = hasMarkupBlockChild(node);
  const inline = renderMarkupInlineChildren(node.children);
  if (!hasBlockChild && MARKUP_TEXT_HOLDER_TAGS.has(node.name)) {
    return `${prefix}${node.open}${inline}${node.close}`;
  }
  if (!hasBlockChild && inline.trim()) {
    return `${prefix}${node.open}\n${markupIndent(level + 1)}${inline.trim()}\n${prefix}${node.close}`;
  }

  const contents = renderMarkupBlockChildren(node.children, level + 1);
  if (!contents) return `${prefix}${node.open}${node.close}`;
  return `${prefix}${node.open}\n${contents}\n${prefix}${node.close}`;
}

export function formatMarkup(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return text;
  const formatted = renderMarkupBlockChildren(parseMarkup(text).children, 0).trim();
  return text.endsWith('\n') ? `${formatted}\n` : formatted;
}

export function isMinifiedMarkup(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n').trim();
  if (!text || text.length < 32 || formatMarkup(text) === text) return false;
  const meaningfulLines = text.split('\n').filter((line) => line.trim());
  const tagCount = (text.match(/<\/?[A-Za-z][^>]*>/g) || []).length;
  if (tagCount < 3) return false;
  if (meaningfulLines.length <= 2) return true;
  const blockTagsPerLine = meaningfulLines.map((line) => (
    (line.match(/<\/?[A-Za-z][^>]*>/g) || [])
      .filter((token) => {
        const name = markupTagName(token, /^<\//.test(token));
        return !MARKUP_INLINE_TAGS.has(name) && !MARKUP_VOID_TAGS.has(name);
      }).length
  ));
  if (blockTagsPerLine.some((count) => count >= 3)) return true;
  if (meaningfulLines.some((line, index) => line.length > 80 && blockTagsPerLine[index] >= 2)) return true;
  const longestLine = Math.max(...meaningfulLines.map((line) => line.length));
  return longestLine > 240 && tagCount / meaningfulLines.length >= 4;
}

export function formatCss(source) {
  let depth = 0;
  const output = [];
  const text = String(source || '').replace(/\s*([{};,])\s*/g, '$1').replace(/\s*:\s*/g, ': ');
  let buffer = '';
  const push = () => {
    if (buffer.trim()) output.push('  '.repeat(depth) + buffer.trim());
    buffer = '';
  };
  for (const char of text) {
    if (char === '{') {
      buffer = buffer.trim();
      output.push('  '.repeat(depth) + buffer + ' {');
      buffer = '';
      depth += 1;
    } else if (char === '}') {
      push();
      depth = Math.max(0, depth - 1);
      output.push('  '.repeat(depth) + '}');
    } else if (char === ';') {
      buffer += char;
      push();
    } else if (char === ',') {
      buffer += ',';
    } else {
      buffer += char;
    }
  }
  push();
  return output.join('\n');
}

export function cleanInlineStyles(root) {
  const allowed = new Set(['font-style', 'font-weight', 'text-decoration', 'text-align', 'text-indent']);
  for (const element of descendants(root)) {
    if (!element.hasAttribute('style')) continue;
    const declarations = element.getAttribute('style').split(';').map((item) => item.trim()).filter(Boolean);
    const kept = declarations.filter((item) => allowed.has(item.split(':')[0]?.trim().toLowerCase()));
    if (kept.length) element.setAttribute('style', kept.join('; '));
    else element.removeAttribute('style');
  }
  return root;
}

export function smartPunctuation(text) {
  return String(text)
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/\.\.\./g, '…')
    .replace(/(^|[\s([{])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{])'/g, '$1‘')
    .replace(/'/g, '’');
}

export function rewriteCssUrls(css, cssPath, resolveResource) {
  const source = String(css || '');
  return source
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
      const url = value.trim();
      if (/^(data:|blob:|https?:|#)/i.test(url)) return match;
      const resolved = resolveHref(cssPath, url);
      if (resolved.external) return match;
      const replacement = resolveResource(resolved.path);
      return `url("${replacement}")`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, value) => {
      if (/^(data:|blob:|https?:)/i.test(value)) return match;
      const resolved = resolveHref(cssPath, value);
      const replacement = resolveResource(resolved.path);
      return `@import ${quote}${replacement}${quote}`;
    });
}

export function quoteCss(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function downloadText(name, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function debounce(callback, delay = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

export function isProbablyBinaryPath(filePath) {
  return !isTextPath(filePath);
}
