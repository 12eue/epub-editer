import { escapeHtml, formatBytes } from '../core/utils.mjs';

function modalRoot() {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.append(root);
  }
  return root;
}

export function showModal({
  title,
  body = '',
  fields = [],
  actions = [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: '确定', kind: 'primary' }],
  className = '',
  width = '',
  onMount = null,
  closeOnBackdrop = false,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `
      <section class="modal ${className}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" ${width ? `style="--modal-width:${escapeHtml(width)}"` : ''}>
        <header class="modal-header">
          <h2>${escapeHtml(title)}</h2>
          <button class="icon-button modal-close" type="button" aria-label="关闭">×</button>
        </header>
        <form class="modal-form">
          <div class="modal-body">${body}</div>
          <footer class="modal-footer">
            ${actions.map((action) => `<button type="button" class="button ${escapeHtml(action.kind || 'ghost')}" data-action="${escapeHtml(action.id)}" ${action.disabled ? 'disabled' : ''}>${escapeHtml(action.label)}</button>`).join('')}
          </footer>
        </form>
      </section>`;
    modalRoot().append(overlay);

    const form = overlay.querySelector('.modal-form');
    for (const field of fields) {
      const wrapper = document.createElement('label');
      wrapper.className = `field ${field.wide ? 'wide' : ''}`;
      wrapper.innerHTML = `<span>${escapeHtml(field.label || field.name)}</span>`;
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        for (const option of field.options || []) {
          const optionElement = document.createElement('option');
          optionElement.value = option.value ?? option;
          optionElement.textContent = option.label ?? option;
          if (optionElement.value === String(field.value ?? '')) optionElement.selected = true;
          input.append(optionElement);
        }
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = field.rows || 5;
        input.value = field.value ?? '';
      } else {
        input = document.createElement('input');
        input.type = field.type || 'text';
        input.value = field.value ?? '';
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
        if (field.step !== undefined) input.step = field.step;
      }
      input.name = field.name;
      input.required = Boolean(field.required);
      if (field.autofocus) input.autofocus = true;
      wrapper.append(input);
      if (field.help) {
        const help = document.createElement('small');
        help.textContent = field.help;
        wrapper.append(help);
      }
      form.querySelector('.modal-body').append(wrapper);
    }

    const close = (result) => {
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 140);
      resolve(result);
    };

    overlay.querySelector('.modal-close').addEventListener('click', () => close({ action: 'cancel', values: collect() }));
    if (closeOnBackdrop) overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close({ action: 'cancel', values: collect() });
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close({ action: 'cancel', values: collect() });
      if (event.key === 'Enter' && event.metaKey) close({ action: actions.at(-1)?.id || 'ok', values: collect() });
      if (event.key === 'Tab') {
        const focusable = [...overlay.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )].filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });

    function collect() {
      const values = {};
      for (const element of form.elements) {
        if (!element.name) continue;
        if (element.type === 'checkbox') values[element.name] = element.checked;
        else if (element.type === 'number') values[element.name] = Number(element.value);
        else values[element.name] = element.value;
      }
      return values;
    }

    for (const button of overlay.querySelectorAll('[data-action]')) {
      button.addEventListener('click', () => {
        if (!form.reportValidity()) return;
        const config = actions.find((item) => item.id === button.dataset.action);
        if (config?.onClick && config.onClick({ button, values: collect(), close, overlay }) === false) return;
        close({ action: button.dataset.action, values: collect(), target: button });
      });
    }

    onMount?.(overlay.querySelector('.modal-body'), overlay, close, collect);

    const focusInitial = () => {
      if (!overlay.isConnected) return;
      const target = overlay.querySelector('[autofocus]')
        || overlay.querySelector('.modal-body input, .modal-body textarea, .modal-body select');
      if (!target || document.activeElement === target) return;
      target.focus({ preventScroll: true });
    };

    // Focus synchronously so keystrokes cannot fall through to the editor iframe.
    focusInitial();
    requestAnimationFrame(focusInitial);
  });
}

