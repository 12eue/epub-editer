import {
  attr,
  basename,
  buildHeadingHierarchy,
  childrenByLocalName,
  decodeBytes,
  descendants,
  dirname,
  elementChildren,
  encodeText,
  escapeXml,
  extension,
  firstChildByLocalName,
  formatBytes,
  formatMarkup,
  isHtmlPath,
  isTextPath,
  isXmlPath,
  joinPath,
  mimeForPath,
  normalizePath,
  parseXml,
  relativeHref,
  resolveHref,
  safeDecode,
  serializeXml,
  slugify,
  textOf,
  uniqueId,
  uuid,
} from './utils.mjs';

const OPF_NS = 'http://www.idpf.org/2007/opf';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/';
const EPUBCFI_NS = 'http://www.idpf.org/2007/opf';
const DEFAULT_CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function createElement(document, namespace, qualifiedName, text = null) {
  const element = document.createElementNS(namespace, qualifiedName);
  if (text !== null) element.textContent = text;
  return element;
}

function getMetadataElement(document) {
  return firstChildByLocalName(document.documentElement, 'metadata');
}

function getManifestElement(document) {
  return firstChildByLocalName(document.documentElement, 'manifest');
}

function getSpineElement(document) {
  return firstChildByLocalName(document.documentElement, 'spine');
}

function getGuideElement(document) {
  return firstChildByLocalName(document.documentElement, 'guide');
}

function directChildByLocalName(root, localName) {
  return [...(root?.children || [])].find((child) => child.localName === localName) || null;
}

function xmlDeclaration(version = '1.0') {
  return `<?xml version="${version}" encoding="utf-8"?>\n`;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return encodeText(String(value ?? ''));
}

function cloneTextEntries(entries) {
  return JSON.parse(JSON.stringify(entries || []));
}

function tocEntryFromHref(document, link, basePath) {
  const hrefValue = link.getAttribute('href') || '';
  const resolved = resolveHref(basePath, hrefValue);
  return {
    id: link.getAttribute('id') || '',
    label: link.textContent.replace(/\s+/g, ' ').trim() || '未命名',
    path: resolved.external ? '' : resolved.path,
    hash: resolved.hash,
    external: resolved.external,
    href: hrefValue,
    children: [],
  };
}

function parseNavList(document, listElement, basePath) {
  const entries = [];
  for (const li of elementChildren(listElement).filter((node) => node.localName === 'li')) {
    const link = directChildByLocalName(li, 'a');
    const nested = directChildByLocalName(li, 'ol');
    if (link) {
      const entry = tocEntryFromHref(document, link, basePath);
      entry.children = nested ? parseNavList(document, nested, basePath) : [];
      entries.push(entry);
    }
  }
  return entries;
}

function parseNavPoint(document, navPoint, basePath) {
  const labelNode = directChildByLocalName(navPoint, 'navLabel');
  const contentNode = directChildByLocalName(navPoint, 'content');
  const label = labelNode ? textOf(directChildByLocalName(labelNode, 'text')) : '';
  const hrefValue = contentNode?.getAttribute('src') || '';
  const resolved = resolveHref(basePath, hrefValue);
  const children = elementChildren(navPoint)
    .filter((node) => node.localName === 'navPoint')
    .map((node) => parseNavPoint(document, node, basePath));
  return {
    id: navPoint.getAttribute('id') || '',
    label: label || '未命名',
    path: resolved.external ? '' : resolved.path,
    hash: resolved.hash,
    external: resolved.external,
    href: hrefValue,
    children,
  };
}

function walkToc(entries, callback, parent = null, depth = 0) {
  for (const entry of entries) {
    callback(entry, parent, depth);
    walkToc(entry.children || [], callback, entry, depth + 1);
  }
}

function flattenToc(entries) {
  const result = [];
  walkToc(entries, (entry) => result.push(entry));
  return result;
}

function removeTocPaths(entries, paths) {
  return entries.filter((entry) => {
    entry.children = removeTocPaths(entry.children || [], paths);
    return !entry.path || !paths.has(entry.path);
  });
}

export class EpubBook {
  constructor(path = '') {
    this.path = path;
    this.name = path ? basename(path) : '未命名.epub';
    this.dirty = false;
    this.version = '3.0';
    this.entries = new Map();
    this.opfPath = '';
    this.opfDoc = null;
    this.containerDoc = null;
    this.toc = [];
    this.tocSource = '';
    this.packageDirty = false;
    this.opfTextDirty = false;
    this.iconv = null;
  }

  static async fromArrayBuffer(buffer, sourcePath = '') {
    if (!globalThis.JSZip) throw new Error('JSZip 未加载，无法解析 EPUB。');
    const book = new EpubBook(sourcePath);
    book.zip = await globalThis.JSZip.loadAsync(buffer);
    await book.readEntries();
    await book.parseContainerAndPackage();
    for (const item of book.manifestItems()) {
      const entry = book.entries.get(item.path);
      if (entry) entry.mediaType = item.mediaType;
    }
    book.readToc();
    book.dirty = false;
    book.packageDirty = false;
    book.opfTextDirty = false;
    return book;
  }

