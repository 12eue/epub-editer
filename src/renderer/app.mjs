import { EpubBook, flattenToc, walkToc } from './core/epub.mjs';
import {
  basename,
  cleanInlineStyles,
  debounce,
  decodeBytes,
  descendants,
  dirname,
  downloadText,
  escapeHtml,
  extension,
  formatCss,
  formatMarkup,
  formatBytes,
  isCssPath,
  isHtmlPath,
  isMinifiedMarkup,
  isTextPath,
  isXmlPath,
  joinPath,
  mimeForPath,
  normalizePath,
  parseXml,
  relativeHref,
  resolveHref,
  serializeXml,
  smartPunctuation,
  textOf,
  uniqueId,
  uuid,
} from './core/utils.mjs';
import { searchBook, replaceMatches, findMatches, expandReplacement } from './core/search.mjs';
import { CodeEditor } from './ui/code-editor.mjs';
import {
  alertDialog,
  choiceDialog,
  confirmDialog,
  promptDialog,
  reportHtml,
  showContextMenu,
  showModal,
} from './ui/dialogs.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

window.addEventListener('error', (event) => console.error('Unhandled renderer error:', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => console.error('Unhandled renderer rejection:', event.reason));

const state = {
  book: null,
  settings: {
    theme: 'system', fontFamily: 'Georgia, "Songti SC", serif', fontSize: 18,
    readingWidth: 760, lineWrapping: true, spellcheck: true, spellcheckLanguages: ['en-US'], showRecentFiles: true, recentFiles: [],
  },
  appInfo: {},
  activePath: '',
  openPaths: [],
  mode: 'preview',
  leftPanel: 'files',
  rightPanel: 'toc',
  leftVisible: true,
  rightVisible: true,
  leftWidth: 282,
  rightWidth: 326,
  fileFilter: '',
  selectedElement: null,
  tocSelectedIndex: '',
  bookmarks: [],
  clips: [],
  validation: null,
  validationTitle: '',
  report: null,
  find: null,
  findFocusPending: false,
  pendingReveal: null,
  assetUrls: new Map(),
  reverseAssetUrls: new Map(),
  zoom: 1,
  lastStatus: '就绪',
};

let editor = null;
let activeFrame = null;
let frameKind = '';
let frameInputTimer = null;
let searchDebounce = null;
let readProgressTimer = null;
let pendingRevealTimer = null;
let pendingViewLocation = null;
let frameViewAnchor = null;
const resourceViewLocations = new Map();

const elements = {
  toolbar: $('#app-toolbar'),
  formatToolbar: $('#format-toolbar'),
  workspace: $('#workspace'),
  welcome: $('#welcome'),
  leftSidebar: $('#left-sidebar'),
  rightSidebar: $('#right-sidebar'),
  leftResizer: $('#left-sidebar-resizer'),
  rightResizer: $('#right-sidebar-resizer'),
  leftContent: $('#left-sidebar-content'),
  rightContent: $('#right-sidebar-content'),
  toggleLeftSidebar: $('#toggle-left-sidebar'),
  toggleRightSidebar: $('#toggle-right-sidebar'),
  documentHost: $('#document-host'),
  documentTabs: $('#document-tabs'),
  resourceKind: $('#resource-kind'),
  bookTitle: $('#book-title'),
  statusMessage: $('#status-message'),
  statusDirty: $('#status-dirty'),
  statusLocation: $('#status-location'),
  statusSpellcheck: $('#status-spellcheck'),
  spinePosition: $('#spine-position'),
  recentBooks: $('#recent-books'),
};

function toast(title, message = '', kind = 'info', timeout = 3600) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? `<small>${escapeHtml(message)}</small>` : ''}`;
  $('#toast-root').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 180);
  }, timeout);
}

function setStatus(message, kind = '') {
  state.lastStatus = message;
  elements.statusMessage.textContent = message;
  elements.statusMessage.dataset.kind = kind;
}

function updateDirtyStatus() {
  const dirty = Boolean(state.book?.dirty);
  elements.statusDirty.textContent = dirty ? '● 未保存' : state.book ? '已保存' : '';
  document.title = `${dirty ? '● ' : ''}${state.book ? state.book.name : 'EPUB Studio'}`;
  $('#book-title').textContent = state.book ? state.book.info.title : '阅读与编辑一体化';
}

function markDirty() {
  if (!state.book) return;
  state.book.dirty = true;
  updateDirtyStatus();
}

function errorMessage(error) {
  return error?.message || String(error);
}

async function runAction(label, callback) {
  try {
    setStatus(`${label}…`);
    const result = await callback();
    setStatus('就绪');
    return result;
  } catch (error) {
    console.error(label, error);
    setStatus(`${label}失败`, 'error');
    await alertDialog({ title: `${label}失败`, message: errorMessage(error) });
    return null;
  }
}

function applySettings() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = state.settings.theme === 'system' ? (prefersDark ? 'dark' : 'light') : state.settings.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--font-read', state.settings.fontFamily);
  elements.statusSpellcheck.textContent = state.settings.spellcheck ? `拼写：${state.settings.spellcheckLanguages.join(', ')}` : '拼写检查关闭';
  $$('.mode-switch button').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
}

function editorShortcut(event) {
  if ((!event.metaKey && !event.ctrlKey) || document.querySelector('.modal-backdrop')) return null;
  const key = event.key.toLowerCase();
  if (/^[1-6]$/.test(key) && !event.shiftKey && !event.altKey) return { command: 'heading', extra: { level: Number(key) } };
  if ((key === '0' || key === '7') && !event.shiftKey && !event.altKey) return { command: 'heading', extra: { level: 0 } };
  if (key === 'e' && !event.shiftKey && !event.altKey) return { command: 'align-center' };
  if (key === 'j' && !event.shiftKey && !event.altKey) return { command: 'align-justify' };
  if (key === 'l' && event.shiftKey && !event.altKey) return { command: 'align-left' };
  if (key === 'r' && event.shiftKey && !event.altKey) return { command: 'align-right' };
  if (key === 'b' && !event.shiftKey && !event.altKey) return { command: 'bold' };
  if (key === 'i' && !event.shiftKey && !event.altKey) return { command: 'italic' };
  if (key === 'u' && !event.shiftKey && !event.altKey) return { command: 'underline' };
  if (key === 'x' && event.altKey) return { command: 'strike' };
  return null;
}

function handleEditorShortcut(event) {
  const action = editorShortcut(event);
  if (!action || !state.book || (!activeFrame && !editor)) return false;
  event.preventDefault();
  event.stopPropagation();
  executeCommand(action.command, action.extra);
  return true;
}

function renderRecentBooks() {
  const recent = state.settings.recentFiles || [];
  if (!state.settings.showRecentFiles || !recent.length) {
    elements.recentBooks.innerHTML = '';
    return;
  }
  elements.recentBooks.innerHTML = `<span class="tree-meta">最近打开：</span>${recent.map((filePath) => `
    <span class="recent-book">
      <button class="recent-open" data-open-path="${escapeHtml(filePath)}" title="${escapeHtml(filePath)}">${escapeHtml(basename(filePath))}</button>
      <button class="recent-remove" data-remove-recent="${escapeHtml(filePath)}" title="从最近打开中移除" aria-label="从最近打开中移除">×</button>
    </span>`).join('')}`;
}

function applyWorkspaceLayout() {
  const leftWidth = state.leftVisible ? Math.max(0, Number(state.leftWidth) || 0) : 0;
  const rightWidth = state.rightVisible ? Math.max(0, Number(state.rightWidth) || 0) : 0;
  elements.workspace.style.setProperty('--left-sidebar-width', `${leftWidth}px`);
  elements.workspace.style.setProperty('--left-resizer-width', state.leftVisible ? '4px' : '0px');
  elements.workspace.style.setProperty('--right-resizer-width', state.rightVisible ? '4px' : '0px');
  elements.workspace.style.setProperty('--right-sidebar-width', `${rightWidth}px`);
  elements.leftSidebar.classList.toggle('collapsed', !state.leftVisible);
  elements.rightSidebar.classList.toggle('collapsed', !state.rightVisible);
  elements.leftResizer.hidden = !state.leftVisible;
  elements.rightResizer.hidden = !state.rightVisible;
  elements.toggleLeftSidebar?.setAttribute('aria-pressed', String(state.leftVisible));
  elements.toggleRightSidebar?.setAttribute('aria-pressed', String(state.rightVisible));
}

function renderShell() {
  const hasBook = Boolean(state.book);
  elements.workspace.hidden = !hasBook;
  elements.welcome.hidden = hasBook;
  elements.leftSidebar.classList.toggle('collapsed', !state.leftVisible);
  elements.rightSidebar.classList.toggle('collapsed', !state.rightVisible);
  applyWorkspaceLayout();
  if (elements.toggleLeftSidebar) elements.toggleLeftSidebar.disabled = !hasBook;
  if (elements.toggleRightSidebar) elements.toggleRightSidebar.disabled = !hasBook;
  updateDirtyStatus();
  applySettings();
  if (!hasBook) {
    renderRecentBooks();
    return;
  }
  renderDocumentTabs();
  renderLeftSidebar();
  renderRightSidebar();
  renderDocument();
  updateSpinePosition();
}

function renderAll() {
  renderShell();
}

function getResourceCategory(filePath) {
  const ext = extension(filePath);
  if (['xhtml', 'html', 'htm'].includes(ext)) return 'HTML';
  if (ext === 'css') return 'CSS';
  if (['js', 'mjs'].includes(ext)) return 'JS';
  if (ext === 'svg') return 'SVG';
  if (['xml', 'opf', 'ncx'].includes(ext)) return 'XML';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(ext)) return 'IMG';
  if (['mp3', 'm4a', 'ogg', 'wav'].includes(ext)) return 'AUD';
  if (['mp4', 'webm'].includes(ext)) return 'VID';
  if (ext === 'pdf') return 'PDF';
  if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return 'FNT';
  return (ext || '?').slice(0, 3).toUpperCase();
}

function renderDocumentTabs() {
  const spinePaths = new Set(state.book.spineResources().map((item) => item.item.path));
  elements.documentTabs.innerHTML = state.openPaths.map((filePath) => `
    <button class="document-tab ${filePath === state.activePath ? 'active' : ''}" data-resource-path="${escapeHtml(filePath)}" title="${escapeHtml(filePath)}">
      ${spinePaths.has(filePath) ? state.book.spineResources().findIndex((item) => item.item.path === filePath) + 1 : '•'}
      <span>${escapeHtml(basename(filePath))}</span>
      ${state.book.dirty ? '<span class="dirty-dot"></span>' : ''}
      <span class="tab-close" data-close-tab="${escapeHtml(filePath)}">×</span>
    </button>`).join('');
}

function renderLeftSidebar() {
  $$('[data-sidebar="left"] button').forEach((button) => button.classList.toggle('active', button.dataset.panel === state.leftPanel));
  if (!state.book) return;
  if (state.leftPanel === 'files') renderFilesPanel();
  else if (state.leftPanel === 'search') renderSearchPanel();
  else if (state.leftPanel === 'images') renderImagesPanel();
  else renderClipsPanel();
}

function renderFilesPanel() {
  const query = state.fileFilter.trim().toLocaleLowerCase();
  const items = state.book.manifestItems().filter((item) => !query || item.path.toLocaleLowerCase().includes(query) || item.id.toLocaleLowerCase().includes(query));
  const spineIndex = new Map(state.book.spineResources().map((item, index) => [item.item.path, index + 1]));
  const groups = new Map();
  for (const item of items) {
    const folder = dirname(item.path).replace(/^OEBPS\/?/, '') || '根目录';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  }
  const tree = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([folder, resources]) => `
    <div class="tree-folder">
      <div class="tree-folder-label"><span class="tree-chevron">▾</span><span class="tree-label">${escapeHtml(folder)}</span><span class="tree-meta">${resources.length}</span></div>
      ${resources.sort((a, b) => a.path.localeCompare(b.path)).map((item) => `
        <button class="tree-file ${item.path === state.activePath ? 'active' : ''}" data-resource-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}" style="--depth:1">
          <span class="tree-icon">${escapeHtml(getResourceCategory(item.path))}</span>
          <span class="tree-label">${escapeHtml(basename(item.path))}</span>
          ${spineIndex.has(item.path) ? `<span class="tree-spine" title="Spine 第 ${spineIndex.get(item.path)} 节"></span>` : ''}
        </button>`).join('')}
    </div>`).join('');
  elements.leftContent.innerHTML = `
    <div class="panel-actions">
      <button class="mini-button" data-command="add-files">添加文件</button>
      <button class="mini-button" data-command="new-resource" data-type="xhtml">新章节</button>
      <button class="mini-button" data-command="new-resource" data-type="css">新 CSS</button>
    </div>
    <div class="panel-section"><input id="resource-filter" class="search-box" type="search" placeholder="筛选资源与 ID…" value="${escapeHtml(state.fileFilter)}"></div>
    <div class="tree">${tree || '<div class="empty-state"><strong>没有匹配资源</strong><p>清除筛选或添加文件。</p></div>'}</div>`;
}

function imageUsageIndex() {
  const usage = new Map();
  const add = (targetPath, sourcePath) => {
    if (!targetPath || !state.book.getResource(targetPath)) return;
    if (!usage.has(targetPath)) usage.set(targetPath, new Set());
    usage.get(targetPath).add(sourcePath);
  };
  for (const item of state.book.manifestItems()) {
    if (item.mediaType.startsWith('image/') && item.properties.split(/\s+/).includes('cover-image')) add(item.path, 'OPF cover-image');
  }
  const coverMeta = descendants(state.book.opfDoc.documentElement).find((node) => node.localName === 'meta' && node.getAttribute('name') === 'cover');
  if (coverMeta?.getAttribute('content')) {
    const coverItem = state.book.getManifestItem(coverMeta.getAttribute('content'));
    if (coverItem?.mediaType.startsWith('image/')) add(coverItem.path, 'OPF meta cover');
  }
  for (const reference of state.book.getGuide()) {
    if (state.book.getResource(reference.path)) add(reference.path, 'OPF guide');
  }
  for (const [sourcePath, entry] of state.book.entries) {
    if (!entry.text) continue;
    if (isHtmlPath(sourcePath) || isXmlPath(sourcePath)) {
      try {
        const doc = parseXml(entry.text, isHtmlPath(sourcePath) ? 'application/xhtml+xml' : 'application/xml');
        for (const element of descendants(doc.documentElement)) {
          for (const name of ['src', 'href', 'xlink:href', 'poster']) {
            const value = element.getAttribute?.(name);
            if (!value || /^(https?:|mailto:|data:|blob:|#)/i.test(value)) continue;
            add(resolveHref(sourcePath, value).path, sourcePath);
          }
          const srcset = element.getAttribute?.('srcset') || '';
          for (const candidate of srcset.split(',')) {
            const value = candidate.trim().split(/\s+/)[0];
            if (value && !/^(https?:|data:|blob:)/i.test(value)) add(resolveHref(sourcePath, value).path, sourcePath);
          }
          const style = element.getAttribute?.('style') || '';
          for (const match of style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
            const value = match[2];
            if (value && !/^(https?:|data:|blob:|#)/i.test(value)) add(resolveHref(sourcePath, value).path, sourcePath);
          }
        }
      } catch { /* malformed resources are reported by validation */ }
    }
    if (isCssPath(sourcePath)) {
      for (const match of entry.text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        const value = match[2];
        if (value && !/^(https?:|data:|blob:|#)/i.test(value)) add(resolveHref(sourcePath, value).path, sourcePath);
      }
    }
  }
  return usage;
}

function renderImagesPanel() {
  const images = state.book.manifestItems().filter((item) => item.mediaType.startsWith('image/'));
  const usage = imageUsageIndex();
  const unusedCount = images.filter((item) => !usage.get(item.path)?.size).length;
  elements.leftContent.innerHTML = `
    <div class="panel-actions">
      <button class="mini-button" data-command="image-add">添加图片</button>
      <button class="mini-button" data-command="image-delete-unused">删除未使用${unusedCount ? ` (${unusedCount})` : ''}</button>
    </div>
    <div class="image-gallery">${images.map((item) => {
      const resource = state.book.getResource(item.path);
      const usedBy = [...(usage.get(item.path) || [])];
      const url = resource ? assetUrl(item.path) : '';
      return `
        <article class="image-card">
          <button class="image-thumb" data-image-open="${escapeHtml(item.path)}" title="查看 ${escapeHtml(item.path)}">
            ${url ? `<img data-image-thumb src="${url}" alt="">` : '<span class="tree-meta">资源缺失</span>'}
          </button>
          <div class="image-meta">
            <strong title="${escapeHtml(item.path)}">${escapeHtml(basename(item.path))}</strong>
            <small data-image-dimensions>${item.mediaType} · ${formatBytes(resource?.bytes?.byteLength || 0)}</small>
            <div class="image-usage ${usedBy.length ? '' : 'unused'}" title="${escapeHtml(usedBy.join('\n'))}">${usedBy.length ? `${usedBy.length} 个文件引用` : '未使用'}</div>
          </div>
          <div class="image-actions">
            <button data-image-insert="${escapeHtml(item.path)}">插入</button>
            <button data-image-replace="${escapeHtml(item.path)}">替换</button>
            <button data-image-remove="${escapeHtml(item.path)}">删除</button>
          </div>
        </article>`;
    }).join('') || '<div class="empty-state"><strong>暂无图片资源</strong><p>添加 PNG、JPEG、GIF、WebP、AVIF 或 SVG 后，可在这里插入正文、替换和清理未使用图片。</p><button class="button primary" data-command="image-add">添加图片</button></div>'}</div>`;
  for (const image of $$('[data-image-thumb]', elements.leftContent)) {
    const updateDimensions = () => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const label = image.closest('.image-card')?.querySelector('[data-image-dimensions]');
      if (label) label.textContent = `${image.naturalWidth}×${image.naturalHeight} · ${label.textContent}`;
    };
    if (image.complete) updateDimensions();
    else image.addEventListener('load', updateDimensions, { once: true });
  }
}

function ensureFindState() {
  const defaults = {
    query: '',
    replace: '',
    matches: [],
    index: -1,
    options: { regex: false, caseSensitive: false, wholeWord: false },
    scopeAll: false,
    error: null,
    activePath: '',
  };
  if (!state.find || typeof state.find !== 'object') state.find = defaults;
  state.find.options = { ...defaults.options, ...(state.find.options || {}) };
  if (!Array.isArray(state.find.matches)) state.find.matches = [];
  state.find.query = String(state.find.query || '');
  state.find.replace = String(state.find.replace || '');
  state.find.scopeAll = Boolean(state.find.scopeAll);
  state.find.index = Number.isInteger(state.find.index) ? state.find.index : -1;
  return state.find;
}

function scheduleFindQueryFocus() {
  const focusQuery = () => {
    if (!state.findFocusPending) return;
    const input = $('#find-query', elements.leftContent);
    if (!input?.isConnected) return;
    window.focus();
    input.focus({ preventScroll: true });
    if (document.activeElement !== input) return;
    input.select();
    state.findFocusPending = false;
  };
  queueMicrotask(focusQuery);
  requestAnimationFrame(focusQuery);
  setTimeout(focusQuery, 40);
  setTimeout(focusQuery, 140);
}

function activateSearchPanel(forceAll = false) {
  const find = ensureFindState();
  const alreadyOpen = Boolean(
    state.book
    && state.leftVisible
    && state.leftPanel === 'search'
    && $('#find-query')
  );
  if (forceAll) find.scopeAll = true;
  if (!find.activePath) find.activePath = state.activePath;
  state.leftPanel = 'search';
  state.leftVisible = true;
  state.findFocusPending = true;
  window.focus();
  if (alreadyOpen) {
    const scopeInput = $('#find-all-scope');
    if (scopeInput && scopeInput.checked !== find.scopeAll) {
      scopeInput.checked = find.scopeAll;
      scopeInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    scheduleFindQueryFocus();
    return;
  }
  if (state.book && !elements.workspace.hidden) renderSidebar('left');
  else renderShell();
}

function renderSearchPanel() {
  const find = ensureFindState();
  const checked = (value) => value ? ' checked' : '';
  elements.leftContent.innerHTML = `
    <div class="find-panel">
      <div class="find-row">
        <input id="find-query" type="text" value="${escapeHtml(find.query)}" placeholder="查找" autocomplete="off" spellcheck="false">
        <span id="find-count" class="count-label">0 个结果</span>
      </div>
      <div class="find-row">
        <input id="find-replace" type="text" value="${escapeHtml(find.replace)}" placeholder="替换为" autocomplete="off" spellcheck="false">
      </div>
      <div class="find-options">
        <label title="正则表达式"><input id="find-regex" type="checkbox"${checked(find.options.regex)}> 正则</label>
        <label title="区分大小写"><input id="find-case" type="checkbox"${checked(find.options.caseSensitive)}> 大小写</label>
        <label title="全词匹配"><input id="find-word" type="checkbox"${checked(find.options.wholeWord)}> 全词</label>
        <label title="搜索范围：整本书"><input id="find-all-scope" type="checkbox"${checked(find.scopeAll)}> 全书</label>
      </div>
      <div class="find-actions">
        <button type="button" class="mini-button" id="find-prev" title="上一个结果 (Shift+Enter)">上一个</button>
        <button type="button" class="mini-button" id="find-next" title="下一个结果 (Enter)">下一个</button>
        <button type="button" class="mini-button" id="replace-current" title="替换当前结果">替换</button>
        <button type="button" class="mini-button" id="replace-all" title="替换全部结果">全部替换</button>
      </div>
      <p class="find-status" id="find-status"></p>
    </div>
    <div id="find-results" class="find-results"></div>`;

  const queryInput = $('#find-query', elements.leftContent);
  const replaceInput = $('#find-replace', elements.leftContent);
  const count = $('#find-count', elements.leftContent);
  const status = $('#find-status', elements.leftContent);
  const resultList = $('#find-results', elements.leftContent);
  const optionInputs = $$('#find-regex, #find-case, #find-word, #find-all-scope', elements.leftContent);

  const readOptions = () => ({
    regex: $('#find-regex', elements.leftContent).checked,
    caseSensitive: $('#find-case', elements.leftContent).checked,
    wholeWord: $('#find-word', elements.leftContent).checked,
  });
  const readScopeAll = () => $('#find-all-scope', elements.leftContent).checked;
  const syncOptions = () => {
    find.options = readOptions();
    find.scopeAll = readScopeAll();
  };

  const updateStatus = () => {
    if (find.error) {
      count.textContent = '表达式错误';
      status.textContent = find.error.message || '表达式无效。';
    } else if (!find.query) {
      count.textContent = '0 个结果';
      status.textContent = '输入关键词后按 Enter 查找，Shift+Enter 查找上一个。';
    } else if (!find.matches.length) {
      count.textContent = '0 个结果';
      status.textContent = '没有匹配结果。';
    } else {
      count.textContent = `${find.matches.length} 个结果`;
      status.textContent = `第 ${find.index + 1} / ${find.matches.length} 个结果 · ${find.scopeAll ? '整本书' : '当前文件'}`;
    }
  };

  const renderResults = () => {
    if (!resultList) return;
    if (find.error) {
      resultList.innerHTML = `<div class="empty-state"><strong>表达式无效</strong><p>${escapeHtml(find.error.message)}</p></div>`;
      return;
    }
    if (!find.query) {
      resultList.innerHTML = '<div class="empty-state"><strong>输入关键词</strong><p>可在当前文件或整本书中查找并替换。</p></div>';
      return;
    }
    if (!find.matches.length) {
      resultList.innerHTML = '<div class="empty-state"><strong>没有结果</strong><p>尝试更短的关键词或切换查找选项。</p></div>';
      return;
    }
    const counts = new Map();
    for (const match of find.matches) counts.set(match.path, (counts.get(match.path) || 0) + 1);
    const visible = find.matches.slice(0, 200);
    let html = '';
    let currentPath = '';
    for (const [index, match] of visible.entries()) {
      if (match.path !== currentPath) {
        if (currentPath) html += '</div>';
        currentPath = match.path;
        html += `<div class="result-file"><div class="result-file-heading"><span title="${escapeHtml(match.path)}">${escapeHtml(match.path)}</span><span class="tree-meta">${counts.get(match.path)}</span></div>`;
      }
      html += `<button class="search-hit ${index === find.index ? 'active' : ''}" data-find-index="${index}">
        <span>${highlightExcerpt(match.excerpt || match.text, match.text)}</span>
        <small>第 ${match.line || 1} 行，第 ${match.column || 1} 列</small>
      </button>`;
    }
    if (currentPath) html += '</div>';
    if (find.matches.length > visible.length) html += `<p class="find-status">仅显示前 ${visible.length} 个结果。</p>`;
    resultList.innerHTML = html;
  };

  const revealCurrent = () => {
    const match = find.matches[find.index];
    if (!match) return;
    const occurrence = find.matches
      .slice(0, find.index)
      .filter((candidate) => candidate.path === match.path && candidate.text === match.text).length;
    goToFindMatch(match, { options: find.options, occurrence });
    state.findFocusPending = true;
    scheduleFindQueryFocus();
  };

  const runSearch = ({ goNext = true, reveal = goNext } = {}) => {
    const query = queryInput.value;
    find.query = query;
    find.replace = replaceInput.value;
    syncOptions();
    find.error = null;
    if (!query) {
      find.matches = [];
      find.index = -1;
      find.activePath = state.activePath;
      updateStatus();
      renderResults();
      return;
    }
    const result = searchBook(
      state.book,
      query,
      find.options,
      find.scopeAll ? null : [state.activePath],
    );
    find.error = result.error || null;
    find.matches = result.error ? [] : (result.results || []).flatMap((file) => file.matches.map((match) => ({ ...match, path: file.path })));
    find.activePath = state.activePath;
    if (!find.matches.length) find.index = -1;
    else if (goNext) find.index = (find.index + 1 + find.matches.length) % find.matches.length;
    else if (find.index < 0 || find.index >= find.matches.length) find.index = 0;
    updateStatus();
    renderResults();
    if (reveal && !find.error) revealCurrent();
  };

  const step = (direction) => {
    if (!find.matches.length || find.error) {
      runSearch({ goNext: direction > 0, reveal: true });
      return;
    }
    find.index = (find.index + direction + find.matches.length) % find.matches.length;
    updateStatus();
    renderResults();
    revealCurrent();
  };

  const replaceCurrent = () => {
    find.replace = replaceInput.value;
    syncOptions();
    if (!find.matches.length || !find.matches[find.index]) {
      runSearch({ goNext: false, reveal: false });
      if (!find.matches.length || !find.matches[find.index]) return;
    }
    const match = find.matches[find.index];
    const resource = state.book.getResource(match.path);
    if (!resource?.text) return;
    const replacement = expandReplacement(find.replace, match, find.options);
    resource.text = resource.text.slice(0, match.start) + replacement + resource.text.slice(match.end);
    resource.bytes = new TextEncoder().encode(resource.text);
    state.book.dirty = true;
    const shift = replacement.length - match.text.length;
    for (const candidate of find.matches) {
      if (candidate === match) continue;
      if (candidate.path === match.path && candidate.start > match.start) {
        candidate.start += shift;
        candidate.end += shift;
      }
    }
    updateDirtyStatus();
    if (state.activePath === match.path) renderDocument();
    runSearch({ goNext: false, reveal: false });
    status.textContent = '已替换 1 处。';
    requestAnimationFrame(() => replaceInput.focus({ preventScroll: true }));
  };

  const replaceAll = () => {
    find.replace = replaceInput.value;
    runSearch({ goNext: false, reveal: false });
    if (find.error || !find.query) return;
    const targetPaths = find.scopeAll
      ? new Set([...state.book.entries].filter(([filePath]) => isTextPath(filePath)).map(([filePath]) => filePath))
      : new Set([state.activePath]);
    let total = 0;
    for (const filePath of targetPaths) {
      const resource = state.book.getResource(filePath);
      if (!resource?.text) continue;
      const result = replaceMatches(resource.text, find.query, find.replace, find.options);
      if (!result.count) continue;
      resource.text = result.text;
      resource.bytes = new TextEncoder().encode(result.text);
      total += result.count;
      if (filePath === state.book.opfPath) state.book.opfTextDirty = true;
    }
    if (!total) {
      status.textContent = '没有可替换的结果。';
      return;
    }
    state.book.dirty = true;
    clearAssetCache();
    renderDocument();
    updateDirtyStatus();
    runSearch({ goNext: false, reveal: false });
    status.textContent = `已替换 ${total} 处。`;
    toast('替换完成', `${total} 处`);
    requestAnimationFrame(() => replaceInput.focus({ preventScroll: true }));
  };

  queryInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    find.query = queryInput.value;
    find.matches = [];
    find.index = -1;
    find.error = null;
    updateStatus();
    renderResults();
    searchDebounce = setTimeout(() => runSearch({ goNext: false, reveal: false }), 180);
  });
  queryInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(searchDebounce);
    step(event.shiftKey ? -1 : 1);
  });
  replaceInput.addEventListener('input', () => { find.replace = replaceInput.value; });
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    replaceCurrent();
  });
  $('#find-prev', elements.leftContent).addEventListener('click', () => step(-1));
  $('#find-next', elements.leftContent).addEventListener('click', () => step(1));
  $('#replace-current', elements.leftContent).addEventListener('click', replaceCurrent);
  $('#replace-all', elements.leftContent).addEventListener('click', replaceAll);
  for (const input of optionInputs) {
    input.addEventListener('change', () => {
      clearTimeout(searchDebounce);
      syncOptions();
      find.matches = [];
      find.index = -1;
      find.error = null;
      runSearch({ goNext: false, reveal: false });
    });
  }
  resultList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-find-index]');
    if (!button) return;
    find.index = Number(button.dataset.findIndex);
    updateStatus();
    renderResults();
    revealCurrent();
  });

  updateStatus();
  renderResults();
  if (state.findFocusPending) scheduleFindQueryFocus();
}

function highlightExcerpt(excerpt, query) {
  if (!query) return escapeHtml(excerpt);
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escapeHtml(excerpt).replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  } catch { return escapeHtml(excerpt); }
}

function renderClipsPanel() {
  elements.leftContent.innerHTML = `
    <div class="panel-actions">
      <button class="mini-button" data-command="clip-add">保存选中内容</button>
      <button class="mini-button" data-command="clip-new">新建片段</button>
    </div>
    <div class="clip-list">${state.clips.map((clip) => `
      <div class="clip-item">
        <button class="clip-link" data-clip-insert="${clip.id}"><span>${escapeHtml(clip.label)}</span><small class="clip-preview">${escapeHtml(clip.content.slice(0, 70).replace(/\s+/g, ' '))}</small></button>
        <button class="row-action" data-clip-edit="${clip.id}" title="编辑">✎</button>
        <button class="row-action" data-clip-delete="${clip.id}" title="删除">×</button>
      </div>`).join('') || '<div class="empty-state"><strong>暂无片段</strong><p>保存常用 HTML 或文本，在编辑时快速插入。</p></div>'}</div>`;
}

function renderRightSidebar() {
  $$('[data-sidebar="right"] button').forEach((button) => button.classList.toggle('active', button.dataset.panel === state.rightPanel));
  if (!state.book) return;
  if (state.rightPanel === 'toc') renderTocPanel();
  else if (state.rightPanel === 'bookmarks') renderBookmarksPanel();
  else if (state.rightPanel === 'inspector') renderInspectorPanel();
  else if (state.rightPanel === 'metadata') renderMetadataPanel();
  else if (state.rightPanel === 'validation') renderValidationPanel();
  else renderReportPanel();
}

function updateSpinePosition() {
  if (!state.book || !state.activePath) {
    elements.spinePosition.textContent = '0 / 0';
    return;
  }
  const spine = state.book.spineResources();
  const index = spine.findIndex((item) => item.item.path === state.activePath);
  elements.spinePosition.textContent = `${index >= 0 ? index + 1 : 0} / ${spine.length}`;
}

function openResource(filePath, options = {}) {
  if (!state.book) return;
  const normalized = normalizePath(filePath);
  if (!state.book.getResource(normalized)) {
    toast('找不到资源', normalized, 'error');
    return;
  }
  const hasRevealTarget = Object.keys(options).length > 0;
  if (state.activePath && state.activePath !== normalized) rememberViewLocationForPath(state.activePath);
  if (!state.openPaths.includes(normalized)) state.openPaths.push(normalized);
  state.activePath = normalized;
  state.selectedElement = null;
  if (state.find && !state.find.scopeAll && state.find.activePath && state.find.activePath !== normalized) {
    state.find.matches = [];
    state.find.index = -1;
    state.find.activePath = normalized;
  }
  if (isHtmlPath(normalized)) {
    if (options.offset !== undefined) state.mode = 'html';
    else if (!['html', 'preview', 'read'].includes(state.mode)) state.mode = 'preview';
  } else {
    state.mode = 'code';
  }
  pendingViewLocation = hasRevealTarget ? null : recallViewLocationForPath(normalized);
  frameViewAnchor = null;
  state.pendingReveal = hasRevealTarget ? options : null;
  renderShell();
  schedulePendingReveal();
}

function closeResourceTab(filePath) {
  forgetViewLocationForPath(filePath);
  state.openPaths = state.openPaths.filter((item) => item !== filePath);
  if (state.activePath === filePath) {
    state.activePath = state.openPaths.at(-1) || '';
    pendingViewLocation = state.activePath ? recallViewLocationForPath(state.activePath) : null;
    frameViewAnchor = null;
    state.pendingReveal = null;
  }
  if (!state.activePath && state.book) state.activePath = state.book.spineResources()[0]?.item.path || state.book.manifestItems()[0]?.path || '';
  if (state.activePath && !state.openPaths.includes(state.activePath)) state.openPaths.push(state.activePath);
  renderShell();
}

function revealPending({ frameReady = false, iframe = null } = {}) {
  const reveal = state.pendingReveal;
  if (!reveal) return false;
  if (Object.hasOwn(reveal, 'offset')) {
    if (!editor) return false;
    editor.scrollToOffset(Number(reveal.offset), { focus: false });
    state.pendingReveal = null;
    return true;
  }
  if (Object.hasOwn(reveal, 'hash') || Object.hasOwn(reveal, 'percent')) {
    const frame = iframe || $('.preview-frame, .reader-frame', elements.documentHost);
    const doc = frame?.contentDocument;
    const ready = frameReady || Boolean(
      doc?.getElementById('epub-studio-runtime-style')
      && doc.body?.childNodes.length,
    );
    if (!ready) return false;
    if (Object.hasOwn(reveal, 'hash')) {
      if (reveal.hash) {
        const target = doc.getElementById(reveal.hash);
        if (!target) return false;
        target.scrollIntoView({ block: 'center' });
      } else {
        (doc.scrollingElement || doc.documentElement).scrollTop = 0;
      }
    }
    if (Object.hasOwn(reveal, 'percent')) {
      const scrolling = doc.scrollingElement || doc.documentElement;
      const total = Math.max(0, scrolling.scrollHeight - scrolling.clientHeight);
      scrolling.scrollTop = total * Number(reveal.percent) / 100;
    }
    state.pendingReveal = null;
    return true;
  }
  state.pendingReveal = null;
  return true;
}

function schedulePendingReveal({ frameReady = false, iframe = null, attempt = 0 } = {}) {
  clearTimeout(pendingRevealTimer);
  pendingRevealTimer = setTimeout(() => {
    if (!state.pendingReveal) return;
    const revealed = revealPending({ frameReady, iframe });
    if (!revealed && attempt < 100) {
      schedulePendingReveal({ frameReady, iframe, attempt: attempt + 1 });
    } else if (!revealed) {
      state.pendingReveal = null;
    }
  }, attempt ? 20 : 0);
}

async function loadBook(payload, { keepDirty = false } = {}) {
  if (!payload) return;
  if (state.book?.dirty && !keepDirty) {
    const proceed = await confirmDialog({ title: '放弃未保存更改？', message: '打开另一本书会丢弃当前未保存的修改。', confirmLabel: '放弃并打开', danger: true });
    if (!proceed) return;
  }
  setStatus('正在解析 EPUB…');
  const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const book = await EpubBook.fromArrayBuffer(buffer, payload.path || payload.name || '未命名.epub');
  clearAssetCache();
  resourceViewLocations.clear();
  state.book = book;
  state.openPaths = [];
  state.activePath = '';
  state.validation = null;
  state.report = null;
  state.find = null;
  state.findFocusPending = false;
  state.tocSelectedIndex = '';
  state.bookmarks = loadBookmarks(book);
  const initial = book.spineResources().find((item) => isHtmlPath(item.item.path))?.item.path
    || book.manifestItems().find((item) => isHtmlPath(item.path))?.path
    || book.manifestItems()[0]?.path;
  if (initial) {
    state.openPaths = [initial];
    state.activePath = initial;
    state.mode = isHtmlPath(initial) ? 'preview' : 'code';
  }
  renderShell();
  setStatus(`已打开 ${book.name}`);
  toast('EPUB 已打开', `${book.info.resourceCount} 个资源 · ${book.info.version}`, 'info');
}

async function openBookDialog() {
  const payload = await window.studio.openEpubDialog();
  if (payload) await loadBook(payload);
}

async function openBookPath(filePath) {
  if (!filePath) return;
  const payload = await window.studio.readEpub(filePath);
  await loadBook(payload);
}

async function createBook(version) {
  if (state.book?.dirty) {
    const proceed = await confirmDialog({ title: '放弃未保存更改？', message: '新建书籍会关闭当前书籍。', confirmLabel: '放弃并新建', danger: true });
    if (!proceed) return;
  }
  const book = await EpubBook.create({ version, title: version === 2 ? '未命名 EPUB 2' : '未命名 EPUB 3' });
  resourceViewLocations.clear();
  state.book = book;
  state.bookmarks = [];
  state.validation = null;
  state.report = null;
  state.find = null;
  state.findFocusPending = false;
  const chapter = book.spineResources()[0]?.item.path || book.manifestItems().find((item) => isHtmlPath(item.path))?.path;
  state.openPaths = chapter ? [chapter] : [];
  state.activePath = chapter || '';
  state.mode = 'preview';
  clearAssetCache();
  renderShell();
  toast('已创建 EPUB', `EPUB ${version}`, 'info');
}

async function saveBook({ saveAs = false, saveCopy = false } = {}) {
  if (!state.book) return;
  if (saveAs || saveCopy || !state.book.path) {
    // Save As always prompts through the main process.
  }
  setStatus('正在打包 EPUB…');
  const data = await state.book.save();
  const target = await window.studio.saveEpub(data, saveAs ? null : state.book.path, saveCopy);
  if (!target) { setStatus('已取消保存'); return; }
  state.book.path = target;
  state.book.name = basename(target);
  state.settings = await window.studio.getSettings();
  renderShell();
  toast('保存完成', target, 'info');
}

async function closeBook() {
  if (!state.book) return;
  if (state.book.dirty) {
    const proceed = await confirmDialog({ title: '关闭未保存的书籍？', message: '尚未保存的修改将丢失。', confirmLabel: '放弃并关闭', danger: true });
    if (!proceed) return;
  }
  clearAssetCache();
  state.book = null;
  state.activePath = '';
  state.openPaths = [];
  resourceViewLocations.clear();
  state.bookmarks = [];
  state.find = null;
  state.findFocusPending = false;
  editor = null;
  pendingViewLocation = null;
  frameViewAnchor = null;
  renderShell();
}

async function setMode(mode) {
  if (!state.book) return;
  if (!isHtmlPath(state.activePath) && mode !== 'code') {
    toast('此资源不支持正文模式', '请选择一个 XHTML/HTML 章节。', 'warning');
    return;
  }
  if (mode === state.mode) return;
  if (activeFrame) syncFrameToBook();
  pendingViewLocation = captureCurrentViewLocation();
  if (pendingViewLocation) resourceViewLocations.set(state.activePath, pendingViewLocation);
  state.mode = mode;
  renderShell();
}

async function executeCommand(payload, extra = {}) {
  try {
    return await executeCommandInner(payload, extra);
  } catch (error) {
    console.error('Command failed:', payload, error);
    setStatus('操作失败', 'error');
    await alertDialog({ title: '操作失败', message: errorMessage(error) });
  }
}

async function executeCommandInner(payload, extra = {}) {
  if (!payload) return;
  const command = typeof payload === 'string' ? payload : payload.command;
  if (typeof payload !== 'string') extra = { ...payload, ...extra };
  switch (command) {
    case 'open': await openBookDialog(); break;
    case 'open-path': await openBookPath(payload.payload || extra.path); break;
    case 'new-epub2': await createBook(2); break;
    case 'new-epub3': await createBook(3); break;
    case 'save': await saveBook(); break;
    case 'save-as': await saveBook({ saveAs: true }); break;
    case 'save-copy': await saveBook({ saveCopy: true }); break;
    case 'close-book': await closeBook(); break;
    case 'add-files': await addExistingFiles(); break;
    case 'new-resource': await newResource(extra.type || 'xhtml'); break;
    case 'import-html': await importTextResource('html'); break;
    case 'import-text': await importTextResource('text'); break;
    case 'rename-resource': await renameActiveResource(); break;
    case 'delete-resource': await deleteActiveResource(); break;
    case 'mode-html': await setMode('html'); break;
    case 'mode-preview': await setMode('preview'); break;
    case 'mode-read': await setMode('read'); break;
    case 'toggle-left':
      state.leftVisible = !state.leftVisible;
      if (!state.leftVisible) state.findFocusPending = false;
      applyWorkspaceLayout();
      break;
    case 'toggle-right': state.rightVisible = !state.rightVisible; applyWorkspaceLayout(); break;
    case 'find': activateSearchPanel(false); break;
    case 'find-all': activateSearchPanel(true); break;
    case 'print': await window.studio.print(); break;
    case 'export-pdf': await exportPdf(); break;
    case 'show-metadata': await showRightPanel('metadata'); break;
    case 'show-toc': await showRightPanel('toc'); break;
    case 'generate-toc': await generateTocFromHeadings(); break;
    case 'show-bookmarks': await showRightPanel('bookmarks'); break;
    case 'show-images': state.leftPanel = 'images'; state.leftVisible = true; renderShell(); break;
    case 'recent-cleared': state.settings.recentFiles = []; renderRecentBooks(); break;
    case 'show-inspector': await showRightPanel('inspector'); break;
    case 'reports': await showRightPanel('report'); break;
    case 'validate': await validateBook(); break;
    case 'check-links': await checkLinks(); break;
    case 'prettify': await prettifyActive(false); break;
    case 'format-css': await prettifyActive(true); break;
    case 'preferences': await openPreferences(); break;
    case 'help': await showHelp(); break;
    case 'about': await showAbout(); break;
    case 'reload-preview': clearAssetCache(); renderDocument(); break;
    case 'spine-prev': await navigateSpine(-1); break;
    case 'spine-next': await navigateSpine(1); break;
    case 'toggle-spellcheck': await toggleSpellcheck(); break;
    case 'theme-light': await updateSettings({ theme: 'light' }); break;
    case 'theme-dark': await updateSettings({ theme: 'dark' }); break;
    case 'theme-system': await updateSettings({ theme: 'system' }); break;
    case 'zoom-in': setZoom(state.zoom + .1); break;
    case 'zoom-out': setZoom(state.zoom - .1); break;
    case 'zoom-reset': setZoom(1); break;
    case 'insert-character': await insertSpecialCharacter(); break;
    case 'insert-image': await insertImage(); break;
    case 'image-add': await addImageFiles(); break;
    case 'image-replace': await replaceImage(extra.path); break;
    case 'image-remove': await removeImage(extra.path); break;
    case 'image-delete-unused': await deleteUnusedImages(); break;
    case 'insert-link': await insertLink(); break;
    case 'insert-id': await insertId(); break;
    case 'insert-section-break': await insertSectionBreak(); break;
    case 'insert-ul': await formatPreview('insertUnorderedList'); break;
    case 'insert-ol': await formatPreview('insertOrderedList'); break;
    case 'insert-footnote': await insertFootnote(); break;
    case 'insert-clip': await chooseClipToInsert(); break;
    case 'heading': await applyHeading(extra.level); break;
    case 'bold': await formatPreview('bold'); break;
    case 'italic': await formatPreview('italic'); break;
    case 'underline': await formatPreview('underline'); break;
    case 'strike': await formatPreview('strikeThrough'); break;
    case 'subscript': await formatPreview('subscript'); break;
    case 'superscript': await formatPreview('superscript'); break;
    case 'align-left': await formatPreview('justifyLeft'); break;
    case 'align-center': await formatPreview('justifyCenter'); break;
    case 'align-right': await formatPreview('justifyRight'); break;
    case 'align-justify': await formatPreview('justifyFull'); break;
    case 'indent': await formatPreview('indent'); break;
    case 'outdent': await formatPreview('outdent'); break;
    case 'case-lower': await changeCase('lower'); break;
    case 'case-upper': await changeCase('upper'); break;
    case 'case-title': await changeCase('title'); break;
    case 'case-capitalize': await changeCase('capitalize'); break;
    case 'split-section': await splitSection(); break;
    case 'clean-inline': await cleanInline(); break;
    case 'smart-punctuation': await applySmartPunctuation(); break;
    case 'toggle-code': await toggleCode(); break;
    case 'delete-line': if (editor) editor.deleteLine(); break;
    case 'undo': await editorCommand('undo'); break;
    case 'redo': await editorCommand('redo'); break;
    case 'cut': await editorCommand('cut'); break;
    case 'copy': await editorCommand('copy'); break;
    case 'paste': await pasteAtSelection(); break;
    case 'select-all': await editorCommand('selectAll'); break;
    case 'clip-add': await addClipFromSelection(); break;
    case 'clip-new': await createClip(); break;
    case 'bookmark-add': await addBookmark(); break;
    case 'bookmark-export': await exportBookmarks(); break;
    case 'bookmark-import': await importBookmarks(); break;
    case 'toc-add': await editTocEntry(null); break;
    case 'toc-add-child': await addTocChild(); break;
    case 'toc-rename': await renameTocEntry(); break;
    case 'toc-delete': await deleteTocEntry(); break;
    case 'toc-up': moveToc(-1); break;
    case 'toc-down': moveToc(1); break;
    case 'toc-indent': indentToc(); break;
    case 'toc-outdent': outdentToc(); break;
    case 'metadata-save': await saveMetadata(); break;
    case 'metadata-add-creator': addCreatorRow(); break;
    case 'metadata-add-subject': await addSubject(); break;
    case 'inspector-apply': await applyInspector(); break;
    case 'validation-export': await exportValidation(); break;
    case 'report-export-html': await exportReport('html'); break;
    case 'report-export-csv': await exportReport('csv'); break;
    case 'report-refresh': state.report = state.book?.generateReports() || null; renderRightSidebar(); break;
    default: if (command) console.warn('Unknown command', command, extra);
  }
}

async function showRightPanel(panel) {
  if (!state.book) {
    toast('请先打开书籍', '', 'warning');
    return;
  }
  state.rightPanel = panel;
  state.rightVisible = true;
  if (panel === 'report' && !state.report) state.report = state.book.generateReports();
  renderShell();
}

function setZoom(value) {
  state.zoom = Math.max(.5, Math.min(2.5, value));
  const frame = $('.preview-frame, .reader-frame', elements.documentHost);
  if (frame) frame.style.zoom = String(state.zoom);
  setStatus(`缩放 ${Math.round(state.zoom * 100)}%`);
}

async function navigateSpine(direction) {
  if (!state.book) return;
  const spine = state.book.spineResources();
  const index = spine.findIndex((item) => item.item.path === state.activePath);
  const target = spine[Math.max(0, Math.min(spine.length - 1, (index < 0 ? 0 : index) + direction))];
  if (target) openResource(target.item.path, { percent: 0 });
}

async function updateSettings(patch) {
  state.settings = await window.studio.updateSettings(patch);
  applySettings();
  if (Object.hasOwn(patch, 'showRecentFiles') || Object.hasOwn(patch, 'recentFiles')) renderRecentBooks();
  if (state.activePath && isHtmlPath(state.activePath) && (patch.fontFamily || patch.fontSize || patch.readingWidth)) renderDocument();
  else if (editor && Object.hasOwn(patch, 'lineWrapping')) editor.lineWrapping = state.settings.lineWrapping;
}

async function toggleSpellcheck() {
  await updateSettings({ spellcheck: !state.settings.spellcheck });
  toast('拼写检查', state.settings.spellcheck ? '已开启' : '已关闭');
}

async function exportPdf() {
  document.body.classList.add('is-printing');
  const target = await window.studio.exportPdf();
  document.body.classList.remove('is-printing');
  if (target) toast('PDF 已导出', target, 'info');
}

async function reloadFromSettings() {
  state.settings = await window.studio.getSettings();
  state.appInfo = await window.studio.getAppInfo();
  applySettings();
  renderRecentBooks();
}

function bindGlobalEvents() {
  document.addEventListener('click', async (event) => {
    const removeRecentButton = event.target.closest('[data-remove-recent]');
    if (removeRecentButton) {
      event.preventDefault();
      event.stopPropagation();
      state.settings.recentFiles = await window.studio.removeRecent(removeRecentButton.dataset.removeRecent);
      renderRecentBooks();
      return;
    }
    const openRecent = event.target.closest('[data-open-path]');
    if (openRecent) {
      event.preventDefault();
      await openBookPath(openRecent.dataset.openPath);
      return;
    }
    const imageOpen = event.target.closest('[data-image-open]');
    if (imageOpen) {
      openResource(imageOpen.dataset.imageOpen);
      return;
    }
    const imageInsert = event.target.closest('[data-image-insert]');
    if (imageInsert) {
      await insertImage(imageInsert.dataset.imageInsert);
      return;
    }
    const imageReplace = event.target.closest('[data-image-replace]');
    if (imageReplace) {
      await replaceImage(imageReplace.dataset.imageReplace);
      return;
    }
    const imageRemove = event.target.closest('[data-image-remove]');
    if (imageRemove) {
      await removeImage(imageRemove.dataset.imageRemove);
      return;
    }
    const closeTab = event.target.closest('[data-close-tab]');
    if (closeTab) {
      event.stopPropagation();
      closeResourceTab(closeTab.dataset.closeTab);
      return;
    }
    const resource = event.target.closest('[data-resource-path]');
    if (resource && !event.target.closest('[data-close-tab]')) {
      openResource(resource.dataset.resourcePath);
      return;
    }
    const mode = event.target.closest('[data-mode]');
    if (mode) { await setMode(mode.dataset.mode); return; }
    const panel = event.target.closest('[data-panel]');
    if (panel) {
      const sidebar = panel.closest('[data-sidebar]')?.dataset.sidebar;
      if (sidebar === 'left') {
        state.leftPanel = panel.dataset.panel;
        if (state.leftPanel !== 'search') state.findFocusPending = false;
      }
      if (sidebar === 'right') {
        state.rightPanel = panel.dataset.panel;
        if (state.rightPanel === 'report' && !state.report) state.report = state.book?.generateReports();
      }
      renderSidebar(sidebar);
      return;
    }
    const format = event.target.closest('[data-format]');
    if (format) {
      const command = format.dataset.format;
      if (command === 'createLink') await insertLink();
      else if (command === 'insertImage') await insertImage();
      else if (command === 'insertHorizontalRule') await insertSectionBreak();
      else await formatPreview(command);
      return;
    }
    const clipInsert = event.target.closest('[data-clip-insert]');
    if (clipInsert) { insertClip(clipInsert.dataset.clipInsert); return; }
    const clipEdit = event.target.closest('[data-clip-edit]');
    if (clipEdit) { await editClip(clipEdit.dataset.clipEdit); return; }
    const clipDelete = event.target.closest('[data-clip-delete]');
    if (clipDelete) { await deleteClip(clipDelete.dataset.clipDelete); return; }
    const bookmarkButton = event.target.closest('[data-bookmark-id]');
    if (bookmarkButton) {
      const id = bookmarkButton.dataset.bookmarkId;
      const action = bookmarkButton.dataset.bookmarkAction;
      if (action === 'jump') await jumpBookmark(id);
      else if (action === 'rename') await renameBookmark(id);
      else if (action === 'delete') await removeBookmark(id);
      return;
    }
    const tocButton = event.target.closest('[data-toc-index]');
    if (tocButton) {
      state.tocSelectedIndex = tocButton.dataset.tocIndex;
      if (tocButton.dataset.tocAction === 'jump') await jumpToc(state.tocSelectedIndex);
      else renderTocPanel();
      return;
    }
    if (event.target.closest('[data-inspector-add-attribute]')) {
      const name = await promptDialog({ title: '添加属性', label: '属性名称', value: 'class' });
      if (name) $('#inspector-attributes')?.insertAdjacentHTML('beforeend', `<label class="attribute-row"><span>${escapeHtml(name)}</span><input data-attribute-name="${escapeHtml(name)}" value=""></label>`);
      return;
    }
    const validationItem = event.target.closest('[data-validation-index]');
    if (validationItem) {
      const result = state.validation?.[Number(validationItem.dataset.validationIndex)];
      if (result?.path) openResource(result.path);
      return;
    }
    const commandButton = event.target.closest('[data-command]');
    if (commandButton) {
      await executeCommand(commandButton.dataset.command, {
        type: commandButton.dataset.type,
        payload: commandButton.dataset.payload,
        path: commandButton.dataset.openPath,
      });
    }
  });

  document.addEventListener('change', async (event) => {
    const heading = event.target.closest('[data-format-select="heading"]');
    if (heading) await applyHeading(Number(heading.value));
  });

  document.addEventListener('input', debounce((event) => {
    if (event.target.id === 'resource-filter') {
      state.fileFilter = event.target.value;
      const cursor = event.target.selectionStart;
      renderFilesPanel();
      const next = $('#resource-filter');
      next.focus();
      next.setSelectionRange(cursor, cursor);
    }
  }, 120));

  document.addEventListener('keydown', (event) => {
    if (!state.book) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'f') {
      event.preventDefault();
      activateSearchPanel(event.shiftKey);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 's') {
      event.preventDefault();
      saveBook();
    }
  });
  document.addEventListener('keydown', handleEditorShortcut, true);

  window.addEventListener('contextmenu', (event) => {
    const resource = event.target.closest('[data-resource-path]');
    if (!resource) return;
    event.preventDefault();
    const filePath = resource.dataset.resourcePath;
    showContextMenu([
      { label: '打开', action: () => openResource(filePath) },
      { label: '在阅读模式打开', action: () => { state.mode = 'read'; openResource(filePath); } },
      { separator: true },
      { label: '重命名…', action: () => { state.activePath = filePath; renameActiveResource(); } },
      { label: '删除', action: () => { state.activePath = filePath; deleteActiveResource(); } },
    ], event.clientX, event.clientY);
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);
  window.studio.onCommand((payload) => executeCommand(payload));
  bindResizers();
}

function renderSidebar(side) {
  if (side === 'left') renderLeftSidebar();
  if (side === 'right') renderRightSidebar();
}

function bindResizers() {
  for (const handle of $$('.sidebar-resizer')) {
    handle.addEventListener('pointerdown', (event) => {
      if (handle.hidden) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const side = handle.dataset.resize;
      const startX = event.clientX;
      const startWidth = side === 'left' ? state.leftWidth : state.rightWidth;
      const otherWidth = side === 'left'
        ? (state.rightVisible ? state.rightWidth : 0)
        : (state.leftVisible ? state.leftWidth : 0);
      const minWidth = side === 'left' ? 190 : 230;
      const available = elements.workspace.getBoundingClientRect().width;
      const maxWidth = Math.max(minWidth, available - otherWidth - 340 - 8);
      const move = (moveEvent) => {
        const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        const width = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
        if (side === 'left') state.leftWidth = width;
        else state.rightWidth = width;
        applyWorkspaceLayout();
      };
      const finish = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        try { handle.releasePointerCapture(event.pointerId); } catch {}
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish, { once: true });
      handle.addEventListener('pointercancel', finish, { once: true });
    });
  }
}

async function initialize() {
  await reloadFromSettings();
  bindGlobalEvents();
  state.clips = loadClips();
  renderShell();
  setStatus('就绪');
}

initialize().catch((error) => {
  console.error(error);
  alertDialog({ title: '启动失败', message: errorMessage(error) });
});

// Map visible body text back to source offsets so mode switches can restore the current reading line.
function sourceBodyTextMap(source) {
  const markup = String(source || '');
  const bodyOpen = /<body\b[^>]*>/i.exec(markup);
  const start = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const bodyClose = bodyOpen ? /<\/body\s*>/i.exec(markup.slice(start)) : null;
  const end = bodyClose ? start + bodyClose.index : markup.length;
  const characters = [];
  const offsets = [];
  const ends = [];

  const appendText = (value, sourceStart) => {
    if (!value) return;
    const decoder = document.createElement('div');
    decoder.innerHTML = value;
    const decoded = decoder.textContent || '';
    for (let index = 0; index < decoded.length; index += 1) {
      const rawStart = decoded.length === value.length
        ? sourceStart + index
        : sourceStart + Math.floor(index * value.length / decoded.length);
      const rawEnd = decoded.length === value.length
        ? rawStart + 1
        : sourceStart + Math.max(rawStart - sourceStart + 1, Math.ceil((index + 1) * value.length / decoded.length));
      characters.push(decoded[index]);
      offsets.push(rawStart);
      ends.push(Math.min(end, rawEnd));
    }
  };

  let cursor = start;
  while (cursor < end) {
    const tagStart = markup.indexOf('<', cursor);
    if (tagStart < 0 || tagStart >= end) {
      appendText(markup.slice(cursor, end), cursor);
      break;
    }
    appendText(markup.slice(cursor, tagStart), cursor);
    if (markup.startsWith('<!--', tagStart)) {
      const commentEnd = markup.indexOf('-->', tagStart + 4);
      cursor = commentEnd < 0 ? end : Math.min(end, commentEnd + 3);
      continue;
    }
    if (markup.startsWith('<![CDATA[', tagStart)) {
      const cdataEnd = markup.indexOf(']]>', tagStart + 9);
      const contentEnd = cdataEnd < 0 ? end : Math.min(end, cdataEnd);
      appendText(markup.slice(tagStart + 9, contentEnd), tagStart + 9);
      cursor = cdataEnd < 0 ? end : Math.min(end, cdataEnd + 3);
      continue;
    }
    const tagMatch = /^<\s*([A-Za-z][\w:-]*)/.exec(markup.slice(tagStart, end));
    const tagName = tagMatch?.[1]?.toLocaleLowerCase() || '';
    if (tagName === 'script' || tagName === 'style' || tagName === 'noscript' || tagName === 'template') {
      const closing = new RegExp(`</\\s*${tagName}\\s*>`, 'ig');
      closing.lastIndex = tagStart;
      const match = closing.exec(markup);
      cursor = match && match.index < end ? match.index + match[0].length : end;
      continue;
    }
    let tagEnd = tagStart + 1;
    let quote = '';
    while (tagEnd < end) {
      const character = markup[tagEnd];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        tagEnd += 1;
        break;
      }
      tagEnd += 1;
    }
    cursor = Math.max(tagEnd, tagStart + 1);
  }

  const text = characters.join('');
  return {
    text,
    offsetForTextIndex(index) {
      const safeIndex = Math.max(0, Math.min(characters.length, Math.floor(Number(index) || 0)));
      return safeIndex < offsets.length ? offsets[safeIndex] : end;
    },
    textIndexForOffset(offset) {
      if (!ends.length) return 0;
      const safeOffset = Math.max(start, Math.min(end, Number(offset) || 0));
      let low = 0;
      let high = ends.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (ends[middle] <= safeOffset) low = middle + 1;
        else high = middle;
      }
      return low;
    },
  };
}

function frameTextMap(doc) {
  const entries = [];
  let text = '';
  if (!doc?.body) return { text, pointForTextIndex: () => null, textIndexForPoint: () => null };
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script, style, noscript, template')) continue;
    const value = node.data || '';
    entries.push({ node, start: text.length, end: text.length + value.length });
    text += value;
  }
  return {
    text,
    pointForTextIndex(index) {
      if (!entries.length) return null;
      const safeIndex = Math.max(0, Math.min(text.length, Math.floor(Number(index) || 0)));
      const entry = entries.find((item) => safeIndex < item.end) || entries.at(-1);
      return { node: entry.node, offset: Math.max(0, Math.min(entry.node.data.length, safeIndex - entry.start)) };
    },
    textIndexForPoint(node, offset) {
      const entry = entries.find((item) => item.node === node);
      if (!entry) return null;
      return entry.start + Math.max(0, Math.min(entry.node.data.length, Number(offset) || 0));
    },
  };
}

function firstVisibleFrameTextPoint(doc) {
  if (!doc?.body) return null;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const viewportWidth = doc.documentElement?.clientWidth || doc.body.clientWidth || 1;
  const viewportHeight = doc.documentElement?.clientHeight || 0;
  let node;
  while ((node = walker.nextNode())) {
    if (!node.data?.trim() || node.parentElement?.closest('script, style, noscript, template')) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((rect) => rect.height > 0);
    for (const rect of rects) {
      if (rect.bottom <= 0) continue;
      if (rect.top >= viewportHeight) break;
      const x = Math.max(1, Math.min(viewportWidth - 1, (Math.max(0, rect.left) + Math.min(viewportWidth, rect.right)) / 2));
      const y = Math.max(1, Math.min(viewportHeight - 1, Math.max(0, rect.top) + 1));
      const caret = doc.caretRangeFromPoint?.(x, y);
      if (caret?.startContainer && doc.body.contains(caret.startContainer)) {
        return { node: caret.startContainer, offset: caret.startOffset };
      }
      const position = doc.caretPositionFromPoint?.(x, y);
      if (position?.offsetNode && doc.body.contains(position.offsetNode)) {
        return { node: position.offsetNode, offset: position.offset };
      }
      return { node, offset: 0 };
    }
  }
  return null;
}

function caretRectInFrame(iframe, node, offset) {
  const doc = iframe?.contentDocument;
  if (!doc?.body || !node || !doc.body.contains(node)) return null;
  try {
    const caret = doc.createRange();
    caret.setStart(node, offset);
    caret.collapse(true);
    return caret.getBoundingClientRect() || null;
  } catch {
    return null;
  }
}

function caretVisibleInFrame(iframe, node, offset) {
  const doc = iframe?.contentDocument;
  const rect = caretRectInFrame(iframe, node, offset);
  if (!rect) return false;
  const viewportHeight = doc.documentElement?.clientHeight || 0;
  return rect.bottom >= 0 && rect.top <= viewportHeight;
}

function currentFramePoint(iframe) {
  const doc = iframe?.contentDocument;
  if (!doc?.body) return null;
  const selection = iframe.contentWindow?.getSelection();
  const selectedNode = selection?.focusNode || selection?.anchorNode;
  if (selectedNode && doc.body.contains(selectedNode)) {
    const offset = selection.focusNode ? selection.focusOffset : selection.anchorOffset;
    const rect = caretRectInFrame(iframe, selectedNode, offset);
    const viewportHeight = doc.documentElement?.clientHeight || 0;
    const caretVisible = Boolean(rect) && rect.bottom >= 0 && rect.top <= viewportHeight;
    if (frameKind === 'preview' && selectedNode.nodeType === Node.TEXT_NODE && caretVisible) return { node: selectedNode, offset };
    if (frameKind !== 'preview' && caretVisible) return { node: selectedNode, offset };
  }
  const visiblePoint = firstVisibleFrameTextPoint(doc);
  if (visiblePoint) return visiblePoint;
  const width = doc.documentElement?.clientWidth || doc.body.clientWidth || 1;
  const x = Math.max(1, Math.min(width - 1, width / 2));
  const range = doc.caretRangeFromPoint?.(x, 1);
  if (range?.startContainer && doc.body.contains(range.startContainer)) {
    return { node: range.startContainer, offset: range.startOffset };
  }
  const position = doc.caretPositionFromPoint?.(x, 1);
  if (position?.offsetNode && doc.body.contains(position.offsetNode)) {
    return { node: position.offsetNode, offset: position.offset };
  }
  return null;
}

function scrollFrameToPoint(iframe, point) {
  const doc = iframe?.contentDocument;
  if (!doc?.body || !point?.node || !doc.body.contains(point.node)) return false;
  const range = doc.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  if (frameKind === 'preview') {
    const selection = iframe.contentWindow?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    iframe.contentWindow?.focus();
  }
  const rect = range.getBoundingClientRect();
  const scrolling = doc.scrollingElement || doc.documentElement;
  if (rect && (rect.top || rect.bottom)) {
    const targetTop = frameKind === 'reader' ? 0 : Math.max(0, scrolling.clientHeight * .35);
    scrolling.scrollTop += rect.top - targetTop;
  } else {
    point.node.parentElement?.scrollIntoView({ block: 'center' });
  }
  return true;
}

function captureCurrentViewLocation() {
  if (!state.book || !state.activePath) return null;
  const source = state.book.getText(state.activePath) || '';
  if (editor) {
    const offset = editor.selection.start;
    return { path: state.activePath, offset, percent: source.length ? offset / source.length * 100 : 0 };
  }
  if (!activeFrame || !isHtmlPath(state.activePath)) return null;
  const doc = activeFrame.contentDocument;
  const scrolling = doc?.scrollingElement || doc?.documentElement;
  const total = Math.max(1, (scrolling?.scrollHeight || 0) - (scrolling?.clientHeight || 0));
  const percent = Math.max(0, Math.min(100, (scrolling?.scrollTop || 0) / total * 100));
  if (frameViewAnchor?.path === state.activePath) {
    if (frameKind === 'reader' && Math.abs((scrolling?.scrollTop || 0) - frameViewAnchor.scrollTop) <= 1) {
      return { path: state.activePath, offset: frameViewAnchor.sourceOffset, percent };
    }
    if (frameKind === 'preview') {
      const selection = activeFrame.contentWindow?.getSelection();
      const node = selection?.focusNode || selection?.anchorNode;
      const offset = selection?.focusNode ? selection.focusOffset : selection?.anchorOffset;
      if (node === frameViewAnchor.node && offset === frameViewAnchor.offset && caretVisibleInFrame(activeFrame, node, offset)) {
        return { path: state.activePath, offset: frameViewAnchor.sourceOffset, percent };
      }
    }
  }
  const point = currentFramePoint(activeFrame);
  let offset = null;
  if (point) {
    const frameMap = frameTextMap(doc);
    const textIndex = frameMap.textIndexForPoint(point.node, point.offset);
    if (textIndex !== null) offset = sourceBodyTextMap(source).offsetForTextIndex(textIndex);
  }
  if (!Number.isFinite(offset)) offset = Math.round(source.length * percent / 100);
  return { path: state.activePath, offset, percent };
}

function rememberViewLocationForPath(path = state.activePath) {
  const location = captureCurrentViewLocation();
  const key = normalizePath(path);
  if (key && location) resourceViewLocations.set(key, location);
  return location;
}

function recallViewLocationForPath(path) {
  return resourceViewLocations.get(normalizePath(path)) || null;
}

function forgetViewLocationForPath(path) {
  resourceViewLocations.delete(normalizePath(path));
}

function restoreViewLocation(location) {
  if (!location || location.path !== state.activePath || state.pendingReveal) return false;
  if (editor) {
    pendingViewLocation = null;
    editor.scrollToOffset(location.offset, { focus: true });
    return true;
  }
  if (!activeFrame) return false;
  const doc = activeFrame.contentDocument;
  if (!doc?.body || !doc.getElementById('epub-studio-runtime-style')) return false;
  const source = state.book.getText(state.activePath) || '';
  const textIndex = sourceBodyTextMap(source).textIndexForOffset(location.offset);
  const point = frameTextMap(doc).pointForTextIndex(textIndex);
  if (!point || !scrollFrameToPoint(activeFrame, point)) {
    const scrolling = doc.scrollingElement || doc.documentElement;
    const total = Math.max(0, scrolling.scrollHeight - scrolling.clientHeight);
    scrolling.scrollTop = total * Number(location.percent || 0) / 100;
  }
  const scrolling = doc.scrollingElement || doc.documentElement;
  frameViewAnchor = {
    path: state.activePath,
    sourceOffset: location.offset,
    frameKind,
    node: point?.node || null,
    offset: point?.offset || 0,
    scrollTop: scrolling.scrollTop || 0,
  };
  pendingViewLocation = null;
  return true;
}

function renderDocument() {
  editor?.destroy();
  elements.documentHost.innerHTML = '';
  editor = null;
  activeFrame = null;
  frameKind = '';
  frameViewAnchor = null;
  const modeButtons = $$('.mode-switch button');
  const htmlResource = isHtmlPath(state.activePath);
  modeButtons.forEach((button) => {
    button.disabled = !htmlResource;
    button.classList.toggle('active', htmlResource && button.dataset.mode === state.mode);
  });
  elements.formatToolbar.hidden = !(htmlResource && state.mode === 'preview');
  if (!state.book) return;
  if (!state.activePath || !state.book.getResource(state.activePath)) {
    elements.documentHost.innerHTML = '<div class="document-empty"><div class="empty-state"><strong>选择一本书中的资源</strong><p>从左侧书籍浏览器打开章节、样式表或媒体文件。</p></div></div>';
    elements.resourceKind.textContent = '';
    return;
  }

  const resource = state.book.getResource(state.activePath);
  const item = state.book.getManifestByPath(state.activePath);
  elements.resourceKind.textContent = item?.mediaType || resource.mediaType || mimeForPath(state.activePath);
  if (isHtmlPath(state.activePath) && state.mode === 'preview') {
    renderPreviewEditor();
  } else if (isHtmlPath(state.activePath) && state.mode === 'read') {
    renderReader();
  } else if (resource.text !== null && resource.text !== undefined) {
    renderCodeEditor();
  } else {
    renderMediaViewer();
  }
  updateSpinePosition();
  schedulePendingReveal();
}

function editorModeForPath(filePath) {
  const ext = extension(filePath);
  if (ext === 'css') return 'css';
  if (['js', 'mjs', 'json'].includes(ext)) return 'javascript';
  return 'xml';
}

function renderCodeEditor() {
  const resource = state.book.getResource(state.activePath);
  if (!resource || resource.text === null) return;
  let source = resource.text;
  if (isHtmlPath(state.activePath) && isMinifiedMarkup(source)) {
    const formatted = formatMarkup(source);
    if (formatted && formatted !== source) {
      state.book.setText(state.activePath, formatted);
      source = formatted;
      updateDirtyStatus();
      renderDocumentTabs();
      toast('HTML 已自动换行', '压缩的单行源码已按 Sigil 风格格式化。', 'info');
    }
  }
  editor = new CodeEditor({
    mode: editorModeForPath(state.activePath),
    lineWrapping: state.settings.lineWrapping,
    onChange: (value) => {
      state.book.setText(state.activePath, value);
      updateDirtyStatus();
      updateTabsDirtyIndicator();
    },
  });
  editor.setValue(source);
  editor.addEventListener('caret', (event) => {
    const before = editor.getValue().slice(0, event.detail.start);
    const lines = before.split('\n');
    const line = lines.length;
    const column = lines.at(-1).length + 1;
    elements.statusLocation.textContent = `行 ${line}, 列 ${column}`;
  });
  elements.documentHost.append(editor.element);
  restoreViewLocation(pendingViewLocation);
}

function updateTabsDirtyIndicator() {
  const activeTab = $('.document-tab.active');
  if (!activeTab) return;
  let dot = $('.dirty-dot', activeTab);
  if (state.book.dirty && !dot) {
    dot = document.createElement('span');
    dot.className = 'dirty-dot';
    activeTab.insertBefore(dot, activeTab.lastElementChild);
  } else if (!state.book.dirty && dot) {
    dot.remove();
  }
}

function parseResourceDocument(filePath, text = null) {
  return parseXml(text ?? state.book.getText(filePath), 'text/html');
}

function clearAssetCache() {
  for (const url of state.assetUrls.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  state.assetUrls.clear();
  state.reverseAssetUrls.clear();
}

function assetUrl(filePath) {
  const normalized = normalizePath(filePath);
  if (state.assetUrls.has(normalized)) return state.assetUrls.get(normalized);
  const resource = state.book.getResource(normalized);
  if (!resource) return '';
  let bytes = resource.bytes;
  let mediaType = resource.mediaType || mimeForPath(normalized);
  if (resource.text !== null && isCssPath(normalized)) {
    const rewritten = rewriteCssResourceUrls(resource.text, normalized);
    bytes = new TextEncoder().encode(rewritten);
    mediaType = 'text/css';
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  state.assetUrls.set(normalized, url);
  state.reverseAssetUrls.set(url, normalized);
  return url;
}

function rewriteCssResourceUrls(css, cssPath) {
  return String(css || '')
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
      if (/^(data:|blob:|https?:|#)/i.test(value)) return match;
      const resolved = resolveHref(cssPath, value.trim());
      const url = resolved.path ? assetUrl(resolved.path) : '';
      return url ? `url("${url}")` : match;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, value) => {
      if (/^(data:|blob:|https?:)/i.test(value)) return match;
      const resolved = resolveHref(cssPath, value);
      const url = resolved.path ? assetUrl(resolved.path) : '';
      return url ? `@import ${quote}${url}${quote}` : match;
    });
}

function reverseRuntimeUrls(text) {
  let result = String(text || '');
  const entries = [...state.reverseAssetUrls].sort((a, b) => b[0].length - a[0].length);
  for (const [url, targetPath] of entries) {
    result = result.replaceAll(url, relativeHref(state.activePath, targetPath));
  }
  return result;
}

function serializeHtmlDocument(documentNode) {
  let source = serializeXml(documentNode);
  source = source.replace(/^<\?xml[^>]*\?>\s*/i, '');
  source = source.replace(/<!--\?xml[\s\S]*?-->\s*/i, '');
  source = source.replace(/<!DOCTYPE[^>]*>\s*/gi, '');
  return `<!DOCTYPE html>\n${source}`;
}

function buildRenderedDocument(filePath, { editable = false } = {}) {
  const doc = parseResourceDocument(filePath);
  const isXhtml = extension(filePath) === 'xhtml';
  for (const element of descendants(doc.documentElement)) {
    for (const attribute of ['src', 'poster']) {
      const value = element.getAttribute?.(attribute);
      if (!value || /^(data:|blob:|https?:|#)/i.test(value)) continue;
      const resolved = resolveHref(filePath, value);
      if (resolved.path && state.book.getResource(resolved.path)) element.setAttribute(attribute, assetUrl(resolved.path));
    }
    const xlink = element.getAttribute?.('xlink:href');
    if (xlink && !/^(data:|blob:|https?:|#)/i.test(xlink)) {
      const resolved = resolveHref(filePath, xlink);
      if (resolved.path && state.book.getResource(resolved.path)) element.setAttribute('xlink:href', assetUrl(resolved.path));
    }
    if (element.localName === 'link') {
      const rel = (element.getAttribute('rel') || '').toLocaleLowerCase();
      const href = element.getAttribute('href') || '';
      if (rel.split(/\s+/).includes('stylesheet') && href && !/^(https?:|data:|blob:)/i.test(href)) {
        const resolved = resolveHref(filePath, href);
        if (state.book.getResource(resolved.path)) element.setAttribute('href', assetUrl(resolved.path));
      }
    }
  }
  if (editable && doc.body) {
    doc.body.setAttribute('contenteditable', 'true');
    doc.body.setAttribute('spellcheck', String(Boolean(state.settings.spellcheck)));
  }
  const style = doc.createElement('style');
  style.id = 'epub-studio-runtime-style';
  style.textContent = `
    :root { font-size: ${Number(state.settings.fontSize) || 18}px; }
    html { min-height: 100%; }
    body { min-height: 100%; max-width: ${editable ? 'none' : `${Number(state.settings.readingWidth) || 760}px`}; margin-inline: auto; }
    body[contenteditable="true"] { outline: none; caret-color: currentColor; }
    [data-studio-selected="true"] { outline: 2px solid #26a98a !important; outline-offset: 2px; }
    ::selection { background: rgba(38, 169, 138, .28); }
  `;
  doc.head?.append(style);
  return serializeHtmlDocument(doc);
}

function renderPreviewEditor() {
  const shell = document.createElement('div');
  shell.className = 'preview-shell';
  shell.innerHTML = `
    <iframe class="preview-frame" sandbox="allow-same-origin" title="预览文本编辑器"></iframe>
    <div class="preview-hint active">可视化编辑已启用 · 点击元素可用 Inspector 修改属性，所有更改即时同步到 XHTML</div>`;
  elements.documentHost.append(shell);
  const iframe = $('.preview-frame', shell);
  activeFrame = iframe;
  frameKind = 'preview';
  iframe.addEventListener('load', () => attachFrameBehavior(iframe, true));
  iframe.srcdoc = buildRenderedDocument(state.activePath, { editable: true });
}

function renderReader() {
  const shell = document.createElement('div');
  shell.className = 'reader-shell';
  shell.innerHTML = `
    <iframe class="reader-frame" sandbox="allow-same-origin" title="阅读模式"></iframe>
    <div class="reader-controls">
      <button data-command="spine-prev">上一节</button>
      <span>阅读宽度</span>
      <input type="range" id="reading-width" min="520" max="1100" step="20" value="${Number(state.settings.readingWidth)}">
      <button data-command="bookmark-add">添加书签</button>
      <button data-command="spine-next">下一节</button>
    </div>`;
  elements.documentHost.append(shell);
  const iframe = $('.reader-frame', shell);
  activeFrame = iframe;
  frameKind = 'reader';
  iframe.addEventListener('load', () => attachFrameBehavior(iframe, false));
  iframe.srcdoc = buildRenderedDocument(state.activePath, { editable: false });
  $('#reading-width', shell).addEventListener('change', async (event) => {
    await updateSettings({ readingWidth: Number(event.target.value) });
    renderDocument();
  });
}

function attachFrameBehavior(iframe, editable) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  schedulePendingReveal({ frameReady: true, iframe });
  const restored = restoreViewLocation(pendingViewLocation);
  doc.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      activateSearchPanel(event.shiftKey);
    }
  }, true);
  doc.addEventListener('click', async (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (anchor) {
      event.preventDefault();
      const href = anchor.getAttribute('href') || '';
      const resolved = resolveHref(state.activePath, href);
      if (resolved.external) await window.studio.openExternal(resolved.path);
      else if (resolved.path) openResource(resolved.path, { hash: resolved.hash });
      return;
    }
    if (editable) selectInspectorElement(event.target);
  });
  if (editable) {
    if (!restored) doc.body?.focus();
    doc.addEventListener('keydown', handleEditorShortcut, true);
    const scheduleFrameSync = () => {
      clearTimeout(frameInputTimer);
      frameInputTimer = setTimeout(() => {
        syncFrameToBook();
        updateDirtyStatus();
        updateTabsDirtyIndicator();
      }, 120);
    };
    doc.addEventListener('compositionstart', () => clearTimeout(frameInputTimer));
    doc.addEventListener('compositionend', scheduleFrameSync);
    doc.addEventListener('input', (event) => {
      if (!event.isComposing) scheduleFrameSync();
    });
    doc.addEventListener('selectionchange', () => {
      const selection = iframe.contentWindow?.getSelection();
      if (selection && selection.rangeCount) {
        const node = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
        if (node) elements.statusLocation.textContent = nodePath(node).slice(-2).join(' › ');
      }
    });
  } else {
    doc.addEventListener('scroll', () => {
      clearTimeout(readProgressTimer);
      readProgressTimer = setTimeout(() => {
        const scrolling = doc.scrollingElement || doc.documentElement;
        const total = Math.max(1, scrolling.scrollHeight - scrolling.clientHeight);
        elements.statusLocation.textContent = `阅读进度 ${Math.round((scrolling.scrollTop / total) * 100)}%`;
      }, 100);
    }, true);
  }
}

function nodePath(node) {
  const path = [];
  let current = node;
  while (current && current.nodeType === Node.ELEMENT_NODE && current.localName !== 'html') {
    let label = current.localName;
    if (current.id) label += `#${current.id}`;
    else if (current.classList?.length) label += `.${[...current.classList].slice(0, 2).join('.')}`;
    path.unshift(label);
    current = current.parentElement;
  }
  return path;
}

