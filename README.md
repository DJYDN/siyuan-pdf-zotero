# SiYuan PDF × Zotero

[![SiYuan](https://img.shields.io/badge/SiYuan-3.8.7%2B-4f63d2)](https://b3log.org/siyuan/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在思源笔记中直接阅读本地 PDF 或 Zotero PDF，并提供 PDF++ 风格的标注、摘录、双向链接、悬浮预览、Zotero 检索、结构化引文、AI 问答与翻译工作流。

> 本项目只使用思源公开插件 API。不会修改 `.sy` 文件、不会写入 Zotero 数据库，也不会修改原始 PDF。

当前版本：**0.9.17**（更新记录见 [CHANGELOG.md](CHANGELOG.md)）

---

## 功能

### PDF 阅读

- 在思源标签页中打开本地 PDF；
- 从 Zotero Local API 打开 PDF，或使用离线缓存；
- 目录、页码跳转、前进/后退、缩放、适合宽度；
- PDF 全文搜索、搜索结果定位；
- 阅读位置记忆；
- 多 PDF 标签页与会话恢复。

### 标注与笔记

- 文本选择、高亮、摘录；
- 颜色选择、链接格式、显示文本格式；
- 高亮内容插入思源笔记；
- PDF 矩形区域截图并插入笔记；
- 点击笔记中的标注链接回到 PDF 原位；
- 标注反向定位到关联笔记块；
- 悬浮预览：PDF 内链、标注卡片、笔记反链；
- 可选的 PDF 内嵌标注写入（B 计划，默认关闭）。

### Zotero 与引文

- Zotero 7+ Local API；
- 文献标题/作者/DOI 搜索；
- 按 Collection 过滤；
- 插入结构化引文链接；
- 内置 **121 种 CSL 引用样式**，默认展示 5 种通用样式，可搜索选择更多；
- citeproc-js 生成参考文献；
- 引文编号按文档顺序刷新；
- 引文编辑、删除、样式切换；
- 参考文献自动生成与更新；
- 阅读中 / 最近 / Zotero 条目右键支持“用所选条目创建参考文献”。

### PDF AI 问答

- 右侧独立 Q&A 面板，可停靠/浮动；
- 浮动窗支持拖拽、拖角调整宽高，并记住尺寸；
- 默认带选区/当前页及前后文；
- 支持“问全文”检索；
- 流式输出，不支持 SSE 的服务自动逐字渐显；
- Markdown 标题、列表、表格、代码、KaTeX 公式渲染；
- 回答可选中，右键复制、复制为引用、插入笔记、全选；
- 回答可插入为带边框的 Q/A 块；
- Q/A 块标题、圆角、边框、背景、字体、字号、Q/A 颜色可配置；
- 一个 PDF 支持多个独立会话，会话可置顶、重命名、分享、多选、删除；
- 右侧 prompt navigator 按轮次导航。

### 翻译

- 选区翻译：多翻译服务适配；
- 自动翻译、翻译弹窗、复制译文、写入标注；
- 复制译文可选附带原文回跳链接；
- 整篇 PDF 翻译：
  - **Doc2X CLI**：解析/翻译为 Markdown 到笔记、保留排版 PDF、双语排版 PDF；
  - **PDF2zh**：本地服务，可选便携包，支持实时进度、日志、中文字体与源语言设置；
- 翻译历史可查看、右键管理、置顶文章、打开原文/译文、打开文件位置、删除记录；
- 可配置翻译输出目录。

### 条目右键菜单

阅读中 / 最近 / Zotero 条目右键支持：

```text
打开译文
置顶 / 取消置顶
打开文件所在位置
用所选条目创建参考文献
Doc2X ›
打开 PDF
```

Doc2X 二级菜单：

```text
翻译PDF为Md到笔记
解析PDF为Md到笔记
保留排版翻译
双语对照+排版翻译(Pro专属)
────────────────────
Doc2x:打开报错日志目录
```

Doc2X 后端使用官方 CLI，不会伪造网页/客户端专属设置。CLI 不支持的选项会在设置页明确说明。

### 笔记 AI 自动化（可选）

- 自动生成文章摘要、要点、关键词与分类；
- 维护索引表；
- 使用思源内置 AI provider 配置。

---

## 环境要求

- SiYuan 3.8.7+ 桌面端；
- Node.js 20+（仅从源码构建时需要）；
- Windows 11 为当前主要验证环境，其他桌面平台未完整验证；
- 可选：
  - Zotero 7+，开启 Local API（默认端口 `23119`）；
  - Doc2X CLI，用于整篇 PDF 解析/翻译；
  - PDF2zh 本地服务，用于整篇 PDF 翻译。

---

## 构建与安装

```powershell
npm install --ignore-scripts

# 类型检查
node node_modules\typescript\bin\tsc --noEmit

# 单元/集成测试
node scripts\build-tests.mjs
node tests\run-all.mjs

# 构建插件
node scripts\build.mjs

# 安装到思源工作空间
node scripts\install-plugin.mjs --workspace "$env:USERPROFILE\SiYuan\Dataset"
```

也可以不传 `--workspace`，脚本默认使用 `%USERPROFILE%\SiYuan\Dataset`。

### 生成可分发压缩包

思源插件压缩包要求 `plugin.json`、`index.js` 位于压缩包根目录：

```powershell
Compress-Archive -Path dist\* -DestinationPath siyuan-pdf-zotero.zip
```

不要压缩整个 `dist` 文件夹本身，否则会多一层目录嵌套。

---

## 使用

### 打开 PDF

1. 打开思源右侧栏中的 **PDF × Zotero** Dock；
2. 点击“打开本地 PDF”；
3. 或先刷新 Zotero，再从文献列表打开 PDF。

### 标注与回跳

1. 在 PDF 中选择文字；
2. 使用浮动工具栏高亮、复制链接或插入笔记；
3. 在笔记中点击标注链接可回到 PDF 原位置；
4. 在 PDF 标注上右键可编辑、复制或查看反链。

### AI 问答

1. 打开 PDF 顶部工具栏的问答按钮；
2. 输入问题；
3. 默认使用选区/当前页作为上下文；
4. 可切换“问全文”；
5. 回答可复制，或插入为 Q/A 块；
6. 顶部“会话”管理同一 PDF 的多段独立对话。

### 设置

在 Dock 设置页中可配置：

- Zotero Local API 与阅读行为；
- 选区翻译服务；
- 整篇翻译服务（Doc2X / PDF2zh）；
- Doc2X CLI 命令、鉴权、模型、术语表、字体策略、忽略类型；
- PDF2zh 地址、服务目录、源/目标语言、输出模式；
- AI 问答模型、上下文、历史、知识范围；
- Q/A 块外观；
- AI 自动化；
- 默认 CSL 引用样式（5 个常用 + 可搜索 121 种）。

---

## 数据与安全边界

- 原始 PDF：只读；不写入、不重命名、不复制；
- Zotero：仅调用 Local API；不直接打开/修改 `zotero.sqlite`；
- 思源笔记：通过公开 API 写入；不直接修改 `.sy`；
- 截图资源：通过 `/api/asset/upload` 写入 `assets/`；
- AI/翻译密钥：保存在思源自身配置或本机 CLI 配置中，不写入仓库；
- 本仓库不包含个人工作空间数据、PDF 样本、日志或发布构建产物。

请勿在 issue 中粘贴完整 API Key、OAuth Token 或包含个人路径的日志。

---

## 目录结构

```text
src/
  index.ts             插件入口、Dock/Tab、命令、回跳、预览
  storage.ts           状态、备份、Q&A 会话、翻译历史
  service.ts           本地 PDF 导入、Zotero 刷新
  notes.ts             标注链接插入笔记
  citations.ts         CSL 引文与参考文献
  citation/            CSL/citeproc 适配、样式目录
  pdf/                 PDF.js 加载、渲染、搜索、内链
  qa/                  Q&A Markdown/KaTeX 渲染与块样式
  translation/         选区翻译、Doc2X、PDF2zh
  ui/                  Dock、Reader、引文对话框、预览、HUD
styles/                121 种 CSL 样式与 locale
scripts/               构建、测试、安装脚本
tests/                 单元与集成测试
docs/                  安装/使用/配置说明
```

---

## 测试

```powershell
# 可选：重新生成不含第三方论文内容的合成 PDF fixture
node scripts\make-sample-fixture.mjs

node scripts\build-tests.mjs
node tests\run-all.mjs
```

当前基础测试：**33/33 通过**，TypeScript 0 errors。

桌面端 E2E 脚本位于 `tests/e2e/`，需要本机 SiYuan 实例与 API Token；不属于默认测试流程。

---

## 已知限制

- Windows 桌面端为主要验证环境；
- 全量渲染所有 PDF 页面，超大 PDF 未做完整懒加载；
- AI 问答历史本地保存，不跨设备同步；
- Zotero 完全离线时仅能使用已缓存附件；
- PDF2zh 依赖本地服务，机器翻译质量与网络稳定性有关；
- Doc2X 需要用户自己的账号与 CLI 登录；网页/客户端专属的多格式输出选项 CLI 不一定支持；
- 不是通用 PDF 编辑器，不修改原始 PDF；
- 引文样式提供 121 种内置 CSL，暂未提供任意 CSL 文件导入 UI。

---

## 技术栈

- SiYuan Plugin API；
- TypeScript + esbuild；
- PDF.js；
- citeproc-js + CSL；
- KaTeX；
- Zotero Local API。

---

## License

MIT。见 [LICENSE](LICENSE)。

CSL 样式来自 [citation-style-language/styles](https://github.com/citation-style-language/styles)，按 CC BY-SA 3.0 分发，详见 [styles/README.md](styles/README.md)。

## 致谢

- [SiYuan](https://github.com/siyuan-note/siyuan)
- [PDF.js](https://github.com/mozilla/pdf.js)
- [citeproc-js](https://github.com/Juris-M/citeproc-js)
- [KaTeX](https://github.com/KaTeX/KaTeX)
- [Zotero](https://www.zotero.org/)