  static async create({ version = 3, title = '未命名书籍' } = {}) {
    if (!globalThis.JSZip) throw new Error('JSZip 未加载，无法创建 EPUB。');
    const zip = new globalThis.JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', DEFAULT_CONTAINER);
    const identifier = `urn:uuid:${uuid()}`;
    const lang = 'zh-CN';
    const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol><li><a href="Text/chapter-1.xhtml">第一章</a></li></ol></nav></body>
</html>`;
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${identifier}"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap><navPoint id="navPoint-1" playOrder="1"><navLabel><text>第一章</text></navLabel><content src="Text/chapter-1.xhtml"/></navPoint></navMap>
</ncx>`;
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="BookId" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${identifier}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="Styles/base.css" media-type="text/css"/>
    <item id="chapter-1" href="Text/chapter-1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="chapter-1"/></spine>
  <guide><reference type="text" title="正文" href="Text/chapter-1.xhtml"/></guide>
</package>`;
    const chapter = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>第一章</title><link rel="stylesheet" type="text/css" href="../Styles/base.css"/></head>
<body><section epub:type="chapter" xmlns:epub="http://www.idpf.org/2007/ops"><h1>第一章</h1><p>开始撰写你的电子书。</p></section></body>
</html>`;
    const css = `html { font-family: serif; line-height: 1.65; }\nbody { margin: 5%; }\nh1 { line-height: 1.2; }\n`;
    zip.file('OEBPS/content.opf', opf);
    zip.file('OEBPS/nav.xhtml', formatMarkup(nav));
    zip.file('OEBPS/toc.ncx', ncx);
    zip.file('OEBPS/Styles/base.css', css);
    zip.file('OEBPS/Text/chapter-1.xhtml', formatMarkup(chapter));
    const buffer = await zip.generateAsync({ type: 'arraybuffer', mimeType: 'application/epub+zip' });
    return EpubBook.fromArrayBuffer(buffer);
  }

  async readEntries() {
    const files = Object.values(this.zip.files).filter((file) => !file.dir);
    for (const file of files) {
      const entryPath = normalizePath(file.name);
      if (entryPath !== file.name.replace(/\\/g, '/')) continue;
      const bytes = await file.async('uint8array');
      const text = isTextPath(entryPath) ? decodeBytes(bytes) : null;
      this.entries.set(entryPath, {
        path: entryPath,
        bytes,
        text,
        mediaType: mimeForPath(entryPath),
        compression: file.options.compression === 'STORE' ? 'STORE' : 'DEFLATE',
      });
    }
  }