function selectInspectorElement(element) {
  if (!(element instanceof Element) || element.closest('#epub-studio-runtime-style')) return;
  state.selectedElement?.removeAttribute?.('data-studio-selected');
  state.selectedElement = element;
  element.setAttribute('data-studio-selected', 'true');
  if (state.rightPanel !== 'inspector') state.rightPanel = 'inspector';
  state.rightVisible = true;
  renderRightSidebar();
}

function serializeFrameDocument(iframe) {
  const doc = iframe.contentDocument;
  if (!doc) return '';
  const clone = doc.cloneNode(true);
  const runtimeStyle = clone.getElementById('epub-studio-runtime-style');
  runtimeStyle?.remove();
  const body = clone.body;
  body?.removeAttribute('contenteditable');
  body?.removeAttribute('spellcheck');
  for (const element of descendants(clone.documentElement)) element.removeAttribute?.('data-studio-selected');
  let source = serializeHtmlDocument(clone);
  source = reverseRuntimeUrls(source);
  return source;
}

function syncFrameToBook() {
  if (!activeFrame || frameKind !== 'preview' || !state.activePath) return;
  const source = serializeFrameDocument(activeFrame);
  if (source && source !== state.book.getText(state.activePath)) {
    state.book.setText(state.activePath, source);
    updateDirtyStatus();
  }
}

