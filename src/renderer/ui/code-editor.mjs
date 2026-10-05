import { escapeHtml } from '../core/utils.mjs';

function tokenize(source, mode) {
  const text = String(source ?? '');
  const tokenPattern = mode === 'css'
    ? /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[0-9a-fA-F]{3,8}\b|--[\w-]+|@[\w-]+|\b(?:var|calc|url|rgba?|hsla?|linear-gradient|important)\b)/gm
    : /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][^>]*>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:const|let|var|function|return|if|else|for|while|class|new|import|export|async|await|true|false|null|undefined|DOCTYPE|CDATA)\b)/gm;
  let output = '';
  let last = 0;
  let match;
  while ((match = tokenPattern.exec(text)) !== null) {
    output += escapeHtml(text.slice(last, match.index));
    const token = match[0];
    let className = 'token-keyword';
    if (/^<!--/.test(token)) className = 'token-comment';
    else if (/^<!\[CDATA\[/.test(token)) className = 'token-cdata';
    else if (/^<\//.test(token)) className = 'token-tag token-close';
    else if (/^<[A-Za-z]/.test(token)) className = 'token-tag';
    else if (/^["'`]/.test(token)) className = 'token-string';
    else if (/^\/\//.test(token) || /^\/\*/.test(token)) className = 'token-comment';
    else if (/^--/.test(token)) className = 'token-var';
    else if (/^#/.test(token)) className = 'token-color';
    else if (/^@/.test(token)) className = 'token-atrule';
    output += `<span class="${className}">${escapeHtml(token)}</span>`;
    last = match.index + token.length;
  }
  output += escapeHtml(text.slice(last));
  return output;
}

export class CodeEditor extends EventTarget {
  constructor({ mode = 'xml', readOnly = false, onChange = null, lineWrapping = true } = {}) {
    super();
    this.mode = mode;
    this.onChange = onChange;
    this.value = '';
    this._syncing = false;
    this._lineWrapping = false;

    this.element = document.createElement('div');
    this.element.className = 'code-editor';
    this.element.innerHTML = `
      <pre class="code-gutter" aria-hidden="true"></pre>
      <div class="code-scroll">
        <pre class="code-highlight" aria-hidden="true"><code></code></pre>
        <textarea class="code-input" spellcheck="false" wrap="off" aria-label="代码编辑器"></textarea>
      </div>`;
    this.gutter = this.element.querySelector('.code-gutter');
    this.scroller = this.element.querySelector('.code-scroll');
    this.highlight = this.element.querySelector('.code-highlight code');
    this.textarea = this.element.querySelector('.code-input');
    this.textarea.readOnly = readOnly;
    this.lineWrapping = lineWrapping;
    this.textarea.addEventListener('input', () => this.handleInput());
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('keydown', (event) => this.handleKeydown(event));
    this.textarea.addEventListener('click', () => this.dispatchEvent(new CustomEvent('caret', { detail: this.selection })));
    this.textarea.addEventListener('keyup', () => this.dispatchEvent(new CustomEvent('caret', { detail: this.selection })));
    this._resizeObserver = new ResizeObserver(() => {
      this.refreshGutterMetrics();
      this.syncScroll();
    });
    this._resizeObserver.observe(this.textarea);
  }

  get readOnly() {
    return this.textarea.readOnly;
  }

  set readOnly(value) {
    this.textarea.readOnly = Boolean(value);
    this.element.classList.toggle('is-readonly', Boolean(value));
  }

  get lineWrapping() {
    return this._lineWrapping;
  }

  set lineWrapping(value) {
    this._lineWrapping = Boolean(value);
    this.textarea.wrap = this._lineWrapping ? 'soft' : 'off';
    this.element.classList.toggle('is-wrapping', this._lineWrapping);
    if (this.textarea.value) this.refresh();
  }

  get selection() {
    return { start: this.textarea.selectionStart, end: this.textarea.selectionEnd, text: this.textarea.value.slice(this.textarea.selectionStart, this.textarea.selectionEnd) };
  }

  setMode(mode) {
    this.mode = mode || 'xml';
    this.refresh();
  }

  setValue(value, { preserveSelection = true } = {}) {
    const selection = preserveSelection ? this.selection : { start: 0, end: 0 };
    this.value = String(value ?? '');
    this.textarea.value = this.value;
    this.textarea.selectionStart = Math.min(selection.start, this.value.length);
    this.textarea.selectionEnd = Math.min(selection.end, this.value.length);
    this.refresh();
  }

  getValue() {
    return this.textarea.value;
  }

  focus() {
    this.textarea.focus();
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }

  handleInput() {
    this.value = this.textarea.value;
    this.refresh();
    this.onChange?.(this.value);
    this.dispatchEvent(new CustomEvent('change', { detail: { value: this.value } }));
  }

  refresh() {
    const value = this.textarea.value || '';
    const lines = value.split('\n');
    this.gutter.replaceChildren(...lines.map((_, index) => {
      const line = document.createElement('span');
      line.className = 'code-line-number';
      line.textContent = String(index + 1);
      return line;
    }));
    this.highlight.innerHTML = `${tokenize(value, this.mode)}\n`;
    this.refreshGutterMetrics(lines);
    this.syncScroll();
  }

  refreshGutterMetrics(lines = (this.textarea.value || '').split('\n')) {
    const lineHeight = parseFloat(getComputedStyle(this.textarea).lineHeight) || 22;
    const locator = createTextRangeLocator(this.highlight);
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const range = locator?.rangeFor(offset, offset + line.length);
      const rects = range ? [...range.getClientRects()].filter((rect) => rect.height > 0) : [];
      const height = rects.length
        ? Math.max(lineHeight, Math.max(...rects.map((rect) => rect.bottom)) - Math.min(...rects.map((rect) => rect.top)))
        : lineHeight;
      const gutterLine = this.gutter.children[index];
      if (gutterLine) gutterLine.style.height = `${height}px`;
      offset += line.length + 1;
    }
  }

  syncScroll() {
    if (this._syncing) return;
    this._syncing = true;
    this.highlight.parentElement.scrollLeft = this.textarea.scrollLeft;
    this.highlight.parentElement.scrollTop = this.textarea.scrollTop;
    this.gutter.scrollTop = this.textarea.scrollTop;
    this._syncing = false;
  }

  setSelection(start, end = start) {
    this.textarea.setSelectionRange(Math.max(0, start), Math.max(0, end));
    this.textarea.focus();
    this.dispatchEvent(new CustomEvent('caret', { detail: this.selection }));
  }

  replaceRange(start, end, replacement, { select = false } = {}) {
    const value = this.textarea.value;
    const result = value.slice(0, start) + replacement + value.slice(end);
    this.textarea.value = result;
    const caret = start + replacement.length;
    this.textarea.setSelectionRange(select ? start : caret, caret);
    this.value = result;
    this.refresh();
    this.onChange?.(result);
    this.dispatchEvent(new CustomEvent('change', { detail: { value: result, programmatic: true } }));
  }

  replaceSelection(replacement) {
    const { start, end } = this.selection;
    this.replaceRange(start, end, replacement, { select: false });
  }

  insertText(text) {
    this.replaceSelection(text);
  }

  scrollToOffset(offset, { focus = true } = {}) {
    const safeOffset = Math.max(0, Math.min(Number(offset) || 0, this.textarea.value.length));
    const range = createTextRangeLocator(this.highlight)?.rangeFor(safeOffset, safeOffset);
    const highlightBox = this.highlight.parentElement.getBoundingClientRect();
    const rect = range?.getBoundingClientRect();
    const targetTop = rect ? this.textarea.scrollTop + rect.top - highlightBox.top : null;
    const targetLeft = rect ? this.textarea.scrollLeft + rect.left - highlightBox.left : null;
    this.textarea.setSelectionRange(safeOffset, safeOffset);
    if (focus) this.textarea.focus({ preventScroll: true });
    if (targetTop !== null) {
      this.textarea.scrollTop = Math.max(0, targetTop - this.textarea.clientHeight * .35);
      this.textarea.scrollLeft = Math.max(0, targetLeft - this.textarea.clientWidth * .25);
    }
    this.syncScroll();
    this.dispatchEvent(new CustomEvent('caret', { detail: this.selection }));
  }

  handleKeydown(event) {
    if (this.readOnly) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      const { start, end } = this.selection;
      if (start !== end || event.shiftKey) {
        const value = this.textarea.value;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEndIndex = value.indexOf('\n', end);
        const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
        const selected = value.slice(lineStart, lineEnd);
        const changed = event.shiftKey
          ? selected.replace(/^ {1,2}/gm, '')
          : selected.replace(/^/gm, '  ');
        this.replaceRange(lineStart, lineEnd, changed);
        this.setSelection(lineStart, lineStart + changed.length);
      } else {
        this.insertText('  ');
      }
      return;
    }
    if (event.key === 'Enter') {
      const { start } = this.selection;
      const before = this.textarea.value.slice(0, start);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const indent = line.match(/^\s*/)?.[0] || '';
      const extra = /[{[(>]$/.test(line.trim()) ? '  ' : '';
      if (indent || extra) {
        event.preventDefault();
        this.insertText(`\n${indent}${extra}`);
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === '/') {
      event.preventDefault();
      this.toggleComment();
    }
  }

  toggleComment() {
    const { start, end } = this.selection;
    const value = this.textarea.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const nextBreak = value.indexOf('\n', end);
    const lineEnd = nextBreak < 0 ? value.length : nextBreak;
    const block = value.slice(lineStart, lineEnd);
    const prefix = this.mode === 'css' ? '/* ' : '<!-- ';
    const suffix = this.mode === 'css' ? ' */' : ' -->';
    const changed = block.split('\n').map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(prefix) && trimmed.endsWith(suffix)) {
        return line.replace(prefix, '').replace(new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '');
      }
      return prefix + line + suffix;
    }).join('\n');
    this.replaceRange(lineStart, lineEnd, changed);
    this.setSelection(lineStart, lineStart + changed.length);
  }

  deleteLine() {
    const { start } = this.selection;
    const value = this.textarea.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const nextBreak = value.indexOf('\n', start);
    const lineEnd = nextBreak < 0 ? value.length : nextBreak + 1;
    this.replaceRange(lineStart, lineEnd, '');
  }
}

function createTextRangeLocator(root) {
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let length = 0;
  let node;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: length, end: length + node.data.length });
    length += node.data.length;
  }
  if (!nodes.length) return null;

  const pointAt = (offset) => {
    const target = Math.max(0, Math.min(offset, length));
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (target <= nodes[middle].end) high = middle;
      else low = middle + 1;
    }
    const entry = nodes[low];
    return [entry.node, Math.max(0, target - entry.start)];
  };

  return {
    rangeFor(start, end = start) {
      const range = document.createRange();
      const [startNode, startOffset] = pointAt(start);
      const [endNode, endOffset] = pointAt(end);
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    },
  };
}