  async parseContainerAndPackage() {
    const containerEntry = this.entries.get('META-INF/container.xml');
    if (!containerEntry?.text) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml。');
    this.containerDoc = parseXml(containerEntry.text);
    const rootfile = descendants(this.containerDoc.documentElement).find((node) => node.localName === 'rootfile');
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) throw new Error('container.xml 中没有 rootfile。');
    this.opfPath = normalizePath(opfPath);
    const opfEntry = this.entries.get(this.opfPath);
    if (!opfEntry?.text) throw new Error(`找不到 OPF 文件：${this.opfPath}`);
    this.opfDoc = parseXml(opfEntry.text);
    if (this.opfDoc.documentElement.localName !== 'package') throw new Error('OPF 根元素不是 package。');
    this.version = this.opfDoc.documentElement.getAttribute('version') || '3.0';
    this.ensurePackageSections();
  }

  ensurePackageSections() {
    const root = this.opfDoc.documentElement;
    if (!root.getAttribute('xmlns:opf')) root.setAttribute('xmlns:opf', OPF_NS);
    let metadata = getMetadataElement(this.opfDoc);
    let manifest = getManifestElement(this.opfDoc);
    let spine = getSpineElement(this.opfDoc);
    if (!metadata) {
      metadata = createElement(this.opfDoc, OPF_NS, 'metadata');
      metadata.setAttribute('xmlns:dc', DC_NS);
      root.insertBefore(metadata, root.firstChild);
    }
    if (!manifest) {
      manifest = createElement(this.opfDoc, OPF_NS, 'manifest');
      root.append(manifest);
    }
    if (!spine) {
      spine = createElement(this.opfDoc, OPF_NS, 'spine');
      root.append(spine);
    }
  }

  refreshPackageFromText() {
    if (!this.opfTextDirty) return false;
    const entry = this.entries.get(this.opfPath);
    if (!entry?.text) return false;
    this.opfDoc = parseXml(entry.text);
    this.version = this.opfDoc.documentElement.getAttribute('version') || this.version;
    this.ensurePackageSections();
    this.opfTextDirty = false;
    this.packageDirty = true;
    return true;
  }

  manifestItems() {
    this.refreshPackageFromText();
    const manifest = getManifestElement(this.opfDoc);
    if (!manifest) return [];
    return elementChildren(manifest)
      .filter((item) => item.localName === 'item')
      .map((item) => {
        const href = item.getAttribute('href') || '';
        const resolved = resolveHref(this.opfPath, href);
        return {
          node: item,
          id: item.getAttribute('id') || '',
          href,
          path: resolved.path,
          mediaType: item.getAttribute('media-type') || mimeForPath(resolved.path),
          properties: item.getAttribute('properties') || '',
          fallback: item.getAttribute('fallback') || '',
          mediaOverlay: item.getAttribute('media-overlay') || '',
        };
      });
  }

  spineItems() {
    const spine = getSpineElement(this.opfDoc);
    if (!spine) return [];
    return elementChildren(spine)
      .filter((item) => item.localName === 'itemref')
      .map((item, index) => ({
        node: item,
        index,
        idref: item.getAttribute('idref') || '',
        linear: item.getAttribute('linear') !== 'no',
        properties: item.getAttribute('properties') || '',
      }));
  }

  spineResources() {
    const map = new Map(this.manifestItems().map((item) => [item.id, item]));
    return this.spineItems().map((spine) => ({ ...spine, item: map.get(spine.idref) })).filter((item) => item.item);
  }

  getResource(filePath) {
    return this.entries.get(normalizePath(filePath)) || null;
  }

  getText(filePath) {
    return this.getResource(filePath)?.text ?? '';
  }

  getBytes(filePath) {
    return this.getResource(filePath)?.bytes || new Uint8Array();
  }

  getManifestItem(id) {
    return this.manifestItems().find((item) => item.id === id) || null;
  }

  getManifestByPath(filePath) {
    const path = normalizePath(filePath);
    return this.manifestItems().find((item) => item.path === path) || null;
  }

  setText(filePath, text) {
    const normalized = normalizePath(filePath);
    const existing = this.entries.get(normalized);
    const bytes = encodeText(text);
    this.entries.set(normalized, {
      path: normalized,
      text: String(text),
      bytes,
      mediaType: existing?.mediaType || mimeForPath(normalized),
      compression: existing?.compression || 'DEFLATE',
    });
    if (normalized === this.opfPath) this.opfTextDirty = true;
    this.dirty = true;
  }

  addBinary(filePath, bytes, mediaType = '') {
    const normalized = normalizePath(filePath);
    this.entries.set(normalized, {
      path: normalized,
      bytes: toBytes(bytes),
      text: isTextPath(normalized) ? decodeBytes(bytes) : null,
      mediaType: mediaType || mimeForPath(normalized),
      compression: 'DEFLATE',
    });
    this.dirty = true;
  }

  removeResource(filePath) {
    const normalized = normalizePath(filePath);
    const item = this.getManifestByPath(normalized);
    if (item?.node?.parentNode) item.node.parentNode.removeChild(item.node);
    const spine = getSpineElement(this.opfDoc);
    if (item && spine) {
      for (const child of [...elementChildren(spine)]) {
        if (child.localName === 'itemref' && child.getAttribute('idref') === item.id) spine.removeChild(child);
      }
    }
    const guide = getGuideElement(this.opfDoc);
    if (guide) {
      for (const reference of [...elementChildren(guide)]) {
        const resolved = resolveHref(this.opfPath, reference.getAttribute('href') || '');
        if (resolved.path === normalized) guide.removeChild(reference);
      }
    }
    this.entries.delete(normalized);
    this.toc = removeTocPaths(this.toc, new Set([normalized]));
    this.packageDirty = true;
    this.dirty = true;
  }

  addManifestItem({ id, href, path: filePath, mediaType, properties = '', spine = false, toc = false }) {
    this.ensurePackageSections();
    const manifest = getManifestElement(this.opfDoc);
    const normalized = normalizePath(filePath);
    const resolvedHref = href || relativeHref(this.opfPath, normalized);
    let item = this.manifestItems().find((candidate) => candidate.id === id || candidate.path === normalized)?.node;
    if (!item) {
      item = createElement(this.opfDoc, OPF_NS, 'item');
      manifest.append(item);
    }
    const existingIds = this.manifestItems().map((entry) => entry.id).filter((value) => value && value !== item.getAttribute('id'));
    const finalId = id || uniqueId(existingIds, `item-${slugify(basename(normalized))}`);
    item.setAttribute('id', finalId);
    item.setAttribute('href', resolvedHref);
    item.setAttribute('media-type', mediaType || mimeForPath(normalized));
    if (properties) item.setAttribute('properties', properties);
    if (spine) {
      const spineNode = getSpineElement(this.opfDoc);
      const exists = elementChildren(spineNode).some((child) => child.localName === 'itemref' && child.getAttribute('idref') === finalId);
      if (!exists) {
        const ref = createElement(this.opfDoc, OPF_NS, 'itemref');
        ref.setAttribute('idref', finalId);
        spineNode.append(ref);
      }
    }
    if (toc && this.version.startsWith('2')) getSpineElement(this.opfDoc).setAttribute('toc', finalId);
    this.packageDirty = true;
    this.dirty = true;
    return this.getManifestItem(finalId);
  }

  createResource({ type = 'xhtml', targetPath, title = '新章节', content, spine = false } = {}) {
    const extensionByType = { xhtml: 'xhtml', html: 'html', css: 'css', js: 'js', svg: 'svg', xml: 'xml', txt: 'txt' };
    const ext = extensionByType[type] || 'xhtml';
    const baseDir = type === 'css' ? 'Styles' : type === 'js' ? 'Scripts' : type === 'svg' ? 'Images' : 'Text';
    let filePath = normalizePath(targetPath || joinPath(dirname(this.opfPath), baseDir, `untitled.${ext}`));
    let index = 2;
    while (this.entries.has(filePath)) {
      filePath = normalizePath(targetPath || joinPath(dirname(this.opfPath), baseDir, `untitled-${index}.${ext}`));
      index += 1;
    }
    const initial = content ?? this.makeDefaultResource(type, title, filePath);
    const bytes = encodeText(initial);
    this.entries.set(filePath, {
      path: filePath,
      text: initial,
      bytes,
      mediaType: mimeForPath(filePath),
      compression: 'DEFLATE',
    });
    const existingIds = this.manifestItems().map((item) => item.id);
    const id = uniqueId(existingIds, type === 'xhtml' ? `chapter-${slugify(title)}` : `item-${slugify(basename(filePath))}`);
    this.addManifestItem({ id, path: filePath, mediaType: mimeForPath(filePath), spine });
    this.dirty = true;
    return { path: filePath, id };
  }

  makeDefaultResource(type, title, filePath) {
    const lang = this.getMetadataValue('language') || 'zh-CN';
    if (type === 'css') return `/* ${title} */\nbody {\n  line-height: 1.6;\n}\n`;
    if (type === 'js') return `'use strict';\n// ${title}\n`;
    if (type === 'svg') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="#f4f1ea"/><text x="300" y="200" text-anchor="middle" font-size="28">${escapeXml(title)}</text></svg>`;
    if (type === 'xml') return `<?xml version="1.0" encoding="utf-8"?>\n<root/>`;
    if (type === 'txt') return `${title}\n`;
    const baseCssPath = joinPath(dirname(this.opfPath), 'Styles', 'base.css');
    const cssHref = this.entries.has(baseCssPath) ? relativeHref(filePath, baseCssPath) : '';
    const stylesheet = cssHref ? `<link rel="stylesheet" type="text/css" href="${escapeXml(cssHref)}"/>` : '';
    const source = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>${stylesheet}</head>
<body><section epub:type="chapter"><h1>${escapeXml(title)}</h1><p></p></section></body>
</html>`;
    return formatMarkup(source);
  }

  renameResource(oldPath, newPath) {
    const oldName = normalizePath(oldPath);
    const newName = normalizePath(newPath);
    if (oldName === newName) return;
    if (!this.entries.has(oldName)) throw new Error(`资源不存在：${oldName}`);
    if (this.entries.has(newName)) throw new Error(`目标路径已存在：${newName}`);
    const entry = this.entries.get(oldName);
    this.entries.delete(oldName);
    this.entries.set(newName, { ...entry, path: newName, mediaType: mimeForPath(newName) || entry.mediaType });
    const manifestItem = this.getManifestByPath(newName);
    const oldManifest = manifestItem || this.manifestItems().find((item) => item.path === oldName);
    if (!oldManifest) {
      this.entries.delete(newName);
      this.entries.set(oldName, entry);
      throw new Error('资源尚未加入 OPF manifest。');
    }
    oldManifest.node.setAttribute('href', relativeHref(this.opfPath, newName));
    oldManifest.node.setAttribute('media-type', mimeForPath(newName));
    if (oldName === this.opfPath) this.opfPath = newName;
    for (const item of this.manifestItems()) {
      const resource = this.entries.get(item.path);
      if (!resource?.text || item.path === newName) continue;
      resource.text = this.rewriteReferences(resource.text, item.path, oldName, newName);
      resource.bytes = encodeText(resource.text);
    }
    const guide = getGuideElement(this.opfDoc);
    if (guide) {
      for (const ref of elementChildren(guide)) {
        const hrefValue = ref.getAttribute('href') || '';
        const resolved = resolveHref(this.opfPath, hrefValue);
        if (resolved.path === oldName) ref.setAttribute('href', relativeHref(this.opfPath, newName, resolved.hash));
      }
    }
    walkToc(this.toc, (entry) => {
      if (entry.path === oldName) entry.path = newName;
    });
    this.packageDirty = true;
    this.dirty = true;
  }

  rewriteReferences(text, sourcePath, oldPath, newPath) {
    if (isHtmlPath(sourcePath) || isXmlPath(sourcePath)) {
      const doc = parseXml(text, isHtmlPath(sourcePath) ? 'application/xhtml+xml' : 'application/xml');
      const attributes = ['href', 'src', 'poster', 'xlink:href'];
      for (const element of descendants(doc.documentElement)) {
        for (const name of attributes) {
          const value = attr(element, name.split(':').pop(), '');
          if (!value || /^(https?:|mailto:|data:|blob:|#)/i.test(value)) continue;
          const resolved = resolveHref(sourcePath, value);
          if (resolved.path === oldPath) {
            element.setAttribute(name, relativeHref(sourcePath, newPath, resolved.hash));
          }
        }
      }
      return xmlDeclaration() + serializeXml(doc);
    }
    if (extension(sourcePath) === 'css') {
      return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
        const resolved = resolveHref(sourcePath, value);
        if (resolved.path !== oldPath) return match;
        return `url(${quote || '"'}${relativeHref(sourcePath, newPath)}${quote || '"'})`;
      }).replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, value) => {
        const resolved = resolveHref(sourcePath, value);
        if (resolved.path !== oldPath) return match;
        return `@import ${quote}${relativeHref(sourcePath, newPath)}${quote}`;
      });
    }
    return text;
  }

  getMetadataElements() {
    this.refreshPackageFromText();
    const metadata = getMetadataElement(this.opfDoc);
    return metadata ? elementChildren(metadata) : [];
  }

  getMetadataValue(localName, index = 0) {
    const matches = this.getMetadataElements().filter((item) => item.localName === localName);
    return matches[index]?.textContent?.trim() || '';
  }

  getMetadata() {
    const all = this.getMetadataElements().map((node) => ({
      localName: node.localName,
      value: node.textContent.trim(),
      id: node.getAttribute('id') || '',
      property: node.getAttribute('property') || '',
      refines: node.getAttribute('refines') || '',
      scheme: node.getAttribute('scheme') || '',
      role: node.getAttribute('opf:role') || node.getAttribute('role') || '',
      fileAs: node.getAttribute('opf:file-as') || node.getAttribute('file-as') || '',
    }));
    return {
      title: this.getMetadataValue('title'),
      creators: all.filter((item) => item.localName === 'creator').map((item) => ({ name: item.value, role: item.role, fileAs: item.fileAs, id: item.id })),
      language: this.getMetadataValue('language') || 'zh-CN',
      identifier: this.getMetadataValue('identifier'),
      publisher: this.getMetadataValue('publisher'),
      date: this.getMetadataValue('date'),
      description: this.getMetadataValue('description'),
      rights: this.getMetadataValue('rights'),
      subjects: all.filter((item) => item.localName === 'subject').map((item) => item.value),
      modified: all.find((item) => item.localName === 'meta' && item.property === 'dcterms:modified')?.value || '',
      all,
    };
  }

  setMetadata(patch = {}) {
    this.refreshPackageFromText();
    this.opfTextDirty = false;
    this.ensurePackageSections();
    const metadata = getMetadataElement(this.opfDoc);
    const replaceSingle = (localName, value) => {
      let node = elementChildren(metadata).find((item) => item.localName === localName);
      if (!value) {
        if (node?.parentNode) node.parentNode.removeChild(node);
        return;
      }
      if (!node) {
        node = createElement(this.opfDoc, DC_NS, `dc:${localName}`);
        metadata.append(node);
      }
      node.textContent = value;
    };

    replaceSingle('title', patch.title);
    replaceSingle('language', patch.language);
    replaceSingle('publisher', patch.publisher);
    replaceSingle('date', patch.date);
    replaceSingle('description', patch.description);
    replaceSingle('rights', patch.rights);
    if (patch.identifier) {
      let identifierNode = elementChildren(metadata).find((item) => item.localName === 'identifier');
      if (!identifierNode) {
        identifierNode = createElement(this.opfDoc, DC_NS, 'dc:identifier');
        metadata.prepend(identifierNode);
      }
      if (!identifierNode.id) {
        const id = this.opfDoc.documentElement.getAttribute('unique-identifier') || 'BookId';
        identifierNode.setAttribute('id', id);
      }
      identifierNode.textContent = patch.identifier;
    }
    if (patch.creators) {
      for (const node of elementChildren(metadata).filter((item) => item.localName === 'creator')) metadata.removeChild(node);
      for (const creator of patch.creators) {
        const value = typeof creator === 'string' ? creator : creator.name;
        if (!value) continue;
        const node = createElement(this.opfDoc, DC_NS, 'dc:creator', value);
        if (typeof creator !== 'string' && creator.role) node.setAttribute('opf:role', creator.role);
        if (typeof creator !== 'string' && creator.fileAs) node.setAttribute('opf:file-as', creator.fileAs);
        metadata.append(node);
      }
    }
    if (patch.subjects) {
      for (const node of elementChildren(metadata).filter((item) => item.localName === 'subject')) metadata.removeChild(node);
      for (const subject of patch.subjects.filter(Boolean)) {
        metadata.append(createElement(this.opfDoc, DC_NS, 'dc:subject', subject));
      }
    }
    if (!this.version.startsWith('2')) {
      let modified = elementChildren(metadata).find((item) => item.localName === 'meta' && item.getAttribute('property') === 'dcterms:modified');
      if (!modified) {
        modified = createElement(this.opfDoc, OPF_NS, 'meta');
        modified.setAttribute('property', 'dcterms:modified');
        metadata.append(modified);
      }
      modified.textContent = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    this.packageDirty = true;
    this.dirty = true;
  }

  readToc() {
    const items = this.manifestItems();
    const navItem = items.find((item) => item.properties.split(/\s+/).includes('nav'));
    const ncxId = getSpineElement(this.opfDoc)?.getAttribute('toc');
    const ncxItem = items.find((item) => item.id === ncxId) || items.find((item) => extension(item.path) === 'ncx');
    if (navItem) {
      try {
        const doc = parseXml(this.getText(navItem.path), 'application/xhtml+xml');
        const nav = descendants(doc.documentElement).find((node) => node.localName === 'nav' && (node.getAttribute('epub:type') || attr(node, 'type')).includes('toc'))
          || descendants(doc.documentElement).find((node) => node.localName === 'nav');
        const list = nav ? descendants(nav).find((node) => node.localName === 'ol') : null;
        this.toc = list ? parseNavList(doc, list, navItem.path) : [];
        this.tocSource = navItem.path;
        if (this.toc.length) return;
      } catch { /* fall back to NCX */ }
    }
    if (ncxItem) {
      try {
        const doc = parseXml(this.getText(ncxItem.path), 'application/xml');
        const navMap = descendants(doc.documentElement).find((node) => node.localName === 'navMap');
        this.toc = navMap ? elementChildren(navMap).filter((node) => node.localName === 'navPoint').map((node) => parseNavPoint(doc, node, ncxItem.path)) : [];
        this.tocSource = ncxItem.path;
      } catch {
        this.toc = [];
        this.tocSource = '';
      }
    }
  }

  generateTocFromHeadings() {
    const headings = [];
    const excludedClasses = new Set(['sigil_not_in_toc', 'epub-studio-not-in-toc']);
    for (const { item } of this.spineResources()) {
      if (!isHtmlPath(item.path) || item.properties.split(/\s+/).includes('nav')) continue;
      const source = this.getText(item.path);
      if (!source) continue;
      let document;
      try {
        document = parseXml(source, 'application/xhtml+xml');
      } catch {
        continue;
      }
      const nodes = descendants(document.documentElement).filter((node) => /^h[1-6]$/.test(node.localName));
      if (!nodes.length) continue;
      const existingIds = new Set(descendants(document.documentElement).map((node) => node.getAttribute?.('id')).filter(Boolean));
      let idsAdded = false;
      nodes.forEach((node, nodeIndex) => {
        const classes = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        if (classes.some((name) => excludedClasses.has(name))) return;
        const label = (node.getAttribute('title') || textOf(node)).replace(/\s+/g, ' ').trim();
        if (!label) return;
        let hash = '';
        if (nodeIndex > 0) {
          let id = node.getAttribute('id');
          if (!id) {
            id = uniqueId([...existingIds], `sigil_toc_id_${slugify(label)}`);
            node.setAttribute('id', id);
            existingIds.add(id);
            idsAdded = true;
          }
          hash = id;
        }
        headings.push({
          id: `toc-${slugify(basename(item.path))}-${headings.length + 1}`,
          label,
          path: item.path,
          hash,
          external: false,
          level: Number(node.localName.slice(1)),
          children: [],
        });
      });
      if (idsAdded) this.setText(item.path, `${xmlDeclaration()}\n${serializeXml(document)}`);
    }
    if (!headings.length) return { changed: false, count: 0 };
    const nextToc = buildHeadingHierarchy(headings);
    const changed = JSON.stringify(nextToc) !== JSON.stringify(this.toc);
    this.toc = nextToc;
    if (this.version.startsWith('3')) {
      const navItem = this.manifestItems().find((item) => item.properties.split(/\s+/).includes('nav'));
      this.tocSource = navItem?.path || '';
    }
    this.packageDirty = true;
    this.dirty = true;
    return { changed, count: headings.length };
  }

  getGuide() {
    const guide = getGuideElement(this.opfDoc);
    return guide ? elementChildren(guide).map((node) => ({
      type: node.getAttribute('type') || '',
      title: node.getAttribute('title') || '',
      href: node.getAttribute('href') || '',
      path: resolveHref(this.opfPath, node.getAttribute('href') || '').path,
    })) : [];
  }

  getCoverPath() {
    const items = this.manifestItems();
    const propertyCover = items.find((item) => item.properties.split(/\s+/).includes('cover-image'));
    if (propertyCover) return propertyCover.path;
    const metadataCover = this.getMetadataElements().find((node) => node.localName === 'meta' && node.getAttribute('name') === 'cover');
    const coverId = metadataCover?.getAttribute('content');
    if (coverId) return items.find((item) => item.id === coverId)?.path || '';
    return items.find((item) => item.mediaType.startsWith('image/'))?.path || '';
  }

  getResourceLabel(filePath) {
    const item = this.getManifestByPath(filePath);
    return item?.id || basename(filePath);
  }

  get info() {
    const metadata = this.getMetadata();
    const htmlCount = this.manifestItems().filter((item) => isHtmlPath(item.path)).length;
    const imageCount = this.manifestItems().filter((item) => item.mediaType.startsWith('image/')).length;
    const cssCount = this.manifestItems().filter((item) => item.mediaType === 'text/css').length;
    const bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes.byteLength, 0);
    return {
      title: metadata.title || basename(this.name).replace(/\.epub$/i, ''),
      authors: metadata.creators.map((creator) => creator.name).join(', ') || '未知作者',
      language: metadata.language,
      version: this.version,
      htmlCount,
      imageCount,
      cssCount,
      resourceCount: this.entries.size,
      size: bytes,
      sizeLabel: formatBytes(bytes),
    };
  }

  writeNavDocument() {
    const navPath = this.tocSource && extension(this.tocSource) === 'xhtml'
      ? this.tocSource
      : joinPath(dirname(this.opfPath), 'nav.xhtml');
    const lang = this.getMetadataValue('language') || 'zh-CN';
    const document = globalThis.document.implementation.createDocument(XHTML_NS, 'html', null);
    const html = document.documentElement;
    html.setAttribute('xmlns', XHTML_NS);
    html.setAttribute('xmlns:epub', 'http://www.idpf.org/2007/ops');
    html.setAttribute('lang', lang);
    html.setAttribute('xml:lang', lang);
    const head = createElement(document, XHTML_NS, 'head');
    const meta = createElement(document, XHTML_NS, 'meta');
    meta.setAttribute('charset', 'utf-8');
    const title = createElement(document, XHTML_NS, 'title', this.getMetadataValue('title') || '目录');
    head.append(meta, title);
    const body = createElement(document, XHTML_NS, 'body');
    const nav = createElement(document, XHTML_NS, 'nav');
    nav.setAttribute('epub:type', 'toc');
    nav.setAttribute('id', 'toc');
    nav.append(createElement(document, XHTML_NS, 'h1', '目录'));
    nav.append(this.buildNavList(document, this.toc, navPath));
    body.append(nav);
    html.append(head, body);
    this.setText(navPath, `${xmlDeclaration()}\n${serializeXml(document)}`);
    this.addManifestItem({ id: 'nav', path: navPath, mediaType: 'application/xhtml+xml', properties: 'nav' });
  }

  buildNavList(document, entries, fromPath) {
    const list = createElement(document, XHTML_NS, 'ol');
    for (const entry of entries) {
      const item = createElement(document, XHTML_NS, 'li');
      const link = createElement(document, XHTML_NS, 'a', entry.label || '未命名');
      if (entry.id) link.setAttribute('id', entry.id);
      if (entry.external) link.setAttribute('href', entry.href || entry.path);
      else link.setAttribute('href', relativeHref(fromPath, entry.path, entry.hash));
      item.append(link);
      if (entry.children?.length) item.append(this.buildNavList(document, entry.children, fromPath));
      list.append(item);
    }
    return list;
  }

  writeNcxDocument() {
    const spine = getSpineElement(this.opfDoc);
    const items = this.manifestItems();
    const ncxId = spine.getAttribute('toc');
    const existing = items.find((item) => item.id === ncxId) || items.find((item) => extension(item.path) === 'ncx');
    const ncxPath = existing?.path || joinPath(dirname(this.opfPath), 'toc.ncx');
    const ncxDocument = document.implementation.createDocument(NCX_NS, 'ncx', null);
    const ncx = ncxDocument.documentElement;
    ncx.setAttribute('version', '2005-1');
    const head = createElement(ncxDocument, NCX_NS, 'head');
    const uidMeta = createElement(ncxDocument, NCX_NS, 'meta');
    uidMeta.setAttribute('name', 'dtb:uid');
    uidMeta.setAttribute('content', this.getMetadataValue('identifier') || uuid());
    head.append(uidMeta);
    const docTitle = createElement(ncxDocument, NCX_NS, 'docTitle');
    docTitle.append(createElement(ncxDocument, NCX_NS, 'text', this.getMetadataValue('title') || '未命名书籍'));
    const navMap = createElement(ncxDocument, NCX_NS, 'navMap');
    let playOrder = 1;
    const appendPoints = (parent, entries) => {
      for (const entry of entries) {
        const point = createElement(ncxDocument, NCX_NS, 'navPoint');
        point.setAttribute('id', entry.id || `navPoint-${playOrder}`);
        point.setAttribute('playOrder', String(playOrder++));
        const navLabel = createElement(ncxDocument, NCX_NS, 'navLabel');
        navLabel.append(createElement(ncxDocument, NCX_NS, 'text', entry.label || '未命名'));
        const content = createElement(ncxDocument, NCX_NS, 'content');
        content.setAttribute('src', entry.external ? (entry.href || entry.path) : relativeHref(ncxPath, entry.path, entry.hash));
        point.append(navLabel, content);
        if (entry.children?.length) appendPoints(point, entry.children);
        parent.append(point);
      }
    };
    appendPoints(navMap, this.toc);
    ncx.append(head, docTitle, navMap);
    this.setText(ncxPath, `${xmlDeclaration()}\n${serializeXml(ncxDocument)}`);
    const item = this.addManifestItem({ id: existing?.id || 'ncx', path: ncxPath, mediaType: 'application/x-dtbncx+xml' });
    spine.setAttribute('toc', item.id);
  }

  syncToc() {
    if (this.version.startsWith('3') && !this.tocSource?.endsWith('.ncx')) this.writeNavDocument();
    const hasNcx = this.manifestItems().some((item) => extension(item.path) === 'ncx');
    if (this.version.startsWith('2') || hasNcx || this.tocSource.endsWith('.ncx')) this.writeNcxDocument();
    if (this.version.startsWith('3')) {
      const nav = this.manifestItems().find((item) => item.properties.split(/\s+/).includes('nav'));
      if (nav) this.tocSource = nav.path;
    }
  }

  serializeOpf() {
    if (!this.version.startsWith('2')) {
      const metadata = getMetadataElement(this.opfDoc);
      let modified = elementChildren(metadata).find((node) => node.localName === 'meta' && node.getAttribute('property') === 'dcterms:modified');
      if (!modified) {
        modified = createElement(this.opfDoc, OPF_NS, 'meta');
        modified.setAttribute('property', 'dcterms:modified');
        metadata.append(modified);
      }
      modified.textContent = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    return `${xmlDeclaration()}\n${serializeXml(this.opfDoc)}`;
  }

  async save() {
    this.refreshPackageFromText();
    this.syncToc();
    if (this.packageDirty || !this.entries.get(this.opfPath)?.text) {
      const serialized = encodeText(this.serializeOpf());
      const existing = this.entries.get(this.opfPath);
      this.entries.set(this.opfPath, {
        path: this.opfPath,
        text: decodeBytes(serialized),
        bytes: serialized,
        mediaType: existing?.mediaType || 'application/oebps-package+xml',
        compression: existing?.compression || 'DEFLATE',
      });
    }
    this.packageDirty = false;
    this.opfTextDirty = false;
    const zip = new globalThis.JSZip();
    const mimetype = this.entries.get('mimetype');
    zip.file('mimetype', mimetype?.bytes || encodeText('application/epub+zip'), { compression: 'STORE' });
    const paths = [...this.entries.keys()].filter((item) => item !== 'mimetype').sort((a, b) => {
      if (a === 'META-INF/container.xml') return -1;
      if (b === 'META-INF/container.xml') return 1;
      return a.localeCompare(b);
    });
    for (const filePath of paths) {
      const entry = this.entries.get(filePath);
      zip.file(filePath, entry.bytes, { compression: entry.compression || 'DEFLATE' });
    }
    const data = await zip.generateAsync({
      type: 'uint8array',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX',
    });
    this.dirty = false;
    return data;
  }

  validate() {
    const results = [];
    const add = (severity, code, message, path = '', line = 0) => results.push({ severity, code, message, path, line });
    const mimetype = this.entries.get('mimetype');
    if (!mimetype) add('error', 'missing-mimetype', '缺少 mimetype 文件。', 'mimetype');
    else if (decodeBytes(mimetype.bytes).trim() !== 'application/epub+zip') add('error', 'bad-mimetype', 'mimetype 内容必须为 application/epub+zip。', 'mimetype');
    if (!this.entries.has('META-INF/container.xml')) add('error', 'missing-container', '缺少 META-INF/container.xml。', 'META-INF/container.xml');
    if (!this.opfPath) add('error', 'missing-opf', '无法确定 OPF 包文件。');
    const manifest = this.manifestItems();
    const manifestIds = new Set();
    for (const item of manifest) {
      if (!item.id) add('error', 'manifest-id', 'Manifest item 缺少 id。', this.opfPath);
      else if (manifestIds.has(item.id)) add('error', 'duplicate-manifest-id', `重复的 manifest id：${item.id}`, this.opfPath);
      manifestIds.add(item.id);
      if (!this.entries.has(item.path)) add('error', 'missing-resource', `Manifest 指向不存在的资源：${item.href}`, this.opfPath);
    }
    for (const spine of this.spineItems()) {
      if (!manifestIds.has(spine.idref)) add('error', 'missing-spine-item', `Spine 引用了不存在的 id：${spine.idref}`, this.opfPath);
    }
    const nav = manifest.find((item) => item.properties.split(/\s+/).includes('nav'));
    if (this.version.startsWith('3') && !nav) add('warning', 'missing-nav', 'EPUB 3 建议提供 properties="nav" 的导航文档。', this.opfPath);
    if (this.version.startsWith('2') && !manifest.some((item) => extension(item.path) === 'ncx')) add('warning', 'missing-ncx', 'EPUB 2 应提供 NCX 目录。', this.opfPath);
    for (const [filePath, entry] of this.entries) {
      if (!entry.text || !isXmlPath(filePath)) continue;
      try {
        const doc = parseXml(entry.text, isHtmlPath(filePath) ? 'application/xhtml+xml' : 'application/xml');
        const ids = new Map();
        for (const element of descendants(doc.documentElement)) {
          const id = element.getAttribute?.('id');
          if (id) {
            if (ids.has(id)) add('error', 'duplicate-id', `重复 id "${id}"（首次于 ${ids.get(id)} 标签）。`, filePath);
            else ids.set(id, element.localName);
          }
          if (['script', 'object', 'iframe', 'embed'].includes(element.localName)) add('warning', 'active-content', `包含可能执行或嵌入内容的 <${element.localName}>。`, filePath);
          if (element.localName === 'img' && !element.hasAttribute('alt')) add('info', 'missing-alt', '图片缺少 alt 属性。', filePath);
          for (const name of ['href', 'src', 'poster']) {
            const value = element.getAttribute?.(name);
            if (!value || /^(https?:|mailto:|data:|blob:|#|javascript:)/i.test(value)) continue;
            const resolved = resolveHref(filePath, value);
            if (resolved.path && !this.entries.has(resolved.path)) add('error', 'broken-reference', `${name} 指向不存在的文件：${value}`, filePath);
          }
        }
      } catch (error) {
        add('error', 'invalid-xml', error.message, filePath);
      }
    }
    if (this.entries.has('META-INF/encryption.xml')) add('warning', 'encrypted', '书籍包含 encryption.xml，受 DRM 保护的资源可能无法编辑或保存。', 'META-INF/encryption.xml');
    if (!results.length) add('info', 'valid', '未发现可报告的问题。', this.opfPath);
    return results;
  }

  checkLinks() {
    const results = [];
    const idsByPath = new Map();
    for (const [filePath, entry] of this.entries) {
      if (!entry.text || !isHtmlPath(filePath)) continue;
      try {
        const doc = parseXml(entry.text, 'application/xhtml+xml');
        idsByPath.set(filePath, new Set(descendants(doc.documentElement).map((node) => node.getAttribute?.('id')).filter(Boolean)));
      } catch { idsByPath.set(filePath, new Set()); }
    }
    for (const [filePath, entry] of this.entries) {
      if (!entry.text || !isHtmlPath(filePath)) continue;
      try {
        const doc = parseXml(entry.text, 'application/xhtml+xml');
        for (const element of descendants(doc.documentElement)) {
          for (const attribute of ['href', 'src', 'poster']) {
            const value = element.getAttribute?.(attribute);
            if (!value || /^(https?:|mailto:|data:|blob:|javascript:)/i.test(value)) continue;
            const resolved = resolveHref(filePath, value);
            if (resolved.path && !this.entries.has(resolved.path)) {
              results.push({ severity: 'error', path: filePath, message: `${attribute}="${value}"：文件不存在`, target: resolved.path });
            } else if (resolved.hash) {
              const ids = idsByPath.get(resolved.path);
              if (ids && !ids.has(resolved.hash)) results.push({ severity: 'warning', path: filePath, message: `${attribute}="${value}"：目标 ID #${resolved.hash} 不存在`, target: resolved.path });
            }
          }
        }
      } catch { /* validation reports XML errors */ }
    }
    return results;
  }

  generateReports() {
    const files = [];
    const classes = new Map();
    const styles = new Map();
    let headings = 0;
    let paragraphs = 0;
    let words = 0;
    let characters = 0;
    for (const [filePath, entry] of this.entries) {
      const size = entry.bytes.byteLength;
      const kind = entry.mediaType;
      files.push({ path: filePath, kind, size, sizeLabel: formatBytes(size) });
      if (!entry.text) continue;
      characters += entry.text.length;
      if (isHtmlPath(filePath)) {
        try {
          const doc = parseXml(entry.text, 'application/xhtml+xml');
          const elements = descendants(doc.documentElement);
          headings += elements.filter((node) => /^h[1-6]$/.test(node.localName)).length;
          paragraphs += elements.filter((node) => node.localName === 'p').length;
          words += (doc.body?.textContent || '').trim().split(/\s+/).filter(Boolean).length;
          for (const element of elements) {
            for (const name of (element.getAttribute?.('class') || '').split(/\s+/).filter(Boolean)) classes.set(name, (classes.get(name) || 0) + 1);
          }
        } catch { /* ignore malformed */ }
      }
      if (extension(filePath) === 'css') {
        for (const match of entry.text.matchAll(/([^{}]+)\{/g)) {
          const selector = match[1].trim().replace(/\s+/g, ' ');
          if (selector) styles.set(selector, (styles.get(selector) || 0) + 1);
        }
      }
    }
    return {
      files,
      classes: [...classes].sort((a, b) => b[1] - a[1]),
      styles: [...styles].sort((a, b) => b[1] - a[1]),
      totals: { headings, paragraphs, words, characters, files: files.length },
    };
  }
}

export { walkToc, flattenToc, removeTocPaths };
