'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const APP_NAME = 'EPUB Studio';
const DEFAULT_SETTINGS = {
  theme: 'system',
  fontFamily: 'Georgia, "Songti SC", serif',
  fontSize: 18,
  readingWidth: 760,
  lineWrapping: true,
  spellcheck: true,
  spellcheckLanguages: ['en-US'],
  showRecentFiles: true,
  recentFiles: [],
};

let mainWindow = null;
let pendingOpenPath = null;
let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    const raw = await fsp.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    settings = { ...DEFAULT_SETTINGS, ...parsed };
    if (!Array.isArray(settings.recentFiles)) settings.recentFiles = [];
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

async function persistSettings() {
  await fsp.mkdir(path.dirname(settingsPath()), { recursive: true });
  const temp = `${settingsPath()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(settings, null, 2));
  await fsp.rename(temp, settingsPath());
}

function sendCommand(command, payload = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:command', { command, payload });
  }
}

function action(label, command, accelerator, options = {}) {
  return { label, accelerator, ...options, click: () => sendCommand(command) };
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建 EPUB 2', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-epub2') },
        { label: '新建 EPUB 3', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendCommand('new-epub3') },
        { type: 'separator' },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
        ...(settings.showRecentFiles ? [{
          label: '打开最近文件',
          submenu: settings.recentFiles.length
            ? settings.recentFiles.map((file) => ({
                label: path.basename(file),
                toolTip: file,
                click: () => sendCommand('open-path', file),
              })).concat([
                { type: 'separator' },
                { label: '清除最近记录', click: () => clearRecent() },
              ])
            : [{ label: '暂无', enabled: false }],
        }, { type: 'separator' }] : []),
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('save-as') },
        { label: '保存副本…', click: () => sendCommand('save-copy') },
        { type: 'separator' },
        {
          label: '添加',
          submenu: [
            { label: '添加现有文件…', accelerator: 'CmdOrCtrl+Alt+A', click: () => sendCommand('add-files') },
            { type: 'separator' },
            { label: '新建 XHTML 章节', click: () => sendCommand('new-resource', { type: 'xhtml' }) },
            { label: '新建样式表', click: () => sendCommand('new-resource', { type: 'css' }) },
            { label: '新建 JavaScript', click: () => sendCommand('new-resource', { type: 'js' }) },
            { label: '新建 SVG', click: () => sendCommand('new-resource', { type: 'svg' }) },
            { label: '导入 HTML…', click: () => sendCommand('import-html') },
            { label: '导入纯文本…', click: () => sendCommand('import-text') },
          ],
        },
        { type: 'separator' },
        { label: '打印…', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('print') },
        { label: '导出 PDF…', click: () => sendCommand('export-pdf') },
        { type: 'separator' },
        { label: '关闭书籍', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('close-book') },
        { label: '退出', role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => sendCommand('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendCommand('redo') },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', click: () => sendCommand('cut') },
        { label: '复制', accelerator: 'CmdOrCtrl+C', click: () => sendCommand('copy') },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', click: () => sendCommand('paste') },
        { label: '全选', accelerator: 'CmdOrCtrl+A', click: () => sendCommand('select-all') },
        { label: '删除当前行', accelerator: 'CmdOrCtrl+K', click: () => sendCommand('delete-line') },
        { type: 'separator' },
        {
          label: '更改大小写',
          submenu: [
            { label: '小写', click: () => sendCommand('case-lower') },
            { label: '大写', click: () => sendCommand('case-upper') },
            { label: '标题式', click: () => sendCommand('case-title') },
            { label: '句首大写', click: () => sendCommand('case-capitalize') },
          ],
        },
        { label: '拆分章节', accelerator: 'CmdOrCtrl+Alt+S', click: () => sendCommand('split-section') },
        { type: 'separator' },
        { label: '首选项…', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('preferences') },
      ],
    },
    {
      label: '插入',
      submenu: [
        { label: '特殊字符…', click: () => sendCommand('insert-character') },
        { label: '图片…', click: () => sendCommand('insert-image') },
        { label: '链接…', accelerator: 'CmdOrCtrl+L', click: () => sendCommand('insert-link') },
        { label: 'ID…', click: () => sendCommand('insert-id') },
        { label: '分节标记', click: () => sendCommand('insert-section-break') },
        { type: 'separator' },
        { label: '无序列表', click: () => sendCommand('insert-ul') },
        { label: '有序列表', click: () => sendCommand('insert-ol') },
        { label: '脚注引用', click: () => sendCommand('insert-footnote') },
        { label: '替换为剪贴板片段…', click: () => sendCommand('insert-clip') },
      ],
    },
    {
      label: '格式',
      submenu: [
        {
          label: '标题',
          submenu: [1, 2, 3, 4, 5, 6].map((level) => ({
            label: `标题 ${level}`,
            accelerator: `CmdOrCtrl+${level}`,
            click: () => sendCommand('heading', { level }),
          })).concat([{ label: '正文', accelerator: 'CmdOrCtrl+0', click: () => sendCommand('heading', { level: 0 }) }]),
        },
        { type: 'separator' },
        action('粗体', 'bold', 'CmdOrCtrl+B'),
        action('斜体', 'italic', 'CmdOrCtrl+I'),
        action('下划线', 'underline', 'CmdOrCtrl+U'),
        action('删除线', 'strike', 'CmdOrCtrl+Alt+X'),
        action('下标', 'subscript'),
        action('上标', 'superscript'),
        { type: 'separator' },
        action('左对齐', 'align-left', 'CmdOrCtrl+Shift+L'),
        action('居中', 'align-center', 'CmdOrCtrl+E'),
        action('右对齐', 'align-right', 'CmdOrCtrl+Shift+R'),
        action('两端对齐', 'align-justify', 'CmdOrCtrl+J'),
        action('增加缩进', 'indent'),
        action('减少缩进', 'outdent'),
        { type: 'separator' },
        { label: '设为代码 / 去除代码', click: () => sendCommand('toggle-code') },
        { label: '清理内联样式', click: () => sendCommand('clean-inline') },
        { label: '智能标点', click: () => sendCommand('smart-punctuation') },
      ],
    },
    {
      label: '视图',
      submenu: [
        action('HTML 编辑模式', 'mode-html', 'CmdOrCtrl+Alt+1'),
        action('预览文本编辑模式', 'mode-preview', 'CmdOrCtrl+Alt+2'),
        action('纯阅读模式', 'mode-read', 'CmdOrCtrl+Alt+3'),
        { type: 'separator' },
        { label: '书籍浏览器', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendCommand('toggle-left') },
        { label: '目录与书签', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendCommand('toggle-right') },
        { type: 'separator' },
        action('放大', 'zoom-in', 'CmdOrCtrl+='),
        action('缩小', 'zoom-out', 'CmdOrCtrl+-'),
        action('重置缩放', 'zoom-reset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        action('浅色主题', 'theme-light'),
        action('深色主题', 'theme-dark'),
        action('跟随系统', 'theme-system'),
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '工具',
      submenu: [
        action('查找与替换…', 'find', 'CmdOrCtrl+F'),
        action('全书查找…', 'find-all', 'CmdOrCtrl+Shift+F'),
        action('拼写检查', 'toggle-spellcheck'),
        { type: 'separator' },
        action('元数据编辑器', 'show-metadata'),
        action('目录编辑器', 'show-toc'),
        action('从标题生成目录', 'generate-toc', 'CmdOrCtrl+Shift+G'),
        action('书签编辑器', 'show-bookmarks'),
        action('图片管理器', 'show-images'),
        action('Inspector', 'show-inspector'),
        { type: 'separator' },
        action('验证 EPUB', 'validate', 'CmdOrCtrl+Shift+V'),
        action('链接检查', 'check-links'),
        action('生成报告', 'reports'),
        action('美化 XML/HTML', 'prettify'),
        action('美化 CSS', 'format-css'),
        { type: 'separator' },
        { label: '重新加载资源', click: () => sendCommand('reload-preview') },
      ],
    },
    {
      label: '帮助',
      submenu: [
        action('功能与快捷键', 'help'),
        { label: '关于 EPUB Studio', click: () => sendCommand('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function chooseEpubPath({ save = false } = {}) {
  const options = {
    title: save ? '保存 EPUB' : '打开 EPUB',
    defaultPath: save ? path.join(app.getPath('documents'), 'book.epub') : app.getPath('documents'),
    filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
    properties: save ? [] : ['openFile'],
  };
  return save ? dialog.showSaveDialog(mainWindow, options) : dialog.showOpenDialog(mainWindow, options);
}

async function addRecent(filePath) {
  const normalized = path.resolve(filePath);
  settings.recentFiles = [normalized, ...settings.recentFiles.filter((item) => item !== normalized)].slice(0, 12);
  await persistSettings();
  buildMenu();
  return settings.recentFiles;
}

async function removeRecent(filePath) {
  const normalized = path.resolve(filePath);
  settings.recentFiles = settings.recentFiles.filter((item) => item !== normalized);
  await persistSettings();
  buildMenu();
  return settings.recentFiles;
}

async function clearRecent() {
  settings.recentFiles = [];
  await persistSettings();
  buildMenu();
  sendCommand('recent-cleared');
  return settings.recentFiles;
}

function registerIpc() {
  ipcMain.handle('dialog:open-epub', async () => {
    const result = await chooseEpubPath();
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const data = await fsp.readFile(filePath);
    await addRecent(filePath);
    return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
  });

  ipcMain.handle('file:read-epub', async (_event, filePath) => {
    const data = await fsp.readFile(filePath);
    await addRecent(filePath);
    return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
  });

  ipcMain.handle('dialog:save-epub', async (_event, { data, currentPath, saveCopy }) => {
    let target = currentPath;
    if (!target || saveCopy) {
      const result = await chooseEpubPath({ save: true });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath.endsWith('.epub') ? result.filePath : `${result.filePath}.epub`;
    }
    await fsp.writeFile(target, Buffer.from(data));
    await addRecent(target);
    return target;
  });

  ipcMain.handle('dialog:save-text', async (_event, { content, defaultName = 'export.txt', filters = [] }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters,
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, content, 'utf8');
    return result.filePath;
  });

  ipcMain.handle('dialog:open-text', async (_event, { filters = [], multiple = false } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters,
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(async (filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      data: new Uint8Array(await fsp.readFile(filePath)),
    })));
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('settings:get', () => ({ ...settings }));
  ipcMain.handle('settings:update', async (_event, patch) => {
    settings = { ...settings, ...patch };
    if (settings.theme && ['system', 'light', 'dark'].includes(settings.theme)) {
      nativeTheme.themeSource = settings.theme;
    }
    if (mainWindow) {
      mainWindow.webContents.session.setSpellCheckerEnabled(Boolean(settings.spellcheck));
      if (settings.spellcheckLanguages?.length) {
        try { mainWindow.webContents.session.setSpellCheckerLanguages(settings.spellcheckLanguages); } catch {}
      }
    }
    await persistSettings();
    buildMenu();
    return { ...settings };
  });
  ipcMain.handle('settings:remove-recent', (_event, filePath) => removeRecent(filePath));
  ipcMain.handle('settings:clear-recent', () => clearRecent());

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
  }));

  ipcMain.handle('print:preview', async () => {
    if (!mainWindow) return false;
    return new Promise((resolve) => mainWindow.webContents.print({ printBackground: true }, (ok) => resolve(ok)));
  });

  ipcMain.handle('print:pdf', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), 'book.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const pdf = await mainWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    await fsp.writeFile(result.filePath, pdf);
    return result.filePath;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1080,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: '#10151b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const labels = ['verbose', 'info', 'warning', 'error'];
    console.log(`[renderer:${labels[level] || level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`Failed to load ${url}: ${code} ${description}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (pendingOpenPath) {
      sendCommand('open-path', pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 8)) {
          template.push({ label: suggestion, click: () => mainWindow.webContents.replaceMisspelling(suggestion) });
        }
      } else {
        template.push({ label: '无拼写建议', enabled: false });
      }
      template.push({ type: 'separator' });
    }
    const roles = [];
    if (params.isEditable) {
      roles.push({ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { type: 'separator' }, { role: 'selectAll', label: '全选' });
    } else if (params.selectionText) {
      roles.push({ role: 'copy', label: '复制' }, { role: 'selectAll', label: '全选' });
    }
    if (params.linkURL) {
      if (roles.length) roles.push({ type: 'separator' });
      roles.push({ label: '打开链接', click: () => shell.openExternal(params.linkURL) });
      roles.push({ label: '复制链接', click: () => require('electron').clipboard.writeText(params.linkURL) });
    }
    if (roles.length) template.push(...roles);
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const candidate = argv.find((arg) => arg.toLowerCase().endsWith('.epub'));
    if (candidate) {
      if (mainWindow) sendCommand('open-path', path.resolve(candidate));
      else pendingOpenPath = path.resolve(candidate);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow) sendCommand('open-path', filePath);
    else pendingOpenPath = filePath;
  });

  app.whenReady().then(async () => {
    await loadSettings();
    nativeTheme.themeSource = settings.theme || 'system';
    registerIpc();
    buildMenu();
    createWindow();
    if (mainWindow) {
      mainWindow.webContents.session.setSpellCheckerEnabled(Boolean(settings.spellcheck));
      if (settings.spellcheckLanguages?.length) {
        try { mainWindow.webContents.session.setSpellCheckerLanguages(settings.spellcheckLanguages); } catch {}
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