function renderMediaViewer() {
  const resource = state.book.getResource(state.activePath);
  const url = assetUrl(state.activePath);
  const mediaType = resource.mediaType || mimeForPath(state.activePath);
  if (mediaType.startsWith('image/')) {
    elements.documentHost.innerHTML = `<div class="media-viewer"><div class="media-toolbar"><span>${escapeHtml(mediaType)} · ${formatBytes(resource.bytes.byteLength)}</span><span class="toolbar-spacer"></span><button class="mini-button" data-command="zoom-reset">适应窗口</button></div><div class="media-content"><img src="${url}" alt="${escapeHtml(basename(state.activePath))}"></div></div>`;
    return;
  }
  if (mediaType.startsWith('audio/')) {
    elements.documentHost.innerHTML = `<div class="media-viewer"><div class="media-toolbar">${escapeHtml(mediaType)}</div><div class="media-content"><audio controls src="${url}"></audio></div></div>`;
    return;
  }
  if (mediaType.startsWith('video/')) {
    elements.documentHost.innerHTML = `<div class="media-viewer"><div class="media-toolbar">${escapeHtml(mediaType)}</div><div class="media-content"><video controls src="${url}"></video></div></div>`;
    return;
  }
  if (mediaType === 'application/pdf') {
    elements.documentHost.innerHTML = `<div class="media-viewer"><div class="media-toolbar">PDF</div><div class="media-content"><iframe src="${url}" title="PDF 预览"></iframe></div></div>`;
    return;
  }
  elements.documentHost.innerHTML = `<div class="media-viewer"><div class="media-content"><div class="binary-file-card"><h2>${escapeHtml(basename(state.activePath))}</h2><p>${escapeHtml(mediaType)} · ${formatBytes(resource.bytes.byteLength)}</p><p>此资源没有内置可视化编辑器。</p></div></div></div>`;
}