export async function promptDialog({
  title = '输入',
  label = '内容',
  value = '',
  placeholder = '',
  confirmLabel = '确定',
  required = true,
  type = 'text',
  help = '',
} = {}) {
  const result = await showModal({
    title,
    fields: [{ name: 'value', label, value, placeholder, required, type, autofocus: true, help }],
    actions: [{ id: 'cancel', label: '取消', kind: 'ghost' }, { id: 'ok', label: confirmLabel, kind: 'primary' }],
  });
  return result.action === 'ok' ? String(result.values.value ?? '') : null;
}

export async function confirmDialog({ title = '确认', message = '', confirmLabel = '确定', danger = false } = {}) {
  const result = await showModal({
    title,
    body: `<p class="modal-message">${escapeHtml(message)}</p>`,
    actions: [
      { id: 'cancel', label: '取消', kind: 'ghost' },
      { id: 'ok', label: confirmLabel, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return result.action === 'ok';
}

export async function alertDialog({ title = '提示', message = '', detail = '' } = {}) {
  await showModal({
    title,
    body: `<p class="modal-message">${escapeHtml(message)}</p>${detail ? `<pre class="modal-detail">${escapeHtml(detail)}</pre>` : ''}`,
    actions: [{ id: 'ok', label: '关闭', kind: 'primary' }],
  });
}

export async function choiceDialog({
  title = '选择',
  message = '',
  choices = [],
  cancelLabel = '取消',
} = {}) {
  const html = `${message ? `<p class="modal-message">${escapeHtml(message)}</p>` : ''}<div class="choice-list">${choices.map((choice, index) => `
    <button type="button" class="choice-card" data-choice="${index}">
      ${choice.icon ? `<span class="choice-icon">${escapeHtml(choice.icon)}</span>` : ''}
      <span><strong>${escapeHtml(choice.label)}</strong>${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ''}</span>
    </button>`).join('')}</div>`;
  const result = await showModal({
    title,
    body: html,
    actions: [{ id: 'cancel', label: cancelLabel, kind: 'ghost' }],
    onMount(body, overlay, close) {
      for (const button of body.querySelectorAll('[data-choice]')) {
        button.addEventListener('click', () => close({ action: 'choice', choice: choices[Number(button.dataset.choice)] }));
      }
    },
  });
  return result.action === 'choice' ? result.choice : null;
}

export function showContextMenu(items, x, y) {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = items.map((item, index) => item.separator
    ? '<div class="context-separator"></div>'
    : `<button type="button" data-index="${index}" ${item.disabled ? 'disabled' : ''}>${escapeHtml(item.label)}</button>`).join('');
  document.body.append(menu);
  const maxX = window.innerWidth - menu.offsetWidth - 8;
  const maxY = window.innerHeight - menu.offsetHeight - 8;
  menu.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
  const close = () => menu.remove();
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const item = items[Number(button.dataset.index)];
    close();
    item.action?.();
  });
  setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
}

export async function importBookmarksDialog() {
  return window.studio.openTextFiles([{ name: '书签 JSON', extensions: ['json'] }], false);
}

export function reportHtml(title, rows) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:40px;color:#20252b}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}th{background:#f3f5f7}</style>
</head><body><h1>${escapeHtml(title)}</h1><table><thead><tr>${Object.keys(rows[0] || {}).map((key) => `<th>${escapeHtml(key)}</th>`).join('')}</tr></thead><tbody>
${rows.map((row) => `<tr>${Object.values(row).map((value) => `<td>${escapeHtml(typeof value === 'number' ? String(value) : value)}</td>`).join('')}</tr>`).join('')}
</tbody></table></body></html>`;
}

export function resourceInfoRows(entries) {
  return entries.map((item) => ({ 文件: item.path, 类型: item.mediaType, 大小: item.sizeLabel || formatBytes(item.bytes?.byteLength || 0) }));
}
