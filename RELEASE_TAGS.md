# Release Tags — v0.9.56

本次发布使用三个独立标签，分别对应插件本体、PDF2zh 翻译便携包和 OCR 便携包。

## 标签

| Tag | 对象 | 附件 |
|---|---|---|
| `v0.9.56` | 思源插件 | `siyuan-pdf-zotero-0.9.56.zip` |
| `pdf2zh-portable-v0.9.56` | PDF2zh 翻译包 | `SiYuan-PDF2zh-Portable.zip` |
| `ocr-service-v0.9.56` | 本地 OCR 包 | `OCR-Service-Portable.zip` |

## 发布说明

### v0.9.56

- PDF 阅读、标注、引文；
- 本地 OCR：Pix2Text + UniMERNet 适配；
- OCR PDF 框选、剪贴板、预览、历史、替换选区；
- 文献矩阵：导入、编辑、筛选、排序、分组、批量编辑、行详情、AI 填充、导出；
- 默认笔记模板：Better Notes 兼容、模板导入、目标笔记本、安全刷新；
- OCR 高级选项：Pix2Text 与 UniMERNet。

### pdf2zh-portable-v0.9.56

- 内置 Python 运行时；
- PDF2zh 1.9.11；
- 插件 0.9.56；
- 自动启动脚本；
- 不修改原始 PDF。

### ocr-service-v0.9.56

- 内置 Python 运行时与 Pix2Text 模型；
- Pix2Text 1.1.7；
- UniMERNet 适配（需要用户提供 UniMERNet 模型目录）；
- OCR 高级参数透传。

## 审核清单

- [ ] 插件包可安装；
- [ ] 翻译包能启动 PDF2zh；
- [ ] OCR 包能启动并识别公式；
- [ ] README 主视觉与文字一致；
- [ ] 三个包的 SHA-256 与发布页一致；
- [ ] UniMERNet 模型实际验收（需真实模型包）。