function activePreviewFrame() {
  if (!activeFrame || frameKind !== 'preview') {
    toast('请切换到预览编辑模式', '格式操作只作用于可视化正文。', 'warning');
    return null;
  }
  return activeFrame;
}

async function editorCommand(command) {
  if (activeFrame && frameKind === 'preview') {
    activeFrame.contentWindow.focus();
    activeFrame.contentDocument.execCommand(command, false, null);
    syncFrameToBook();
    return;
  }
  if (editor?.textarea) {
    editor.focus();
    document.execCommand(command, false, null);
    return;
  }
  document.execCommand(command, false, null);
}

async function pasteAtSelection() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    insertTextAtSelection(text);
  } catch (error) {
    toast('无法读取剪贴板', '请使用系统快捷键 ⌘/Ctrl+V。', 'warning');
  }
}

function applySourceFormat(command, value = '') {
  if (!editor?.textarea || !isHtmlPath(state.activePath)) return false;
  const selection = editor.selection;
  const source = selection.text.trim();
  if (!source) {
    toast('请先选择文本', 'HTML 编辑模式下需要选中文本或完整的段落标签。', 'warning');
    return true;
  }
  let replacement = source;
  if (command === 'formatBlock') {
    const tag = String(value || 'P').toLowerCase();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = source;
    if (wrapper.children.length === 1 && wrapper.childNodes.length === 1) {
      const current = wrapper.firstElementChild;
      const next = document.createElement(tag);
      for (const attribute of current.attributes) next.setAttribute(attribute.name, attribute.value);
      next.append(...current.childNodes);
      replacement = next.outerHTML;
    } else {
      replacement = `<${tag}>${source}</${tag}>`;
    }
  } else if (['justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'].includes(command)) {
    const alignment = { justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right', justifyFull: 'justify' }[command];
    const wrapper = document.createElement('div');
    wrapper.innerHTML = source;
    if (wrapper.children.length === 1 && wrapper.childNodes.length === 1) {
      wrapper.firstElementChild.style.textAlign = alignment;
      replacement = wrapper.firstElementChild.outerHTML;
    } else {
      replacement = `<p style="text-align: ${alignment}">${source}</p>`;
    }
  } else {
    const wrappers = {
      bold: ['strong', '</strong>'],
      italic: ['em', '</em>'],
      underline: ['u', '</u>'],
      strikeThrough: ['s', '</s>'],
      insertUnorderedList: ['ul><li', '</li></ul>'],
      insertOrderedList: ['ol><li', '</li></ol>'],
    };
    const selectedWrapper = wrappers[command];
    if (!selectedWrapper) return false;
    replacement = `<${selectedWrapper[0]}>${source}${selectedWrapper[1]}`;
  }
  editor.replaceRange(selection.start, selection.end, replacement);
  updateDirtyStatus();
  return true;
}

async function formatPreview(command, value = null) {
  if (editor?.textarea && isHtmlPath(state.activePath) && applySourceFormat(command, value)) return;
  const iframe = activePreviewFrame();
  if (!iframe) return;
  iframe.contentWindow.focus();
  iframe.contentDocument.execCommand(command, false, value);
  syncFrameToBook();
  updateDirtyStatus();
}

async function applyHeading(level) {
  const value = Number(level) > 0 ? `H${Number(level)}` : 'P';
  if (!(editor?.textarea && applySourceFormat('formatBlock', value))) await formatPreview('formatBlock', value);
  const select = $('[data-format-select="heading"]');
  if (select) select.value = String(level);
}

async function insertLink() {
  if (!activePreviewFrame()) return;
  const selection = activeFrame.contentWindow.getSelection()?.toString() || '';
  const result = await showModal({
    title: selection ? '为选中文本添加链接' : '插入链接',
    fields: [
      { name: 'href', label: '目标', value: '#', autofocus: true, required: true, help: '可以是章节相对路径、#id、https:// 或 mailto:' },
      { name: 'title', label: '提示文本', value: '' },
    ],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: '插入', kind: 'primary' }],
  });
  if (result.action !== 'ok') return;
  const href = escapeHtml(result.values.href);
  const title = result.values.title ? ` title="${escapeHtml(result.values.title)}"` : '';
  if (selection) activeFrame.contentDocument.execCommand('createLink', false, href);
  else activeFrame.contentDocument.execCommand('insertHTML', false, `<a href="${href}"${title}>${escapeHtml(result.values.href)}</a>`);
  syncFrameToBook();
}

