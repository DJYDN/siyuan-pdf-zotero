# Release — v0.9.58

本次发布采用 **一个 Tag + 一个 Release + 六个附件**，汇总 v0.9.56 以来的全部改动。

## Tag

```text
v0.9.58
```

## Release

```text
SiYuan PDF × Zotero v0.9.58
```

## 附件

| 包 | 文件 | 大小 |
|---|---|---|
| 思源插件 | `siyuan-pdf-zotero-0.9.58.zip` | 5.6MB |
| Texo 公式引擎 | `OCR-Texo-Portable.zip` | 121.6MB |
| Pix2Text OCR 引擎 | `OCR-Pix2Text-Portable.zip` | 857.6MB |
| UniMERNet 公式引擎 | `OCR-UniMERNet-Portable.zip` | 1.53GB |
| 旧版共用 OCR 服务 | `OCR-Service-Portable.zip` | 1.49GB |
| PDF2zh 整篇翻译 | `SiYuan-PDF2zh-Portable.zip` | 432.6MB |

## 发布说明

### 设置

- 8 个零散页面收敛为 5 个：连接与阅读 / 翻译 / OCR / AI 与自动化 / 高级；
- 全局搜索、即时生效 + 重启类「立即应用」；
- 翻译服务内嵌管理；OCR 历史入口移到 Dock；旧兼容键折叠。

### 公式

- 超长公式自动排版（安全换行 + 缩进 + 压缩 `\,`），渲染不变；
- 公式块右键「格式化公式」；
- OCR 弹窗源码/渲染同屏、自动排版开关、10 种复制格式。

### OCR

- Pix2Text / UniMERNet / Texo 三引擎独立服务；
- 新增 Texo、UniMERNet、Pix2Text 独立便携包；
- 公式优先级 + 文本引擎路由、失败自动降级；
- 兼容旧 `OCR-Service-Portable`。

### 翻译

- 目标语言统一为「默认 + 覆盖」；
- 整篇翻译 ESC 退出等待；
- 划词翻译 12 种服务（免费 Bing / MyMemory 起步）。

### 修复

- ESC 关闭 OCR 弹窗同步收起 MathLive 键盘；
- ESC 退出截图/框选、取消整篇翻译；
- OCR 弹窗尺寸不跳动、遮罩显隐修复、换图重识别路由修复、文本结果独立处理。

## 校验

```text
1A92B25E8D91B47B4860554360DCEFC926BB87F798E90CF9E07CBA81733A002B  siyuan-pdf-zotero-0.9.58.zip
F7B2FDE60DB1E51F8CD8C233D8D2BACCC9E0CD16E014F6396ED4B88E7BF5E56B  OCR-Texo-Portable.zip
AD9FBB5E0CD7C078883161C5D4E3E3E2146D79EF6A6572328009D893BAFFFFF1  OCR-Pix2Text-Portable.zip
F220A189A2C11FD97617F1D9EE1B968B9AEB65D939A04FCB01C693A2FE2A003A  OCR-UniMERNet-Portable.zip
022DEDE663633C7556B19C04D1EE02873A83352B26AEB96A743C8A9C848BCFE7  OCR-Service-Portable.zip
66AB82F8885796153EEC56CF81D536E43ADA5F1E27D3450D90838CBBC4C8D27E  SiYuan-PDF2zh-Portable.zip
```

## 审核清单

- [x] README 只链接统一 Release；
- [x] 六件附件全部挂在同一个 Release 下；
- [x] 插件 zip 根目录直接是 `plugin.json` / `index.js`，无嵌套目录；
- [x] SHA-256 与包一致；
- [x] 旧版本 Release 保持历史，不再新增分开发布。
