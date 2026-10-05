# EPUB Studio

EPUB Studio 是一个基于 Electron 的跨平台 EPUB 2/3 阅读与编辑工具。它将 Sigil 的书籍工程能力与 PageEdit 的可视化 XHTML 编辑整合到同一个窗口：正文可在 HTML 源码、预览文本编辑和纯阅读三种模式间切换，右侧栏持续提供目录、书签、Inspector、元数据和校验报告。

参考工程位于 `reference/Sigil/` 与 `reference/PageEdit/`，仅用于研究功能模型、菜单流程和数据组织方式；本项目不编译或链接其中的 Qt/C++ 代码。

## 已实现能力

### EPUB 工程

- 打开、解析、编辑和重新打包 EPUB 2 / EPUB 3。
- 识别 `META-INF/container.xml`、OPF、Manifest、Spine、Guide。
- 编辑书名、作者及角色、语言、标识符、出版者、日期、版权、简介和主题。
- 新增、导入、重命名、删除资源；重命名时自动修正 HTML、XHTML、CSS 和 Guide 引用。
- 独立图片管理器：缩略图、尺寸和使用位置统计，支持插入正文、替换图片以及一键删除未使用图片。
- HTML/XHTML、CSS、JavaScript、JSON、XML、SVG 源码编辑与语法着色。
- 图片、音频、视频、PDF 预览和资源信息展示。
- 生成 EPUB 时保持 `mimetype` 为第一项且不压缩。

### 三种正文模式

- **HTML 编辑模式**：直接编辑章节 XHTML/HTML，适合精确控制标签和属性。
- **预览文本编辑模式**：基于 Chromium contenteditable 的 WYSIWYG 编辑，保留 CSS 渲染，修改实时同步回 XHTML。
- **纯阅读模式**：不执行章节脚本，保留样式和媒体资源，提供阅读宽度、缩放和 Spine 前后翻页。

格式化工具覆盖标题、粗体、斜体、下划线、删除线、上下标、列表、对齐、缩进、链接、图片、ID、特殊字符、脚注引用、分节标记、大小写转换、智能标点、去除内联样式。HTML 和预览编辑模式均支持标题与对齐快捷键。

左右侧栏默认展开，可通过顶部“左栏/右栏”按钮或 `Cmd/Ctrl+Shift+B`、`Cmd/Ctrl+Shift+T` 收起和恢复。

### 目录与书签

- 目录支持新增、添加子项、重命名、删除、上下移动、缩进和提升层级。
- 可从正文 H1-H6 标题自动生成层级目录；带有 `sigil_not_in_toc` 或 `epub-studio-not-in-toc` 类的标题会自动跳过。
- 保存时同步维护 EPUB 3 Navigation Document 和 EPUB 2 NCX。
- 书签支持添加当前位置、重命名、删除、跳转、导入和导出 JSON。
- 每本书按 OPF 标识符独立保存书签，浏览位置包含章节路径、锚点和阅读百分比；新书签默认使用章节名。

### 查找、校验与报告

- 左侧栏提供当前文件或全书查找替换，支持正则、大小写、全词匹配、结果导航和逐项/全部替换。
- 查找结果按文件、行、列展示，并可直接定位。
- 结构校验覆盖容器、mimetype、OPF、Manifest、Spine、资源缺失、XML、重复 ID、锚点和活动内容。
- 链接检查覆盖文件目标与 `#fragment` 锚点。
- 报告包含文件清单、总字数、字符数、段落、标题、CSS 类和高频选择器。
- 报告可导出 HTML 或 UTF-8 CSV。

### 桌面集成

- 原生应用菜单、最近文件、文件关联、系统剪贴板与拼写检查。
- 首页最近打开记录支持悬浮删除单条记录，也可在首选项中选择隐藏最近打开。
- 浅色、深色、跟随系统三种主题。
- 打印和 PDF 导出。
- Windows 文件锁与 macOS Dock/文件打开事件。
- 沙箱化渲染进程、上下文隔离、外链白名单和禁止任意导航。

## 与 Sigil / PageEdit 的功能映射

| 参考能力 | EPUB Studio 实现 |
|---|---|
| Sigil Book Browser / OPF Model | 左侧书籍浏览器，按目录分组显示 Manifest、媒体类型和 Spine 序号 |
| Sigil Code View / CSS Editor | 内置代码编辑器、语法着色、行号、Tab/注释/自动缩进 |
| Sigil Metadata Editor | 右侧元数据表单与作者角色编辑 |
| Sigil TOC Editor | 右侧层级目录编辑并写回 Nav/NCX |
| Sigil Generate TOC | 从正文 H1-H6 标题生成层级目录 |
| Sigil Image Manager | 图片缩略图、引用统计、插入、替换和删除未使用图片 |
| Sigil Find & Replace | 当前文件/全书、正则、替换全部和结果定位 |
| Sigil Reports / Validation | 报告、链接检查和 EPUB 结构验证 |
| Sigil Clips | 持久化片段库，可保存选区并重新插入 |
| PageEdit Book View | 预览文本编辑模式 |
| PageEdit Inspector | 右侧 Inspector，可编辑标签属性和文本 |
| PageEdit Insert | 链接、图片、特殊字符、ID、列表和脚注引用 |
| PageEdit Formatting | 标题、字符格式、对齐、缩进、列表和大小写 |
| PageEdit Read | 无脚本纯阅读模式与阅读位置书签 |