async function insertImage(selectedPath = '') {
  const iframe = activePreviewFrame();
  if (!iframe) return;
  const images = state.book.manifestItems().filter((item) => item.mediaType.startsWith('image/'));
  if (!images.length) {
    toast('没有可用图片', '请先在图片管理器中添加图片资源。', 'warning');
    return;
  }
  let imagePath = images.some((item) => item.path === normalizePath(selectedPath)) ? normalizePath(selectedPath) : '';
  if (!imagePath) {
    const choice = await choiceDialog({
      title: '插入图片',
      message: '选择 EPUB 中已有的图片资源：',
      choices: images.slice(0, 80).map((item) => ({ label: basename(item.path), description: item.path, icon: '▧', value: item.path })),
    });
    if (!choice) return;
    imagePath = choice.value;
  }
  const alt = await promptDialog({ title: '替代文本', label: 'alt 文本', value: basename(imagePath).replace(/\.[^.]+$/, ''), required: false });
  if (alt === null) return;
  const href = relativeHref(state.activePath, imagePath);
  iframe.contentDocument.execCommand('insertHTML', false, `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"/>`);
  syncFrameToBook();
  updateDirtyStatus();
}

async function insertSpecialCharacter() {
  if (!activePreviewFrame() && !editor) return;
  const characters = ' ¡¢£¤¥§©®™°±×÷—–…‘’“”«»‹›†‡•‰′″€$£¥←↑→↓⇐⇒∞≠≤≥αβγδεζηθλμπρσφωΩ';
  const result = await showModal({
    title: '插入特殊字符',
    body: `<div class="character-grid">${[...characters].map((char) => `<button type="button" data-character="${escapeHtml(char)}">${escapeHtml(char === ' ' ? '␠' : char)}</button>`).join('')}</div>`,
    actions: [{ id: 'cancel', label: '关闭', kind: 'ghost' }],
    width: '620px',
    onMount(body, overlay, close) {
      body.addEventListener('click', (event) => {
        const button = event.target.closest('[data-character]');
        if (!button) return;
        insertTextAtSelection(button.dataset.character);
      });
    },
  });
  return result;
}

function insertTextAtSelection(text) {
  if (activeFrame && frameKind === 'preview') {
    activeFrame.contentDocument.execCommand('insertText', false, text);
    syncFrameToBook();
  } else if (editor) {
    editor.insertText(text);
  } else {
    navigator.clipboard?.writeText(text);
    toast('字符已复制', text);
  }
}

async function insertId() {
  if (!activePreviewFrame()) return;
  const selection = activeFrame.contentWindow.getSelection();
  let element = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection?.anchorNode?.parentElement;
  while (element && element !== activeFrame.contentDocument.body && element.nodeType !== Node.ELEMENT_NODE) element = element.parentElement;
  const suggested = element?.id || `id-${Date.now().toString(36)}`;
  const value = await promptDialog({ title: '插入 ID', label: '元素 ID', value: suggested });
  if (!value || !element) return;
  element.id = value;
  selectInspectorElement(element);
  syncFrameToBook();
}

