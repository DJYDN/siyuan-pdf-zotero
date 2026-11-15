# Changelog

## v0.9.56

### OCR

- 新增 Pix2Text / UniMERNet 引擎选择；
- 新增 UniMERNet 目录、配置文件和设备设置；
- 新增 Pix2Text 高级选项：设备、超时、MFD/MFR 模型、MFD 静态尺寸、MFR 上下文、拼写检查、表格；
- PDF 框选 OCR、剪贴板 OCR、预览、历史、收藏、插入/复制/追加/替换；
- 修复普通文本与公式块替换选区；
- OCR 进度显示百分比，区分 OCR 与 PDF2zh。

### 文献矩阵

- 项目与 8 系统列 + 12 研究字段；
- Collection 导入；
- 筛选、排序、分组、保存视图；
- 批量编辑、行详情；
- AI 填充预览/应用；
- CSV 和 SiYuan 表格导出。

### 默认笔记模板

- Better Notes 风格表达式和代码块；
- 两个内置模板；
- 模板导入、目标笔记本选择；
- 标题格式、笔记创建映射；
- 安全刷新：保留用户编辑块。

### 翻译

- 翻译弹窗点击空白/×关闭并清理选区；
- OCR/PDF2zh 进度文案区分；
- Bing 返回非 JSON 时增加可读错误与思源 AI 回退。

### 发布包

- 插件包：`siyuan-pdf-zotero-0.9.56.zip`
- PDF2zh 翻译包：`SiYuan-PDF2zh-Portable.zip`
- OCR 包：`OCR-Service-Portable.zip`

### 已知限制

- UniMERNet 需要用户提供完整模型包，尚未完成真实模型验收；
- 大型多行公式仍建议人工校对；
- Ethereal Style 字段未完整实现。