## 开发

环境要求：Node.js 22 或更新版本、npm 10 或更新版本。

```bash
npm install
npm start
```

如果网络无法访问 GitHub 下载 Electron，可指定镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

运行测试：

```bash
npm test
```

开发模式下可使用 `<Cmd/Ctrl>+Shift+I` 打开 DevTools。

## 打包

```bash
npm run dist:dir     # 当前平台未打包目录，用于快速验证
npm run dist:mac     # macOS x64 + arm64：DMG、ZIP
npm run dist:win     # Windows x64 + arm64：NSIS EXE、便携 EXE
```

输出位于 `dist/`。未配置证书时 macOS 产物不做签名或公证；正式分发时应在环境下设置 `CSC_LINK`、`CSC_KEY_PASSWORD`，并补充 Apple notarization。Windows 可通过 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD` 配置代码签名。

应用图标位于 `build/icon.svg` 和 `build/icon.png`。`package.json` 的 `fileAssociations` 会将 `.epub` 关联到应用。

## GitHub Actions

`.github/workflows/build.yml` 在 push、Pull Request 和手动触发时运行：

1. Ubuntu 上执行单元测试。
2. Windows 构建 x64、arm64 安装包和便携版。
3. macOS 构建 x64、arm64 DMG/ZIP。
4. 上传各平台构建产物。
5. 推送 `v*` 标签时自动创建 GitHub Release 并附加安装包。

## 快捷键

| 功能 | macOS | Windows |
|---|---|---|
| 打开 | `Cmd+O` | `Ctrl+O` |
| 保存 | `Cmd+S` | `Ctrl+S` |
| 查找替换 | `Cmd+F` | `Ctrl+F` |
| 全书查找 | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| HTML 模式 | `Cmd+Alt+1` | `Ctrl+Alt+1` |
| 预览编辑 | `Cmd+Alt+2` | `Ctrl+Alt+2` |
| 纯阅读 | `Cmd+Alt+3` | `Ctrl+Alt+3` |
| 标题 1-6 | `Cmd+1` … `Cmd+6` | `Ctrl+1` … `Ctrl+6` |
| 正文段落 | `Cmd+0` / `Cmd+7` | `Ctrl+0` / `Ctrl+7` |
| 左对齐 | `Cmd+Shift+L` | `Ctrl+Shift+L` |
| 居中 | `Cmd+E` | `Ctrl+E` |
| 右对齐 | `Cmd+Shift+R` | `Ctrl+Shift+R` |
| 两端对齐 | `Cmd+J` | `Ctrl+J` |
| 粗体 / 斜体 / 下划线 | `Cmd+B` / `Cmd+I` / `Cmd+U` | `Ctrl+B` / `Ctrl+I` / `Ctrl+U` |
| 从标题生成目录 | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| 验证 | `Cmd+Shift+V` | `Ctrl+Shift+V` |

## 工程结构

```text
src/main/main.cjs                 Electron 主进程、菜单、文件与系统集成
src/preload/preload.cjs           最小 IPC 安全桥
src/renderer/index.html           应用壳层
src/renderer/styles.css           主题、工作区、编辑器和面板样式
src/renderer/app.mjs              工作区状态、三模式、页面操作与面板
src/renderer/core/epub.mjs        EPUB/OPF/Spine/TOC/NCX 领域模型与验证
src/renderer/core/search.mjs      正则查找替换与全书搜索
src/renderer/core/utils.mjs       路径、XML、CSS、格式化等基础能力
src/renderer/ui/code-editor.mjs   源码编辑器、语法着色与行号
src/renderer/ui/dialogs.mjs       通用表单、确认框、上下文菜单
test/                             Node 单元测试
```

## 数据与安全

书籍内容只在本地内存中处理，只有用户主动执行保存时才写出 EPUB。书签和片段保存在 Electron 用户数据目录对应的 Chromium Local Storage 中。章节脚本在阅读和预览 iframe 中不会执行，外部链接由主进程验证后交给系统浏览器打开。

## 许可证

EPUB Studio 以 GPL-3.0-or-later 发布。Sigil 与 PageEdit 的功能研究和接口命名依据其 GPLv3 开源实现；详见 `NOTICE`。