async function insertSectionBreak() {
  if (!activePreviewFrame()) return;
  activeFrame.contentDocument.execCommand('insertHTML', false, '<hr class="epub-section-break" data-epub-section="true"/>');
  syncFrameToBook();
}

async function insertFootnote() {
  if (!activePreviewFrame()) return;
  const values = await showModal({
    title: '插入脚注引用',
    fields: [
      { name: 'id', label: '引用 ID', value: `fnref-${Date.now().toString(36)}`, required: true, autofocus: true },
      { name: 'href', label: '脚注目标', value: '#fn-1', required: true },
      { name: 'label', label: '显示文本', value: '[1]', required: true },
    ],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: '插入', kind: 'primary' }],
  });
  if (values.action !== 'ok') return;
  const { id, href, label } = values.values;
  activeFrame.contentDocument.execCommand('insertHTML', false, `<a epub:type="noteref" role="doc-noteref" id="${escapeHtml(id)}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
  syncFrameToBook();
}

async function changeCase(mode) {
  const transform = (value) => {
    if (mode === 'lower') return value.toLocaleLowerCase();
    if (mode === 'upper') return value.toLocaleUpperCase();
    if (mode === 'title') return value.replace(/\p{L}[\p{L}\p{N}'’-]*/gu, (word) => word[0].toLocaleUpperCase() + word.slice(1).toLocaleLowerCase());
    return value.replace(/(^|[.!?。！？]\s+)(\p{L})/gu, (match, prefix, char) => prefix + char.toLocaleUpperCase());
  };
  if (activeFrame && frameKind === 'preview') {
    const selection = activeFrame.contentWindow.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = transform(selection.toString());
    activeFrame.contentDocument.execCommand('insertText', false, text);
    syncFrameToBook();
  } else if (editor) {
    editor.insertText(transform(editor.selection.text));
  }
}

function wrapCodeSelection(html) {
  if (!editor || !editor.selection.text) return;
  editor.insertText(html(editor.selection.text));
}

async function toggleCode() {
  if (activeFrame && frameKind === 'preview') {
    const selection = activeFrame.contentWindow.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = escapeHtml(selection.toString());
    activeFrame.contentDocument.execCommand('insertHTML', false, `<code>${text}</code>`);
    syncFrameToBook();
  } else {
    wrapCodeSelection((value) => `<code>${escapeHtml(value)}</code>`);
  }
}

async function applySmartPunctuation() {
  if (activeFrame && frameKind === 'preview') {
    const selection = activeFrame.contentWindow.getSelection();
    if (!selection || selection.isCollapsed) return;
    activeFrame.contentDocument.execCommand('insertText', false, smartPunctuation(selection.toString()));
    syncFrameToBook();
  } else if (editor) {
    const selection = editor.selection;
    if (!selection.text) return;
    editor.replaceRange(selection.start, selection.end, smartPunctuation(selection.text));
  }
}

async function cleanInline() {
  if (!state.activePath || !isHtmlPath(state.activePath)) {
    toast('请先打开 HTML 章节', '', 'warning');
    return;
  }
  const doc = parseResourceDocument(state.activePath);
  cleanInlineStyles(doc.body || doc.documentElement);
  const source = serializeHtmlDocument(doc);
  state.book.setText(state.activePath, source);
  renderDocument();
  markDirty();
}

async function prettifyActive(cssOnly = false) {
  if (!state.activePath || !state.book.getResource(state.activePath)?.text) return;
  if (activeFrame) syncFrameToBook();
  const source = state.book.getText(state.activePath);
  const formatted = cssOnly || isCssPath(state.activePath) ? formatCss(source) : formatMarkup(source);
  state.book.setText(state.activePath, formatted);
  renderDocument();
  markDirty();
  toast('格式化完成', state.activePath);
}

async function splitSection() {
  const iframe = activePreviewFrame();
  if (!iframe) return;
  const selection = iframe.contentWindow.getSelection();
  let node = selection?.anchorNode;
  while (node && node.parentElement && node.parentElement !== iframe.contentDocument.body) node = node.parentElement;
  if (!node || node === iframe.contentDocument.body) {
    toast('无法拆分', '请把光标放在要作为新章节起始位置的块级元素中。', 'warning');
    return;
  }
  const body = iframe.contentDocument.body;
  const afterNodes = [];
  let cursor = node;
  while (cursor) {
    afterNodes.push(cursor);
    cursor = cursor.nextSibling;
  }
  if (!afterNodes.length) return;
  const afterBody = body.cloneNode(false);
  for (const item of afterNodes) item.remove(), afterBody.append(item);
  const currentSource = serializeHtmlDocument(iframe.contentDocument);
  state.book.setText(state.activePath, reverseRuntimeUrls(currentSource));
  const newDoc = parseResourceDocument(state.activePath, currentSource);
  const bodyClone = newDoc.body.cloneNode(false);
  for (const child of [...body.children]) bodyClone.append(child.cloneNode(true));
  bodyClone.replaceChildren(...[...afterBody.childNodes].map((child) => newDoc.importNode(child, true)));
  newDoc.body.replaceWith(bodyClone);
  const firstHeading = bodyClone.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim() || '新章节';
  const newSource = reverseRuntimeUrls(serializeHtmlDocument(newDoc));
  const created = state.book.createResource({ type: 'xhtml', targetPath: joinPath(dirname(state.book.opfPath), 'Text', `${uniqueId(state.book.manifestItems().map((item) => basename(item.path)), 'chapter')}.xhtml`), title: firstHeading, content: newSource, spine: true });
  const currentIndex = state.book.spineResources().findIndex((item) => item.item.path === state.activePath);
  const spine = state.book.spineResources();
  const createdRef = spine.find((item) => item.item.path === created.path);
  if (currentIndex >= 0 && createdRef) {
    const spineNode = state.book.opfDoc.documentElement.getElementsByTagNameNS('*', 'spine')[0];
    const createdNode = [...spineNode.children].find((child) => child.getAttribute('idref') === created.id);
    const anchorNode = [...spineNode.children][currentIndex + 1];
    if (createdNode && anchorNode) spineNode.insertBefore(createdNode, anchorNode);
  }
  state.book.dirty = true;
  state.book.packageDirty = true;
  state.openPaths.push(created.path);
  state.activePath = created.path;
  state.mode = 'preview';
  clearAssetCache();
  renderShell();
  toast('章节已拆分', firstHeading);
}

function renderTocPanel() {
  const entries = state.book?.toc || [];
  const renderEntries = (items, prefix = '') => items.map((entry, index) => {
    const key = prefix ? `${prefix}.${index}` : String(index);
    return `
      <div class="toc-item ${key === state.tocSelectedIndex ? 'selected' : ''}" style="--depth:${key.split('.').length - 1}">
        <button class="toc-link" data-toc-index="${key}" data-toc-action="jump" title="${escapeHtml(entry.path || entry.href || '')}">
          <span>${escapeHtml(entry.label || '未命名')}</span>
          <small>${escapeHtml(entry.external ? entry.href : `${entry.path}${entry.hash ? `#${entry.hash}` : ''}`)}</small>
        </button>
        <button class="row-action" data-toc-index="${key}" data-toc-action="select" title="选择">•••</button>
      </div>${entry.children?.length ? renderEntries(entry.children, key) : ''}`;
  }).join('');
  elements.rightContent.innerHTML = `
    <div class="panel-actions">
      <button class="mini-button" data-command="toc-add">新增</button>
      <button class="mini-button" data-command="toc-add-child">添加子项</button>
      <button class="mini-button" data-command="generate-toc">从标题生成</button>
      <button class="mini-button" data-command="toc-rename">编辑</button>
      <button class="mini-button danger" data-command="toc-delete">删除</button>
      <button class="mini-button" data-command="toc-up">↑</button>
      <button class="mini-button" data-command="toc-down">↓</button>
      <button class="mini-button" data-command="toc-outdent">←</button>
      <button class="mini-button" data-command="toc-indent">→</button>
    </div>
    <div class="toc-list">${renderEntries(entries) || '<div class="empty-state"><strong>目录为空</strong><p>添加目录项来组织章节层级。保存时会同步写入 EPUB 3 Nav 与 EPUB 2 NCX。</p><button class="button primary" data-command="toc-add">新增目录项</button></div>'}</div>`;
}

async function generateTocFromHeadings() {
  if (!state.book) return;
  if (activeFrame) syncFrameToBook();
  if (state.book.toc.length && !await confirmDialog({
    title: '从标题生成目录？',
    message: '现有目录将被正文中的 H1-H6 标题层级替换。带有 sigil_not_in_toc 或 epub-studio-not-in-toc 类的标题会被跳过。',
    confirmLabel: '生成目录',
  })) return;
  const result = await runAction('生成目录', async () => state.book.generateTocFromHeadings());
  if (!result) return;
  if (!result.count) {
    toast('未找到可用标题', '请在正文中添加 H1-H6 标题后重试。', 'warning');
    return;
  }
  state.tocSelectedIndex = '';
  state.rightPanel = 'toc';
  state.rightVisible = true;
  state.book.dirty = true;
  state.book.packageDirty = true;
  renderShell();
  updateDirtyStatus();
  toast('目录已生成', `${result.count} 个标题`);
}

function tocLocation(index) {
  if (index === '' || index === undefined || index === null) return null;
  const parts = String(index).split('.').map(Number);
  let list = state.book.toc;
  let parent = null;
  let entry = null;
  for (const part of parts) {
    if (!list?.[part]) return null;
    parent = entry;
    entry = list[part];
    list = entry.children || [];
  }
  return { entry, parent, siblings: parent ? parent.children : state.book.toc, position: parts.at(-1) };
}

function touchToc() {
  state.book.dirty = true;
  state.book.packageDirty = true;
  updateDirtyStatus();
  renderTocPanel();
}

async function jumpToc(index) {
  const location = tocLocation(index);
  if (!location?.entry) return;
  const entry = location.entry;
  if (entry.external) {
    await window.studio.openExternal(entry.path || entry.href);
    return;
  }
  if (!entry.path) return;
  if (isHtmlPath(entry.path)) state.mode = state.mode === 'read' ? 'read' : 'preview';
  openResource(entry.path, { hash: entry.hash });
}

async function editTocEntry(forcedIndex = null) {
  if (!state.book) return;
  const index = forcedIndex ?? state.tocSelectedIndex;
  const location = tocLocation(index);
  const entry = location?.entry;
  const htmlPaths = state.book.manifestItems().filter((item) => isHtmlPath(item.path));
  const currentPath = entry?.path || state.activePath || htmlPaths[0]?.path || '';
  const result = await showModal({
    title: entry ? '编辑目录项' : '新增目录项',
    fields: [
      { name: 'label', label: '标题', value: entry?.label || '', required: true, autofocus: true },
      { name: 'path', label: '目标文档', type: 'select', value: currentPath, options: htmlPaths.map((item) => ({ value: item.path, label: `${item.id} · ${item.path}` })) },
      { name: 'hash', label: '锚点 ID', value: entry?.hash || '', help: '可选，不包含 #' },
      { name: 'id', label: '目录项 ID', value: entry?.id || `toc-${Date.now().toString(36)}` },
    ],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: entry ? '保存' : '添加', kind: 'primary' }],
  });
  if (result.action !== 'ok') return;
  const value = {
    id: result.values.id || '',
    label: result.values.label.trim(),
    path: normalizePath(result.values.path),
    hash: result.values.hash.replace(/^#/, ''),
    href: '',
    external: false,
    children: entry?.children || [],
  };
  if (entry) Object.assign(entry, value);
  else state.book.toc.push(value);
  state.tocSelectedIndex = entry ? index : String(state.book.toc.length - 1);
  touchToc();
}

async function addTocChild() {
  const location = tocLocation(state.tocSelectedIndex);
  if (!location) {
    await editTocEntry(null);
    return;
  }
  const child = { id: `toc-${Date.now().toString(36)}`, label: '新目录项', path: state.activePath, hash: '', href: '', external: false, children: [] };
  location.entry.children ||= [];
  location.entry.children.push(child);
  state.tocSelectedIndex = `${state.tocSelectedIndex}.${location.entry.children.length - 1}`;
  touchToc();
}

async function renameTocEntry() {
  const location = tocLocation(state.tocSelectedIndex);
  if (!location) { toast('请先选择目录项', '', 'warning'); return; }
  const label = await promptDialog({ title: '重命名目录项', label: '标题', value: location.entry.label });
  if (label === null) return;
  location.entry.label = label;
  touchToc();
}

async function deleteTocEntry() {
  const location = tocLocation(state.tocSelectedIndex);
  if (!location) { toast('请先选择目录项', '', 'warning'); return; }
  if (!await confirmDialog({ title: '删除目录项？', message: `将删除“${location.entry.label}”及其所有子项，正文文件不会被删除。`, confirmLabel: '删除', danger: true })) return;
  location.siblings.splice(location.position, 1);
  state.tocSelectedIndex = '';
  touchToc();
}

function moveToc(direction) {
  const location = tocLocation(state.tocSelectedIndex);
  if (!location) return;
  const next = location.position + direction;
  if (next < 0 || next >= location.siblings.length) return;
  const [entry] = location.siblings.splice(location.position, 1);
  location.siblings.splice(next, 0, entry);
  const parts = state.tocSelectedIndex.split('.');
  parts[parts.length - 1] = String(next);
  state.tocSelectedIndex = parts.join('.');
  touchToc();
}

function indentToc() {
  const location = tocLocation(state.tocSelectedIndex);
  if (!location || location.position === 0) return;
  const previous = location.siblings[location.position - 1];
  const [entry] = location.siblings.splice(location.position, 1);
  previous.children ||= [];
  previous.children.push(entry);
  state.tocSelectedIndex = `${state.tocSelectedIndex.split('.').slice(0, -1).join('.')}${state.tocSelectedIndex.includes('.') ? '.' : ''}${location.position - 1}.${previous.children.length - 1}`.replace(/^\./, '');
  touchToc();
}

function outdentToc() {
  const location = tocLocation(state.tocSelectedIndex);
  if (!location?.parent) return;
  const parentLocation = tocLocation(state.tocSelectedIndex.split('.').slice(0, -1).join('.'));
  if (!parentLocation) return;
  const [entry] = location.siblings.splice(location.position, 1);
  parentLocation.siblings.splice(parentLocation.position + 1, 0, entry);
  state.tocSelectedIndex = state.tocSelectedIndex.split('.').slice(0, -1).join('.');
  touchToc();
}

function bookmarkStorageKey(book) {
  return `epub-studio:bookmarks:${book.getMetadataValue('identifier') || `${book.info.title}:${book.path || 'untitled'}`}`;
}

function loadBookmarks(book) {
  try { return JSON.parse(localStorage.getItem(bookmarkStorageKey(book)) || '[]'); }
  catch { return []; }
}

function persistBookmarks() {
  if (!state.book) return;
  localStorage.setItem(bookmarkStorageKey(state.book), JSON.stringify(state.bookmarks));
}

function renderBookmarksPanel() {
  elements.rightContent.innerHTML = `
    <div class="panel-actions">
      <button class="mini-button" data-command="bookmark-add">添加当前位置</button>
      <button class="mini-button" data-command="bookmark-import">导入</button>
      <button class="mini-button" data-command="bookmark-export">导出</button>
    </div>
    <div class="bookmark-list">${state.bookmarks.map((bookmark) => `
      <div class="bookmark-item">
        <button class="bookmark-link" data-bookmark-id="${bookmark.id}" data-bookmark-action="jump">
          <span>${escapeHtml(bookmark.label)}</span>
          <small>${escapeHtml(bookmark.path)}${bookmark.hash ? `#${escapeHtml(bookmark.hash)}` : ''} · ${Math.round(bookmark.percent || 0)}%</small>
        </button>
        <button class="row-action" data-bookmark-id="${bookmark.id}" data-bookmark-action="rename" title="重命名">✎</button>
        <button class="row-action" data-bookmark-id="${bookmark.id}" data-bookmark-action="delete" title="删除">×</button>
      </div>`).join('') || '<div class="empty-state"><strong>还没有书签</strong><p>在阅读模式或预览模式定位到正文后添加书签，可重命名、排序持久化，并导出 JSON。</p></div>'}</div>`;
}

function currentReadingLocation() {
  const doc = activeFrame?.contentDocument;
  const path = state.activePath;
  if (!doc || !path) return null;
  const scrolling = doc.scrollingElement || doc.documentElement;
  const scrollTop = scrolling.scrollTop || 0;
  const total = Math.max(1, scrolling.scrollHeight - scrolling.clientHeight);
  const percent = Math.max(0, Math.min(100, scrollTop / total * 100));
  const elementsInView = descendants(doc.body).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top <= 100 && rect.bottom > 0 && element.id;
  });
  const hash = elementsInView.at(-1)?.id || '';
  return { path, hash, percent };
}

function currentChapterTitle(location) {
  if (!state.book || !location?.path) return '';
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const tocEntries = flattenToc(state.book.toc || []);
  const matchingToc = tocEntries.filter((entry) => entry.path === location.path);
  const exactToc = location.hash
    ? matchingToc.find((entry) => entry.hash === location.hash)
    : null;

  let doc = activeFrame?.contentDocument;
  if (!doc && isHtmlPath(location.path)) {
    try { doc = parseResourceDocument(location.path); }
    catch { doc = null; }
  }
  const documentTitle = clean(doc?.querySelector?.('title')?.textContent);
  const headingTitle = clean(doc?.querySelector?.('h1, h2, h3, h4, h5, h6')?.textContent);
  const tocTitle = clean(exactToc?.label || matchingToc.find((entry) => !entry.hash)?.label || matchingToc[0]?.label);
  return documentTitle || headingTitle || tocTitle;
}

async function addBookmark() {
  if (!state.book || !state.activePath) return;
  const location = currentReadingLocation();
  if (!location) {
    toast('无法获取位置', '请先打开章节并切换到阅读或预览模式。', 'warning');
    return;
  }
  const suggested = currentChapterTitle(location).slice(0, 60);
  const label = await promptDialog({ title: '添加书签', label: '书签名称', value: suggested, required: false });
  if (label === null) return;
  const bookmarkLabel = String(label).trim();
  state.bookmarks.push({ id: uuid(), label: bookmarkLabel, ...location, createdAt: new Date().toISOString(), order: state.bookmarks.length });
  persistBookmarks();
  state.rightPanel = 'bookmarks';
  state.rightVisible = true;
  renderShell();
  toast('书签已添加', bookmarkLabel);
}

async function jumpBookmark(id) {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  if (isHtmlPath(bookmark.path)) state.mode = 'read';
  openResource(bookmark.path, { hash: bookmark.hash, percent: bookmark.percent });
}

async function renameBookmark(id) {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  const label = await promptDialog({ title: '重命名书签', label: '书签名称', value: bookmark.label, required: false });
  if (label === null) return;
  bookmark.label = label;
  persistBookmarks();
  renderBookmarksPanel();
}

async function removeBookmark(id) {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  if (!await confirmDialog({ title: '删除书签？', message: `将删除“${bookmark.label}”。`, confirmLabel: '删除', danger: true })) return;
  state.bookmarks = state.bookmarks.filter((item) => item.id !== id);
  persistBookmarks();
  renderBookmarksPanel();
}

async function exportBookmarks() {
  if (!state.bookmarks.length) { toast('暂无书签可导出', '', 'warning'); return; }
  const payload = { format: 'epub-studio-bookmarks', version: 1, book: state.book.info.title, bookmarks: state.bookmarks };
  const target = await window.studio.saveText(JSON.stringify(payload, null, 2), `${safeFileName(state.book.info.title)}-bookmarks.json`, [{ name: 'JSON', extensions: ['json'] }]);
  if (target) toast('书签已导出', target);
}

async function importBookmarks() {
  const files = await window.studio.openTextFiles([{ name: 'JSON', extensions: ['json'] }], false);
  if (!files.length) return;
  const payload = JSON.parse(decodeBytes(files[0].data));
  const bookmarks = Array.isArray(payload) ? payload : payload.bookmarks;
  if (!Array.isArray(bookmarks)) throw new Error('书签文件格式无效。');
  const existing = new Set(state.bookmarks.map((item) => item.id));
  for (const bookmark of bookmarks) {
    if (!bookmark.path || !state.book.getResource(bookmark.path)) continue;
    if (!bookmark.id || existing.has(bookmark.id)) bookmark.id = uuid();
    existing.add(bookmark.id);
    state.bookmarks.push({ ...bookmark, order: state.bookmarks.length });
  }
  persistBookmarks();
  renderBookmarksPanel();
  toast('书签已导入', `${bookmarks.length} 项`);
}

function safeFileName(value) {
  return String(value || 'export').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
}

function renderMetadataPanel() {
  const metadata = state.book.getMetadata();
  elements.rightContent.innerHTML = `
    <form id="metadata-form" class="metadata-form">
      <label>书名<input name="title" value="${escapeHtml(metadata.title)}"></label>
      <label>语言<input name="language" value="${escapeHtml(metadata.language)}"></label>
      <label>标识符<input name="identifier" value="${escapeHtml(metadata.identifier)}"></label>
      <label>出版者<input name="publisher" value="${escapeHtml(metadata.publisher)}"></label>
      <label>日期<input name="date" value="${escapeHtml(metadata.date)}"></label>
      <label>版权<input name="rights" value="${escapeHtml(metadata.rights)}"></label>
      <label>简介<textarea name="description">${escapeHtml(metadata.description)}</textarea></label>
    </form>
    <div class="metadata-section">
      <h4>作者</h4>
      <div id="creator-editor">
        ${metadata.creators.map((creator) => creatorRow(creator.name, creator.role)).join('') || creatorRow('', 'aut')}
      </div>
      <button class="mini-button" data-command="metadata-add-creator">添加作者</button>
    </div>
    <div class="metadata-section">
      <h4>主题标签</h4>
      <div id="subject-list">${metadata.subjects.map((subject) => `<span class="metadata-chip">${escapeHtml(subject)}</span>`).join('') || '<span class="tree-meta">暂无主题</span>'}</div>
      <button class="mini-button" data-command="metadata-add-subject">添加主题</button>
    </div>
    <div class="panel-actions"><button class="button primary" data-command="metadata-save">保存元数据</button></div>`;
}

function creatorRow(name = '', role = 'aut') {
  return `<div class="creator-row"><input data-creator-name placeholder="作者名" value="${escapeHtml(name)}"><input data-creator-role placeholder="角色" value="${escapeHtml(role)}"><button type="button" data-remove-creator title="删除">×</button></div>`;
}

function addCreatorRow() {
  $('#creator-editor')?.insertAdjacentHTML('beforeend', creatorRow('', 'aut'));
}

async function addSubject() {
  const subject = await promptDialog({ title: '添加主题', label: '主题 / 分类', value: '' });
  if (!subject) return;
  $('#subject-list')?.insertAdjacentHTML('beforeend', `<span class="metadata-chip">${escapeHtml(subject)}</span>`);
}

async function saveMetadata() {
  const form = $('#metadata-form');
  if (!form) return;
  const creators = $$('#creator-editor .creator-row').map((row) => ({
    name: $('[data-creator-name]', row).value.trim(),
    role: $('[data-creator-role]', row).value.trim(),
  })).filter((item) => item.name);
  const subjects = $$('#subject-list .metadata-chip').map((item) => item.textContent.trim()).filter(Boolean);
  state.book.setMetadata({
    title: form.elements.title.value.trim(),
    language: form.elements.language.value.trim(),
    identifier: form.elements.identifier.value.trim(),
    publisher: form.elements.publisher.value.trim(),
    date: form.elements.date.value.trim(),
    rights: form.elements.rights.value.trim(),
    description: form.elements.description.value,
    creators,
    subjects,
  });
  updateDirtyStatus();
  renderShell();
  toast('元数据已更新', '保存 EPUB 时写入 OPF。');
}

function renderInspectorPanel() {
  const element = state.selectedElement;
  if (!element) {
    elements.rightContent.innerHTML = '<div class="empty-state"><strong>未选择元素</strong><p>切换到预览编辑模式，然后点击正文中的元素进行检查和修改。</p></div>';
    return;
  }
  const attributes = [...element.attributes].filter((attribute) => attribute.name !== 'contenteditable' && attribute.name !== 'spellcheck' && attribute.name !== 'data-studio-selected');
  elements.rightContent.innerHTML = `
    <div class="inspector-breadcrumb" title="${escapeHtml(nodePath(element).join(' › '))}">${escapeHtml(nodePath(element).join(' › '))}</div>
    <div class="inspector-tree"><strong>&lt;${escapeHtml(element.localName)}&gt;</strong></div>
    <div id="inspector-attributes">
      ${attributes.map((attribute) => `<label class="attribute-row"><span title="${escapeHtml(attribute.name)}">${escapeHtml(attribute.name)}</span><input data-attribute-name="${escapeHtml(attribute.name)}" value="${escapeHtml(attribute.value)}"></label>`).join('')}
    </div>
    <div class="panel-section">
      <label class="field"><span>文本内容</span><textarea id="inspector-text" rows="6">${escapeHtml(element.children.length ? '' : element.textContent)}</textarea></label>
    </div>
    <div class="panel-actions">
      <button class="button primary" data-command="inspector-apply">应用修改</button>
      <button class="mini-button" data-inspector-add-attribute>添加属性</button>
    </div>`;
}

async function applyInspector() {
  const element = state.selectedElement;
  if (!element) return;
  for (const input of $$('#inspector-attributes input')) {
    const name = input.dataset.attributeName;
    if (input.value) element.setAttribute(name, input.value);
    else element.removeAttribute(name);
  }
  const text = $('#inspector-text')?.value;
  if (text !== undefined && !element.children.length) element.textContent = text;
  element.setAttribute('data-studio-selected', 'true');
  syncFrameToBook();
  renderInspectorPanel();
  updateDirtyStatus();
}

function renderValidationPanel() {
  const results = state.validation || [];
  const counts = {
    error: results.filter((item) => item.severity === 'error').length,
    warning: results.filter((item) => item.severity === 'warning').length,
    info: results.filter((item) => item.severity === 'info').length,
  };
  elements.rightContent.innerHTML = `
    <div class="panel-actions">
      <button class="mini-button" data-command="validate">验证</button>
      <button class="mini-button" data-command="check-links">链接检查</button>
      <button class="mini-button" data-command="validation-export">导出</button>
    </div>
    ${state.validation ? `
      <div class="validation-summary">
        <div class="validation-count"><strong class="severity error">${counts.error}</strong><span>错误</span></div>
        <div class="validation-count"><strong class="severity warning">${counts.warning}</strong><span>警告</span></div>
        <div class="validation-count"><strong class="severity info">${counts.info}</strong><span>提示</span></div>
      </div>
      <div class="validation-list">${results.map((item, index) => `
        <button class="validation-item" data-validation-index="${index}">
          <span class="severity ${item.severity}">${item.severity === 'error' ? '×' : item.severity === 'warning' ? '!' : 'i'}</span>
          <span>${escapeHtml(item.message)}<small>${escapeHtml(item.path || state.book.opfPath)}</small></span>
        </button>`).join('')}</div>
    ` : '<div class="empty-state"><strong>尚未验证</strong><p>检查 EPUB 容器、OPF、资源引用、XML、重复 ID、Spine 与目录结构。</p><button class="button primary" data-command="validate">开始验证</button></div>'}`;
}

async function validateBook() {
  state.validation = state.book.validate();
  state.validationTitle = 'EPUB 验证';
  state.rightPanel = 'validation';
  state.rightVisible = true;
  renderShell();
  const errors = state.validation.filter((item) => item.severity === 'error').length;
  toast(errors ? '验证发现问题' : '验证完成', errors ? `${errors} 个错误` : '未发现错误', errors ? 'warning' : 'info');
}

async function checkLinks() {
  state.validation = state.book.checkLinks();
  state.validationTitle = '链接检查';
  state.rightPanel = 'validation';
  state.rightVisible = true;
  renderShell();
  toast('链接检查完成', `${state.validation.length} 个问题`, state.validation.length ? 'warning' : 'info');
}

async function exportValidation() {
  if (!state.validation) return;
  const rows = state.validation.map((item) => ({ 级别: item.severity, 代码: item.code || '', 信息: item.message, 文件: item.path || '' }));
  const content = reportHtml(state.validationTitle || 'EPUB 验证结果', rows);
  const target = await window.studio.saveText(content, 'epub-validation.html', [{ name: 'HTML', extensions: ['html'] }]);
  if (target) toast('验证结果已导出', target);
}

function renderReportPanel() {
  if (!state.report) state.report = state.book.generateReports();
  const report = state.report;
  elements.rightContent.innerHTML = `
    <div class="panel-actions">
      <button class="mini-button" data-command="report-refresh">重新统计</button>
      <button class="mini-button" data-command="report-export-html">HTML</button>
      <button class="mini-button" data-command="report-export-csv">CSV</button>
    </div>
    <div class="report-summary">
      <div class="report-metric"><strong>${report.totals.files}</strong><span>资源文件</span></div>
      <div class="report-metric"><strong>${report.totals.words}</strong><span>单词数</span></div>
      <div class="report-metric"><strong>${report.totals.characters}</strong><span>字符数</span></div>
      <div class="report-metric"><strong>${report.totals.headings}</strong><span>标题数</span></div>
      <div class="report-metric"><strong>${report.totals.paragraphs}</strong><span>段落数</span></div>
      <div class="report-metric"><strong>${report.classes.length}</strong><span>CSS 类</span></div>
    </div>
    <div class="panel-toolbar"><h3>文件</h3></div>
    <table class="report-table"><thead><tr><th>文件</th><th>大小</th></tr></thead><tbody>
      ${report.files.slice(0, 120).map((file) => `<tr data-resource-path="${escapeHtml(file.path)}"><td title="${escapeHtml(file.path)}">${escapeHtml(basename(file.path))}</td><td>${file.sizeLabel}</td></tr>`).join('')}
    </tbody></table>
    <div class="panel-toolbar"><h3>高频类</h3></div>
    <table class="report-table"><tbody>${report.classes.slice(0, 40).map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td>${count}</td></tr>`).join('') || '<tr><td>无</td><td>0</td></tr>'}</tbody></table>`;
}

async function exportReport(format) {
  if (!state.report) state.report = state.book.generateReports();
  const rows = state.report.files.map((file) => ({ 文件: file.path, 类型: file.kind, 大小: file.sizeLabel }));
  if (format === 'html') {
    const target = await window.studio.saveText(reportHtml(`${state.book.info.title} 报告`, rows), `${safeFileName(state.book.info.title)}-report.html`, [{ name: 'HTML', extensions: ['html'] }]);
    if (target) toast('报告已导出', target);
  } else {
    const headers = Object.keys(rows[0] || { 文件: '' });
    const csv = [headers.join(','), ...rows.map((row) => headers.map((header) => `"${String(row[header] ?? '').replaceAll('"', '""')}"`).join(','))].join('\n');
    const target = await window.studio.saveText(`\ufeff${csv}`, `${safeFileName(state.book.info.title)}-report.csv`, [{ name: 'CSV', extensions: ['csv'] }]);
    if (target) toast('报告已导出', target);
  }
}

