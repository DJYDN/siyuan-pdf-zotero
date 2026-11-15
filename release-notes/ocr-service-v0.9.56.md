# OCR Service Portable v0.9.56

## 内容

- 内置 Python 运行时；
- Pix2Text 1.1.7 与 MFD/MFR 1.5 ONNX 模型；
- UniMERNet 适配代码；
- 本地 OCR HTTP 服务；
- OCR 高级参数透传。

## 使用

```text
解压 → 插件 OCR 设置选择服务目录 → 检测 OCR 环境 → 框选识别
```

## UniMERNet

需要用户另外提供：

```text
UniMERNet/
├─ unimernet/
├─ configs/demo.yaml
└─ models/unimernet_base/
```

并在插件 OCR 设置中选择该目录。

## 注意

- 包体约 1.49GB；
- 更换模型/设备后需要重启 OCR 服务；
- UniMERNet 尚未完成真实模型验收。
