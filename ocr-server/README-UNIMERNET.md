# UniMERNet 本地引擎

此目录用于接入 UniMERNet 公式识别引擎。UniMERNet 与 Pix2Text 共用同一个本地 OCR HTTP 服务 `pz_ocr_server.py`，但模型和代码目录独立。

## 目录要求

在 OCR 设置中选择的 UniMERNet 目录应类似：

```text
UniMERNet/
├─ unimernet/              # UniMERNet Python 包
├─ configs/
│  └─ demo.yaml            # 默认配置
├─ models/
│  └─ unimernet_base/
│     ├─ unimernet_base.pt
│     └─ ... tokenizer 文件
└─ ...
```

服务运行环境需要能 import：

```text
torch
transformers
timm
opencv-python
numpy
PyYAML
```

当前 OCR 服务的 Python 运行时已包含大部分依赖；如果 UniMERNet 包还有额外依赖，需要在相同运行时中安装。

## 配置

OCR 设置：

```text
识别引擎：UniMERNet
UniMERNet 目录：选择解压目录
```

高级选项：

```text
UniMERNet 配置文件：留空则使用 <目录>/configs/demo.yaml
UniMERNet 设备：自动 / CPU / CUDA
```

OCR 超时仍使用 OCR 页面中的超时设置。

## 工作方式

```text
PDF 框选 / 剪贴板
→ 本地 OCR 服务
→ UniMERNet 公式识别
→ 返回 LaTeX
→ OCR 预览
```

UniMERNet 当前只支持公式识别；文本识别请使用 Pix2Text。

## 注意

- 修改 UniMERNet 目录、配置或设备后，需要重启 OCR 服务；
- `models/unimernet_base` 必须完整；
- 如果配置使用 CUDA，但运行时没有可用 CUDA，服务会返回明确错误；
- UniMERNet 模型较大，便携包需要单独包含模型文件。