async function addExistingFiles() {
  const files = await window.studio.openTextFiles([], true);
  if (!files.length) return;
  const baseFolder = await promptDialog({
    title: '添加现有文件',
    label: '目标目录',
    value: joinPath(dirname(state.book.opfPath), 'Assets'),
    help: '文件会保留原文件名并放入此目录。',
  });
  if (baseFolder === null) return;
  const added = [];
  for (const file of files) {
    const target = normalizePath(joinPath(baseFolder, file.name));
    if (state.book.getResource(target)) {
      toast('跳过重复文件', target, 'warning');
      continue;
    }
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    state.book.addBinary(target, data, mimeForPath(target));
    const item = state.book.addManifestItem({
      id: uniqueId(state.book.manifestItems().map((entry) => entry.id), `item-${basename(target).replace(/\.[^.]+$/, '')}`),
      path: target,
      mediaType: mimeForPath(target),
      spine: isHtmlPath(target),
    });
    if (isHtmlPath(target)) state.book.toc.push({ id: `toc-${Date.now().toString(36)}`, label: basename(target).replace(/\.[^.]+$/, ''), path: target, hash: '', children: [] });
    added.push({ path: target, id: item?.id });
  }
  if (added.length) {
    state.book.dirty = true;
    state.book.packageDirty = true;
    clearAssetCache();
    openResource(added.at(-1).path);
    renderShell();
    toast('文件已添加', `${added.length} 个资源`);
  }
}

function uniqueResourcePath(targetPath) {
  if (!state.book.getResource(targetPath)) return targetPath;
  const folder = dirname(targetPath);
  const name = basename(targetPath);
  const ext = extension(name);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  let index = 2;
  let candidate = '';
  do {
    candidate = joinPath(folder, `${stem}-${index}${ext ? `.${ext}` : ''}`);
    index += 1;
  } while (state.book.getResource(candidate));
  return candidate;
}

