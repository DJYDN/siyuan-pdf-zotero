# Texo 本地公式引擎 + OCR 结果弹窗改版 · 需求确认稿

> 状态：待确认（确认前不改任何代码）
> 关联仓库：`F:\study\VStudio\SiYuanArticleManger`（插件 `siyuan-pdf-zotero` 0.9.57，MIT）
> 上游项目：[alephpi/Texo](https://github.com/alephpi/Texo)（AGPL-3.0）、[alephpi/Texo-web](https://github.com/alephpi/Texo-web)、模型 [alephpi/FormulaNet](https://huggingface.co/alephpi/FormulaNet)

---

## 1. 目标

1. 把 Texo（20M 参数 LaTeX OCR 模型）接成**本地公式引擎**，与现有 Pix2Text / UniMERNet 并列，三者**各自独立部署、可只装其一、可同时装多个**。
2. 交付形态做到「**别人复制压缩包 → 在插件设置里选路径 → 检测通过即可用**」，全程离线、不依赖外网。
3. 识别后的结果弹窗改造为 Texo 风格：**来源图 + LaTeX 源码/渲染预览 + LaTeX 编辑 + 复制/清除/复制为 Typst/复制为 MathML/自动复制**，同时保留现有思源动作。

## 2. 现状（改造起点）

| 现状 | 位置 | 说明 |
| --- | --- | --- |
| 本地 OCR HTTP 服务 | `ocr-server/pz_ocr_server.py` | `GET /health` + `POST /ocr`；`engine` 参数在同一进程内切换 `pix2text` / `unimernet` |
| 便携 Python 运行时 | `ocr-server/runtime/` | 共 4.6GB，已装 onnxruntime 1.25 / torch 2.15 / transformers 4.57 / tokenizers / numpy / pillow / pix2text |
| 引擎目录选择先例 | `src/ui/dock.ts:826-858`、`src/ocr/service.ts` | `unimernetPath` + 「选择目录」+「检测 OCR 环境」 |
| 设置模型 | `src/types.ts:226-248` | `ocrServerPath/ocrPort/ocrEngine/unimernetPath/...` 单服务 + 单引擎 |
| 结果弹窗 | `src/ui/ocr-dialog.ts` | 左图右 textarea，无公式预览；动作：收藏/复制/追加/替换/插入 |
| 公式渲染 | `src/qa/render.ts` | 已依赖 katex + `katex.min.css`；**未装** mathlive |

## 3. 架构：三引擎独立服务 + 共享运行时（复用优先）

### 3.1 服务拓扑

每个引擎 = **一个可独立运行的自包含服务**（自己的服务脚本、模型、可选自带 runtime、端口）。

| 引擎 | 服务包目录 | 默认端口 | 能力 | 依赖 |
| --- | --- | --- | --- | --- |
| Pix2Text | `OCR-Pix2Text-Portable/` | 8891 | 公式 / 文本 / 混合 | onnxruntime + pix2text 相关依赖 |
| UniMERNet | `OCR-UniMERNet-Portable/` | 8892 | 仅公式 | torch + transformers + timm + opencv 等 |
| Texo | `OCR-Texo-Portable/` | 8893 | 仅公式 | onnxruntime + numpy + pillow + tokenizers（**不需要 torch**） |

端口均可在插件设置里改。三个服务可任意组合启停，互不依赖。

### 3.2 统一协议（每个服务都实现，向后兼容）

```text
GET  /health
POST /ocr
```

`/health` 响应（在现有字段上**只增不改**）：

```json
{"ok": true, "engine": "texo", "version": "texo-ocr-0.1", "modelReady": true,
 "capabilities": {"formula": true, "text": false, "mixed": false},
 "models": "F:/OCR/OCR-Texo-Portable/models", "error": ""}
```

`/ocr` 请求/响应保持现有结构（`imageBase64 / mode / source / languages / formulaFormat / options` → `ok / kind / markdown / items[] / elapsedMs / engine`），弹窗与历史逻辑无需为引擎差异分叉。

### 3.3 运行时解析（共享运行时 + 包内兜底）

插件设置新增全局项「**共享运行时目录（可选）**」。每个引擎启动时按顺序解析 Python：

1. `<共享运行时目录>/runtime/python.exe`
2. `<共享运行时目录>/python.exe`
3. `<引擎包目录>/runtime/python.exe`
4. `<引擎包目录>/python.exe`
5. 用户为该项单独配置的自定义启动命令（保留现有 `ocrStartCommand` 能力）

启动前做**依赖体检**（用解析出的 python 执行 `-c "import onnxruntime"` 等引擎声明的模块），失败则在引擎卡片上给明确提示，不再干等超时。

### 3.4 共享资源（多引擎部署时只存一份）

| 共享项 | 规则 |
| --- | --- |
| Python 运行时 | 见 3.3，多引擎指向同一共享目录 |
| 模型缓存 | 统一 `HF_HOME` / Pix2Text·CnOCR 缓存目录，指向共享目录下 `cache/`，避免各引擎重复下载同一模型 |
| 日志 | 共享目录下 `logs/<engine>-<date>.log` |
| 设备 / 语言 / 超时 | 保持全局设置，三个引擎共用 |
| 示例图片 | 插件内置一份，三个引擎共用 |

### 3.5 目录结构（以 Texo 包为例）

```text
OCR-Texo-Portable/
├─ runtime/                      # 精简 Python（可选，缺失时用共享运行时）
├─ service.py                    # Texo 专用 HTTP 服务（/health、/ocr、/engine/info）
├─ models/
│  ├─ onnx/
│  │  ├─ encoder_model.onnx          # ≈54 MB
│  │  ├─ decoder_model_merged.onnx   # ≈26 MB
│  │  ├─ generation_config.json
│  │  └─ (decoder_model.onnx / decoder_with_past_model.onnx 视实现需要)
│  ├─ tokenizer/                     # tokenizer.json / special_tokens_map.json / tokenizer_config.json
│  └─ README-MODELS.md               # 权重来源、SHA-256、许可证
├─ samples/                      # 示例公式图片
├─ config.json                   # host / port / device / maxNewTokens
├─ start.bat                     # 双击即可本地起服务（排障用）
├─ README.md                     # 部署与选路径说明
└─ LICENSE-Texo.md               # AGPL-3.0 声明 + 源码地址
```

## 4. Texo 引擎实现方案

### 4.1 推理链路

```text
imageBase64 → PIL 解码 → 预处理（等比缩放 + pad 到 384×384，ImageNet 归一化，对照官方 EvalMERImageProcessor）
→ onnxruntime encoder → 贪心解码循环（decoder_model_merged，带 past KV）
→ tokenizer 反解 → 文本清洗（去特殊 token、去 \\text{} 包裹、合并空白）→ LaTeX
```

- 优先**纯 onnxruntime + tokenizers 自写贪心解码**：不引入 torch/transformers，Texo 包最小。
- 若与官方输出无法对齐（形状/前缀 token/KV 命名），退路是 `optimum` + `transformers` 的 `ORTModelForVision2Seq`（包约 +120MB）。**选型以 P0 实测结果为准**。
- 复用现有 `prepare_image()` 的小图放大逻辑（小截图先放大到 1000px 长边再送模型，提升多行公式精度）。
- 单张 CPU 推理目标：≤ 1.5s（384×384、贪心 ≤1024 token，允许按 `maxNewTokens` 截断）。

### 4.2 权重获取与打包

- 本机 `huggingface.co` 直连超时，`hf-mirror.com` 可用 → 从 hf-mirror 拉 `alephpi/FormulaNet` 的 `onnx/` 目录（≈100MB）+ tokenizer 文件。
- 由我下载、实测、写 `SHA-256` 清单后打进包；包内不含训练代码与用不到的 checkpoint。
- README 标注：模型来源、版本（commit sha）、许可证 AGPL-3.0、复现命令。

### 4.3 精简 runtime（从现有 runtime 裁剪）

复制 `ocr-server/runtime` → 保留 Python 本体 + `Lib/site-packages` 下 `onnxruntime / numpy / PIL / tokenizers`（+ 其 DLL 依赖）→ 删除 `torch / torchvision / transformers / onnx / pytorch_lightning / uv / jupyter / Lib/test / tcl 等非必需`。
预计 100–120MB；裁剪后必须实测「`python.exe service.py` 能起服务 + 能完成一次识别」。

## 5. 插件侧改造

### 5.1 新增引擎注册表

新增 `src/ocr/engines.ts`（单一事实来源）：

```ts
interface OcrEngineDef {
  id: "pix2text" | "unimernet" | "texo";
  name: string;                     // Pix2Text / UniMERNet / Texo
  defaultPort: number;              // 8891 / 8892 / 8893
  settingsKey: string;              // 目录设置键
  capabilities: {formula: boolean; text: boolean; mixed: boolean};
  requiredModules: string[];        // 依赖体检
  startScript: string;              // service.py / pz_ocr_server.py
}
```

`src/ocr/service.ts` 从「单服务」改为「按引擎实例」：`resolvePaths(engine)` / `checkEnvironment(engine)` / `ensureRunning(engine)` / `start(engine)` / `stop(engine)` / `restart(engine)`。
`src/ocr/client.ts` 的 `recognizeImage()` 改为接收目标引擎（含其端口）。

### 5.2 设置 UI：引擎卡片

OCR 设置区改为卡片列表（替换现有单选下拉 + 条件块）：

每张卡包含：**启用开关 / 服务目录（+选择目录）/ 端口 / 自动启动 / 状态灯（运行中·未启动·启动超时·依赖缺失）/ 检测环境 / 启动·停止·重启**。

全局区：**共享运行时目录（可选）**、公式引擎优先级（可拖拽排序）、文本/混合引擎（默认 Pix2Text）、预览渲染（KaTeX / MathLive，默认 KaTeX）、自动复制开关 + 复制格式、超时。

### 5.3 识别路由与降级

- **公式**：按「公式引擎优先级」依次尝试已启用引擎（默认 `Texo → UniMERNet → Pix2Text`）。
- **文本 / 混合**：由「文本引擎」指定（默认 Pix2Text；UniMERNet、Texo 不具备该能力时不参与）。
- 某引擎未运行 → 尝试自动启动；启动失败或识别报错 → **自动降级到下一个已启用引擎**，弹窗/提示里标明实际使用的引擎与降级原因。
- 全部不可用 → 明确报错（缺哪个目录、哪个依赖、哪个端口）。

### 5.4 设置迁移（向后兼容）

- 读取旧字段映射到新结构：`ocrServerPath/ocrPort` → Pix2Text 卡片；`unimernetPath` → UniMERNet 卡片；`ocrEngine` → 公式优先级与默认文本引擎。
- **旧 `OCR-Service-Portable.zip`（Pix2Text + UniMERNet 同包）继续可用**：检测到该包目录时进入「兼容模式」——一个服务两个引擎，按现有方式运行；新装三个独立包时走新模型。两种模式可共存，但同一引擎只取先命中者并提示。

## 6. OCR 结果弹窗（Texo 布局）

宽度约 880px，两栏：

**左栏（约 300px）**
- 来源图预览（PDF 框选 / 剪贴板），可点击放大
- 「粘贴 / 拖拽 / 选择图片」入口 → **弹窗内换图重新识别**
- 「示例图片」按钮（用包内 `samples/` 的示例图快速验证引擎可用）

**右栏**
- 预览 tab：`LaTeX 源码` / `渲染`；「渲染」右上角小切换 **KaTeX ⇄ MathLive**（默认 KaTeX；MathLive 可交互编辑）
- LaTeX 编辑框（textarea），编辑后 200ms 防抖刷新预览；KaTeX 解析失败显示错误行号与原文，不白屏
- 工具条：`复制` / `清除` / `复制为 Typst` / `复制为 MathML` / `自动复制`（复选框 + 格式下拉：LaTeX / Typst / MathML）

**底部动作条（保留现有）**
`收藏` / `追加笔记` / `替换选区` / `插入光标` / `关闭`；所有动作照旧写 OCR 历史。

**转换实现**
- MathML：`temml`（LaTeX→MathML，体积小）或 MathLive 的 `getValue('mathml')`，二选一以实测为准。
- Typst：移植 Texo-web 的 LaTeX→Typst 转换，首版覆盖常用子集（上下标 / 分式 / 根号 / 希腊字母 / 大型运算符 / 矩阵 / cases / 文本）；遇到未覆盖语法时给出「尽力结果 + 未支持片段提示」，不静默产出错误。
- 新增依赖：`mathlive`（~1–2MB + 字体资源，随插件 `dist/` 分发，沿用 `pluginAssetUrl` 方式加载 CSS/字体）；`temml` 视方案而定。

## 7. 分发

| 产物 | 说明 |
| --- | --- |
| `OCR-Pix2Text-Portable.zip` | 新：Pix2Text 独立服务包（自带 runtime 或依赖共享运行时） |
| `OCR-UniMERNet-Portable.zip` | 新：UniMERNet 独立服务包（自带 torch runtime，体积最大） |
| `OCR-Texo-Portable.zip` | 新：Texo 独立服务包（≈220–250MB，自带精简 runtime + onnx 权重） |
| `OCR-Service-Portable.zip` | 保留（legacy，兼容老用户） |

- README 下载表加三行 + SHA-256 + 「解压到固定位置 → 插件设置选目录 → 检测环境 → 自动启动」步骤图/文字。
- 包内 `LICENSE-Texo.md`：AGPL-3.0 全文/链接、模型来源、对应源码地址；插件本体保持 MIT，权重不进插件包。
- 目录含空格/中文、跨盘符、只读目录（日志落到共享目录）均需实测。

## 8. 验收标准

1. **Texo 服务**：`/health` 就绪；示例图（单行 / 多行 / 矩阵 / 分式）识别结果与官方 demo 人工比对通过；CPU 单张 ≤1.5s。
2. **任意组合**：只装 Texo、只装 Pix2Text、三者全装，设置检测/启停/识别/降级全部符合预期。
3. **离线可用**：断网状态下三个引擎均可启动与识别。
4. **共享运行时**：不设共享目录（各用包内）与设置共享目录（只存一份 Python）两种情形都能起服务；共享 runtime 缺依赖时给出可操作提示。
5. **弹窗**：KaTeX/MathLive 切换、实时预览、复制 LaTeX/Typst/MathML、自动复制、换图重识别、六个底部动作全部可用；不破坏现有 OCR 历史/收藏。
6. **向后兼容**：旧 `OCR-Service-Portable.zip` + 旧设置项升级后无需重配即可继续识别（兼容模式）。
7. **无回归**：PDF 阅读、标注、翻译、Zotero 引文、矩阵、模板等既有功能不回归（跑现有 `pnpm test` + 手工冒烟清单）。

## 9. 首版不做（非目标）

- 模型训练 / 微调 / 自蒸馏；
- 远程或云端 OCR（全部本机）；
- 手写公式输入（MathLive 手写板）；
- 整篇 PDF 批量公式重识别；
- 引擎/模型的自动更新与在线安装。

## 10. 风险与待验证

| 风险 | 处理 |
| --- | --- |
| Texo ONNX 纯 onnxruntime 解码姿势与官方不一致 | P0 实测对齐；不通过则退 `optimum + transformers`（包 +120MB） |
| 4.6GB runtime 裁剪后 DLL 缺失 | 裁剪后跑通「起服务 + 一次识别」才发版；脚本化裁剪清单 |
| 共享 runtime 下引擎依赖版本冲突（pix2text vs torch） | 启动前依赖体检；冲突时提示改用包内自带 runtime |
| 端口占用 / 防火墙 | 卡片显示端口冲突错误 + 一键换端口；只监听 127.0.0.1 |
| AGPL 合规 | 引擎包单独分发、注明来源与源码地址；插件本体保持 MIT |
| hf-mirror 拉取不稳定 | 下载后本地留存 + SHA-256 校验，打包不再依赖网络 |

## 11. 实施顺序（确认后执行）

- **P0 技术验证（不改插件代码）**：下载 onnx 权重 → 写最小 `texo_onnx_probe.py` 用现有 runtime 跑通 → 输出对齐报告与性能数据，据此定「纯 onnxruntime / optimum」路线。
- **P1 服务层**：Texo `service.py` + 统一协议 + 精简 runtime 裁剪 + `start.bat` + 包目录成型。
- **P2 插件服务层**：引擎注册表、设置卡片、共享运行时、多服务启停/健康、路由降级、旧配置迁移与兼容模式。
- **P3 弹窗 UI**：Texo 布局、KaTeX/MathLive、LaTeX/Typst/MathML 复制、自动复制、换图重识别、动作条保留。
- **P4 分发与文档**：三个包 zip、SHA-256、README/许可证/部署说明。
- **P5 回归**：现有测试 + 冒烟清单 + 三种部署组合验收。

---

### 待你确认的点

1. 第 3.1 节的三个包名与默认端口（8891/8892/8893）是否 OK；
2. 第 5.2 节设置 UI 改成「引擎卡片」是否就是你要的形态；
3. 第 6 节弹窗布局与按钮取舍是否与截图一致（左图右预览/编辑，底部保留思源动作）；
4. 第 11 节实施顺序是否照此执行（先 P0 出实测报告，再动插件代码）。