async function addImageFiles() {
  if (!state.book) { toast('请先打开书籍', '', 'warning'); return; }
  const files = await window.studio.openTextFiles([
    { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'] },
  ], true);
  if (!files.length) return;
  const folder = joinPath(dirname(state.book.opfPath), 'Images');
  const added = [];
  for (const file of files) {
    const mediaType = mimeForPath(file.name);
    if (!mediaType.startsWith('image/')) {
      toast('跳过不支持的图片', file.name, 'warning');
      continue;
    }
    const target = uniqueResourcePath(normalizePath(joinPath(folder, file.name)));
    state.book.addBinary(target, file.data, mediaType);
    state.book.addManifestItem({
      id: uniqueId(state.book.manifestItems().map((item) => item.id), `item-${basename(target).replace(/\.[^.]+$/, '')}`),
      path: target,
      mediaType,
    });
    added.push(target);
  }
  if (!added.length) return;
  state.book.dirty = true;
  state.book.packageDirty = true;
  state.leftPanel = 'images';
  clearAssetCache();
  renderShell();
  toast('图片已添加', `${added.length} 个图片资源`);
}

async function replaceImage(filePath) {
  const target = normalizePath(filePath);
  const item = state.book?.getManifestByPath(target);
  if (!item || !item.mediaType.startsWith('image/')) {
    toast('找不到图片资源', target, 'error');
    return;
  }
  const files = await window.studio.openTextFiles([
    { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'] },
  ], false);
  if (!files.length) return;
  const mediaType = mimeForPath(files[0].name);
  if (!mediaType.startsWith('image/')) {
    toast('不支持的图片格式', files[0].name, 'warning');
    return;
  }
  state.book.addBinary(target, files[0].data, mediaType);
  state.book.addManifestItem({ id: item.id, path: target, mediaType });
  clearAssetCache();
  renderShell();
  toast('图片已替换', target);
}

async function removeImage(filePath) {
  const target = normalizePath(filePath);
  if (!state.book?.getResource(target)) return;
  if (!await confirmDialog({ title: '删除图片？', message: `将从 EPUB 中删除 ${target}，并移除 Manifest 中的记录。正文中的引用不会自动删除。`, confirmLabel: '删除', danger: true })) return;
  state.book.removeResource(target);
  state.openPaths = state.openPaths.filter((item) => item !== target);
  forgetViewLocationForPath(target);
  if (state.activePath === target) {
    state.activePath = state.openPaths.at(-1) || state.book.spineResources()[0]?.item.path || state.book.manifestItems()[0]?.path || '';
    pendingViewLocation = state.activePath ? recallViewLocationForPath(state.activePath) : null;
    frameViewAnchor = null;
    state.pendingReveal = null;
    if (state.activePath && !state.openPaths.includes(state.activePath)) state.openPaths.push(state.activePath);
  }
  state.leftPanel = 'images';
  clearAssetCache();
  renderShell();
  toast('图片已删除', target);
}

async function deleteUnusedImages() {
  if (!state.book) return;
  const images = state.book.manifestItems().filter((item) => item.mediaType.startsWith('image/'));
  const usage = imageUsageIndex();
  const unused = images.filter((item) => !usage.get(item.path)?.size);
  if (!unused.length) {
    toast('没有未使用图片', '', 'info');
    return;
  }
  if (!await confirmDialog({ title: '删除未使用图片？', message: `将删除 ${unused.length} 个未被 XHTML、SVG 或 CSS 引用的图片资源。`, confirmLabel: '删除', danger: true })) return;
  const removed = new Set();
  for (const item of unused) {
    state.book.removeResource(item.path);
    removed.add(item.path);
  }
  state.openPaths = state.openPaths.filter((item) => !removed.has(item));
  for (const removedPath of removed) forgetViewLocationForPath(removedPath);
  if (removed.has(state.activePath)) {
    state.activePath = state.openPaths.at(-1) || state.book.spineResources()[0]?.item.path || state.book.manifestItems()[0]?.path || '';
    pendingViewLocation = state.activePath ? recallViewLocationForPath(state.activePath) : null;
    frameViewAnchor = null;
    state.pendingReveal = null;
  }
  if (state.activePath && !state.openPaths.includes(state.activePath)) state.openPaths.push(state.activePath);
  state.leftPanel = 'images';
  clearAssetCache();
  renderShell();
  toast('未使用图片已清理', `${unused.length} 个资源`);
}

async function newResource(forcedType = 'xhtml') {
  if (!state.book) { toast('请先打开书籍', '', 'warning'); return; }
  const defaults = {
    xhtml: { title: '新章节', path: joinPath(dirname(state.book.opfPath), 'Text', `chapter-${Date.now().toString(36)}.xhtml`), type: 'xhtml' },
    html: { title: '新章节', path: joinPath(dirname(state.book.opfPath), 'Text', `chapter-${Date.now().toString(36)}.html`), type: 'html' },
    css: { title: '新样式表', path: joinPath(dirname(state.book.opfPath), 'Styles', `style-${Date.now().toString(36)}.css`), type: 'css' },
    js: { title: '新脚本', path: joinPath(dirname(state.book.opfPath), 'Scripts', `script-${Date.now().toString(36)}.js`), type: 'js' },
    svg: { title: '新 SVG', path: joinPath(dirname(state.book.opfPath), 'Images', `image-${Date.now().toString(36)}.svg`), type: 'svg' },
  };
  const initial = defaults[forcedType] || defaults.xhtml;
  const result = await showModal({
    title: '新建资源',
    fields: [
      { name: 'title', label: '标题', value: initial.title, required: true, autofocus: true },
      { name: 'path', label: '资源路径', value: initial.path, required: true },
      { name: 'type', label: '类型', type: 'select', value: initial.type, options: [
        { value: 'xhtml', label: 'XHTML 章节' }, { value: 'html', label: 'HTML 章节' }, { value: 'css', label: 'CSS 样式表' },
        { value: 'js', label: 'JavaScript' }, { value: 'svg', label: 'SVG 图像' }, { value: 'xml', label: 'XML' },
      ] },
      { name: 'spine', label: '加入 Spine', type: 'select', value: 'yes', options: [{ value: 'yes', label: '是' }, { value: 'no', label: '否' }] },
    ],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: '创建', kind: 'primary' }],
  });
  if (result.action !== 'ok') return;
  const values = result.values;
  const target = normalizePath(values.path);
  if (state.book.getResource(target)) throw new Error(`资源已存在：${target}`);
  const isChapter = ['xhtml', 'html'].includes(values.type);
  const created = state.book.createResource({
    type: values.type,
    targetPath: target,
    title: values.title,
    spine: isChapter && values.spine === 'yes',
  });
  if (isChapter && values.spine === 'yes') state.book.toc.push({ id: `toc-${Date.now().toString(36)}`, label: values.title, path: created.path, hash: '', children: [] });
  state.book.dirty = true;
  state.book.packageDirty = true;
  clearAssetCache();
  openResource(created.path);
  renderShell();
  toast('资源已创建', created.path);
}

function wrapImportedHtml(source, title) {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  for (const element of [...parsed.querySelectorAll('script,form,object,embed,iframe')]) element.remove();
  const body = (parsed.body?.innerHTML || `<p>${escapeHtml(source)}</p>`)
    .replace(/<(br|hr|img|meta|link|input|source|track|wbr)([^>]*?)(?<!\/)>/gi, '<$1$2/>');
  const language = state.book.getMetadataValue('language') || 'zh-CN';
  return formatMarkup(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeHtml(language)}" xml:lang="${escapeHtml(language)}">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
<body>${body}</body>
</html>`);
}

function textToXhtml(source, title) {
  const paragraphs = source.replace(/\r\n?/g, '\n').split(/\n\s*\n+/).map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, '<br/>')}</p>`).filter((paragraph) => !paragraph.startsWith('<p></p>')).join('\n');
  const language = state.book.getMetadataValue('language') || 'zh-CN';
  return formatMarkup(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeHtml(language)}" xml:lang="${escapeHtml(language)}">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
<body>${paragraphs || '<p></p>'}</body>
</html>`);
}

async function importTextResource(kind) {
  const filters = kind === 'html'
    ? [{ name: 'HTML / XHTML', extensions: ['html', 'htm', 'xhtml'] }]
    : [{ name: '纯文本', extensions: ['txt', 'md', 'text'] }];
  const files = await window.studio.openTextFiles(filters, true);
  if (!files.length) return;
  const folder = joinPath(dirname(state.book.opfPath), 'Text');
  const createdPaths = [];
  for (const file of files) {
    const title = basename(file.name).replace(/\.[^.]+$/, '');
    const target = normalizePath(joinPath(folder, `${slugify(title) || 'imported'}.xhtml`));
    const source = decodeBytes(file.data);
    const content = kind === 'html' ? wrapImportedHtml(source, title) : textToXhtml(source, title);
    let path = target;
    let index = 2;
    while (state.book.getResource(path)) path = normalizePath(joinPath(folder, `${slugify(title) || 'imported'}-${index++}.xhtml`));
    const created = state.book.createResource({ type: 'xhtml', targetPath: path, title, content, spine: true });
    state.book.toc.push({ id: `toc-${Date.now().toString(36)}`, label: title, path: created.path, hash: '', children: [] });
    createdPaths.push(created.path);
  }
  clearAssetCache();
  openResource(createdPaths.at(-1));
  renderShell();
  toast('导入完成', `${createdPaths.length} 个章节`);
}

async function renameActiveResource() {
  if (!state.activePath) return;
  if (['mimetype', 'META-INF/container.xml', state.book.opfPath].includes(state.activePath)) {
    toast('不能重命名核心容器文件', state.activePath, 'warning');
    return;
  }
  const oldPath = state.activePath;
  const newPath = await promptDialog({ title: '重命名资源', label: '新路径', value: oldPath });
  if (newPath === null || normalizePath(newPath) === oldPath) return;
  await runAction('重命名资源', async () => {
    state.book.renameResource(oldPath, normalizePath(newPath));
    state.openPaths = state.openPaths.map((item) => item === oldPath ? normalizePath(newPath) : item);
    state.activePath = normalizePath(newPath);
    if (resourceViewLocations.has(oldPath)) {
      resourceViewLocations.set(state.activePath, resourceViewLocations.get(oldPath));
      resourceViewLocations.delete(oldPath);
    }
    clearAssetCache();
    renderShell();
    toast('资源已重命名', state.activePath);
  });
}

async function deleteActiveResource() {
  if (!state.activePath) return;
  if (['mimetype', 'META-INF/container.xml', state.book.opfPath].includes(state.activePath)) {
    toast('不能删除核心容器文件', state.activePath, 'warning');
    return;
  }
  const target = state.activePath;
  if (!await confirmDialog({ title: '删除资源？', message: `将删除 ${target}，并从 Manifest、Spine 和目录中移除引用。`, confirmLabel: '删除', danger: true })) return;
  state.book.removeResource(target);
  state.openPaths = state.openPaths.filter((item) => item !== target);
  forgetViewLocationForPath(target);
  state.activePath = state.openPaths.at(-1) || state.book.spineResources()[0]?.item.path || state.book.manifestItems()[0]?.path || '';
  pendingViewLocation = state.activePath ? recallViewLocationForPath(state.activePath) : null;
  frameViewAnchor = null;
  state.pendingReveal = null;
  if (state.activePath && !state.openPaths.includes(state.activePath)) state.openPaths.push(state.activePath);
  clearAssetCache();
  renderShell();
  toast('资源已删除', target);
}

const CLIPS_KEY = 'epub-studio:clips';

function loadClips() {
  try { return JSON.parse(localStorage.getItem(CLIPS_KEY) || '[]'); }
  catch { return []; }
}

function saveClips() {
  localStorage.setItem(CLIPS_KEY, JSON.stringify(state.clips));
}

function selectionContent() {
  if (activeFrame && frameKind === 'preview') {
    const selection = activeFrame.contentWindow.getSelection();
    if (!selection || selection.isCollapsed) return null;
    const container = document.createElement('div');
    for (let index = 0; index < selection.rangeCount; index += 1) container.append(selection.getRangeAt(index).cloneContents());
    return { html: container.innerHTML, text: selection.toString() };
  }
  if (editor?.selection.text) return { html: escapeHtml(editor.selection.text), text: editor.selection.text };
  return null;
}

async function saveClip(label, content, kind = 'html') {
  state.clips.push({ id: uuid(), label, content, kind, createdAt: new Date().toISOString() });
  saveClips();
  renderClipsPanel();
}

async function addClipFromSelection() {
  const selection = selectionContent();
  if (!selection) { toast('没有选中内容', '先在代码或预览编辑区选择文本。', 'warning'); return; }
  const label = await promptDialog({ title: '保存片段', label: '片段名称', value: selection.text.slice(0, 40) });
  if (label === null) return;
  await saveClip(label || '未命名片段', selection.html, 'html');
  toast('片段已保存', label);
}

async function createClip() {
  const result = await showModal({
    title: '新建片段',
    fields: [
      { name: 'label', label: '片段名称', value: '', required: true, autofocus: true },
      { name: 'content', label: '片段内容', type: 'textarea', value: '<p></p>', rows: 8, required: true },
    ],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: '保存', kind: 'primary' }],
    width: '680px',
  });
  if (result.action !== 'ok') return;
  await saveClip(result.values.label, result.values.content, 'html');
}

async function editClip(id) {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip) return;
  const result = await showModal({
    title: '编辑片段',
    fields: [
      { name: 'label', label: '片段名称', value: clip.label, required: true, autofocus: true },
      { name: 'content', label: '片段内容', type: 'textarea', value: clip.content, rows: 9, required: true },
    ],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: '保存', kind: 'primary' }],
    width: '680px',
  });
  if (result.action !== 'ok') return;
  clip.label = result.values.label;
  clip.content = result.values.content;
  saveClips();
  renderClipsPanel();
}

async function deleteClip(id) {
  state.clips = state.clips.filter((item) => item.id !== id);
  saveClips();
  renderClipsPanel();
}

function insertClip(id) {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip) return;
  if (activeFrame && frameKind === 'preview') {
    activeFrame.contentDocument.execCommand('insertHTML', false, clip.content);
    syncFrameToBook();
  } else if (editor) {
    editor.insertText(clip.content);
  } else {
    navigator.clipboard?.writeText(clip.content);
    toast('片段已复制', clip.label);
  }
}

async function chooseClipToInsert() {
  if (!state.clips.length) { toast('暂无片段', '', 'warning'); return; }
  const choice = await choiceDialog({ title: '插入片段', choices: state.clips.map((clip) => ({ label: clip.label, description: clip.content.slice(0, 90), icon: '</>' , value: clip.id })) });
  if (choice) insertClip(choice.value);
}

function goToFindMatch(match, { options = {}, occurrence = 0 } = {}) {
  if (!match) return;
  if (match.path !== state.activePath) openResource(match.path, { offset: match.start });
  else if (editor) editor.scrollToOffset(match.start, { focus: false });
  else if (activeFrame) revealFrameText(activeFrame, match.text, { ...options, occurrence });
}

function revealFrameText(iframe, text, { caseSensitive = false, wholeWord = false, occurrence = 0 } = {}) {
  const doc = iframe?.contentDocument;
  if (!doc?.body || !text) return false;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let content = '';
  let node;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: content.length, end: content.length + node.data.length });
    content += node.data;
  }
  const searchable = caseSensitive ? content : content.toLocaleLowerCase();
  const needle = caseSensitive ? text : text.toLocaleLowerCase();
  let from = 0;
  let found = 0;
  while (needle && from <= searchable.length - needle.length) {
    const index = searchable.indexOf(needle, from);
    if (index < 0) break;
    const before = content[index - 1] || '';
    const after = content[index + needle.length] || '';
    if (wholeWord && (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after))) {
      from = index + Math.max(1, needle.length);
      continue;
    }
    if (found < occurrence) {
      found += 1;
      from = index + Math.max(1, needle.length);
      continue;
    }
    const pointAt = (offset) => {
      for (const entry of nodes) {
        if (offset <= entry.end) return [entry.node, offset - entry.start];
      }
      const last = nodes.at(-1);
      return [last.node, last.node.data.length];
    };
    const range = doc.createRange();
    const [startNode, startOffset] = pointAt(index);
    const [endNode, endOffset] = pointAt(index + needle.length);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = iframe.contentWindow?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const element = startNode.nodeType === Node.ELEMENT_NODE ? startNode : startNode.parentElement;
    element?.scrollIntoView({ block: 'center' });
    return true;
  }
  return Boolean(iframe.contentWindow?.find(text, Boolean(caseSensitive), false, true, Boolean(wholeWord)));
}

async function openPreferences() {
  const result = await showModal({
    title: '首选项',
    fields: [
      { name: 'theme', label: '界面主题', type: 'select', value: state.settings.theme, options: [
        { value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' },
      ] },
      { name: 'showRecentFiles', label: '显示最近打开', type: 'select', value: state.settings.showRecentFiles ? 'yes' : 'no', options: [{ value: 'yes', label: '显示' }, { value: 'no', label: '隐藏' }] },
      { name: 'fontFamily', label: '阅读字体', value: state.settings.fontFamily },
      { name: 'fontSize', label: '正文基准字号 (px)', type: 'number', min: 12, max: 36, step: 1, value: state.settings.fontSize },
      { name: 'readingWidth', label: '阅读宽度 (px)', type: 'number', min: 520, max: 1100, step: 20, value: state.settings.readingWidth },
      { name: 'spellcheck', label: '拼写检查', type: 'select', value: state.settings.spellcheck ? 'yes' : 'no', options: [{ value: 'yes', label: '开启' }, { value: 'no', label: '关闭' }] },
      { name: 'spellcheckLanguages', label: '拼写词典（逗号分隔）', value: state.settings.spellcheckLanguages.join(', '), help: 'Chromium 支持的词典代码，例如 en-US, zh-CN。' },
      { name: 'lineWrapping', label: '源码自动换行', type: 'select', value: state.settings.lineWrapping ? 'yes' : 'no', options: [{ value: 'yes', label: '开启' }, { value: 'no', label: '关闭' }] },
    ],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: '保存', kind: 'primary' }],
    width: '620px',
  });
  if (result.action !== 'ok') return;
  await updateSettings({
    theme: result.values.theme,
    showRecentFiles: result.values.showRecentFiles === 'yes',
    fontFamily: result.values.fontFamily,
    fontSize: Number(result.values.fontSize),
    readingWidth: Number(result.values.readingWidth),
    spellcheck: result.values.spellcheck === 'yes',
    spellcheckLanguages: result.values.spellcheckLanguages.split(',').map((item) => item.trim()).filter(Boolean),
    lineWrapping: result.values.lineWrapping === 'yes',
  });
  renderDocument();
  toast('首选项已保存');
}

async function showHelp() {
  await showModal({
    title: '功能与快捷键',
    body: `
      <div class="feature-grid">
        <article><strong>三种正文模式</strong><span>HTML 源码、可视化预览编辑、纯阅读；左侧书籍浏览器选择章节。</span></article>
        <article><strong>目录与书签</strong><span>目录支持层级、重命名和新增；书签支持当前位置、重命名、导入导出。</span></article>
        <article><strong>EPUB 工具</strong><span>元数据、资源增删改、NCX/Nav、验证、链接检查、报告、格式化。</span></article>
        <article><strong>格式化</strong><span>标题、粗斜体、上下标、列表、对齐、缩进、链接、图片、特殊字符。</span></article>
      </div>
      <table class="report-table" style="margin-top:16px"><tbody>
        <tr><td>打开 EPUB</td><td>⌘/Ctrl + O</td></tr>
        <tr><td>保存</td><td>⌘/Ctrl + S</td></tr>
        <tr><td>查找替换</td><td>⌘/Ctrl + F</td></tr>
        <tr><td>HTML / 预览 / 阅读</td><td>⌘/Ctrl + Alt + 1 / 2 / 3</td></tr>
        <tr><td>标题 1-6</td><td>⌘/Ctrl + 1 … 6</td></tr>
        <tr><td>正文段落</td><td>⌘/Ctrl + 0 或 7</td></tr>
        <tr><td>粗体 / 斜体 / 下划线</td><td>⌘/Ctrl + B / I / U</td></tr>
        <tr><td>左 / 居中 / 右 / 两端对齐</td><td>⌘/Ctrl + Shift+L / E / Shift+R / J</td></tr>
        <tr><td>从标题生成目录</td><td>⌘/Ctrl + Shift + G</td></tr>
        <tr><td>验证</td><td>⌘/Ctrl + Shift + V</td></tr>
      </tbody></table>`,
    actions: [{ id: 'ok', label: '关闭', kind: 'primary' }],
    width: '760px',
  });
}

async function showAbout() {
  const info = state.appInfo || await window.studio.getAppInfo();
  await showModal({
    title: '关于 EPUB Studio',
    body: `
      <div class="welcome-brand"><span>ES</span><p>EPUB Studio ${escapeHtml(info.version)}</p></div>
      <p class="modal-message" style="margin-top:18px">阅读与编辑一体化的 EPUB 2/3 工具。功能模型参考 Sigil 与 PageEdit，使用 Electron、Chromium 和 JSZip 实现。</p>
      <pre class="modal-detail">Electron ${escapeHtml(info.electron)}
Chromium ${escapeHtml(info.chrome)}
Node ${escapeHtml(info.node)}
平台 ${escapeHtml(info.platform)} ${escapeHtml(info.arch)}
数据目录 ${escapeHtml(info.userData)}</pre>
      <p class="modal-message">软件以 GPL-3.0-or-later 发布。</p>`,
    actions: [{ id: 'ok', label: '关闭', kind: 'primary' }],
    width: '620px',
  });
}
