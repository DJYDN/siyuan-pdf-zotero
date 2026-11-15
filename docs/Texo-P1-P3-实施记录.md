# Texo 本地公式引擎 · P1–P3 实施记录

> 日期：2026-11-15
> 关联：[需求确认稿](./Texo本地公式引擎-需求确认.md) · [P0 技术验证报告](./Texo-P0-技术验证报告.md)
> 版本：插件 0.9.58

## 1. 已完成内容

### P1：Texo 独立服务包（`release/OCR-Texo-Portable/`）

| 文件/目录 | 说明 |
| --- | --- |
| `service.py` | 本地 HTTP 服务：`GET /health`（engine/capabilities/modelReady/missing/pid）、`GET /selftest`、`POST /ocr`（与其它引擎同构响应，附 `tokens/finish/truncated`） |
| `texo_engine.py` | ONNX 推理引擎：预处理（crop_margin + torchvision 语义 resize + thumbnail + 补边 + 归一化）、合并解码器贪心解码、encoder KV 保留、`REPEAT_GUARD=32` |
| `models/onnx/` | `encoder_model.onnx`（54.2MB）、`decoder_model_merged.onnx`（25.9MB）、tokenizer 与 generation config（80.1MB） |
| `models/README-MODELS.md` | 权重来源、SHA-256（与 HF LFS oid 一致）、模型规格 |
| `runtime/` | 从 `ocr-server/runtime` 裁剪的精简 Python 3.13（onnxruntime + numpy + Pillow + tokenizers），128.5MB |
| `config.json` | host/port(8893)/threads(4)/maxNewTokens(1024)/modelDir |
| `start.bat`、`README.md`、`LICENSE-Texo.md`、`samples/`（3 张示例图） | 双击启动、部署说明、AGPL 声明、示例图片 |

包体积：解压 205MB / 压缩 121.6MB（`release/OCR-Texo-Portable.zip`，SHA-256 `f7b2fde60db1e51f8cd8c233d8d2baccc9e0cd16e014f6396ed4b88e7bf5e56b`）。

验证：
- `runtime\python.exe service.py --selftest` 通过（3 张示例图，单张 96–297ms）；
- 复制到含中文与空格的路径（`.tmp/测试 目录/...`）后仍可运行；
- HTTP 实测：`/health` 返回 `modelReady=true`；`POST /ocr` 返回公式，wall≈155ms（含 HTTP）；
- 冷启动：Python 进程 + 模型加载 ≈1s（首次运行因编译 pycache 可能 3–5s）。

### P2：插件多引擎架构

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `OcrEngineId`/`OcrEngineConfig`/`OcrEngineMap`；Settings 新增 `ocrEngines`、`ocrSharedRuntimeDir`、`ocrFormulaOrder`、`ocrTextEngine`、`ocrPreviewRenderer`、`ocrAutoCopy`、`ocrAutoCopyFormat`；旧字段保留 |
| `src/ocr/engines.ts`（新） | 引擎注册表（能力/默认端口/脚本候选/目录提示）、旧配置迁移、引擎分组（同目录=同服务）、公式优先级、按模式路由 |
| `src/storage.ts` | 默认值 + 迁移：无 `ocrEngines` 时从旧 `ocrServerPath/ocrPort/ocrEngine/unimernetPath` 生成（Pix2Text 与 UniMERNet 指向同一旧服务目录） |
| `src/ocr/client.ts` | 按引擎/服务分组取 URL；`getOcrHealth(engine)`；`recognizeWithEngine`；解析 `tokens/finish/truncated/notice`；单引擎 `recognizeImage` 兼容保留 |
| `src/ocr/service.ts` | 多服务：运行时解析（共享 runtime → 包内 runtime → 自带）、环境检测、按引擎启停/重启（PID + taskkill）、`recognizeWithFallback` 自动降级与错误汇总 |
| `src/ui/dock.ts` | OCR 设置页重写：引擎卡片（启用/目录/端口/自动启动/状态灯/检测/启停/重启）、共享运行时、公式优先级、文本引擎、预览渲染、自动复制、识别行为；保存时同步旧字段镜像 |
| `src/ui/reader.ts`、`src/index.ts` | 改用 `recognizeWithFallback`（PDF 框选 / 剪贴板），把实际引擎与降级链传给弹窗 |
| `ocr-server/pz_ocr_server.py` | `/health` 增加 `engine/engines/capabilities/pid`，插件可管理旧版共用服务 |

### P3：Texo 风格结果弹窗（`src/ui/ocr-dialog.ts` 重写）

- 左栏：来源图 + 点击/拖拽/粘贴换图重新识别 + 引擎 `samples/` 示例图按钮；
- 右栏：`LaTeX 源码` / `渲染` 两个 tab；渲染切换 KaTeX（默认）/ MathLive（可交互编辑，编辑同步回 LaTeX）；
- 编辑框实时预览（180ms 防抖），KaTeX 出错显示错误文本不白屏；
- 工具条：复制 / 清除 / 复制为 Typst（`src/ocr/convert.ts`）/ 复制为 MathML（MathLive `convertLatexToMathMl`）/ 自动复制 + 格式选择；
- 底部：行内/独立格式选择、收藏、复制 Markdown、追加笔记、替换选区、插入光标、关闭；动作写 OCR 历史；
- 头部：引擎徽标、耗时、token 数、截断/降级提示；
- MathLive 资源随插件分发（`dist/mathlive/`，含字体），按需懒加载；KaTeX 复用已有 `katex.min.css`。

### 测试与构建

- `npx tsc --noEmit`：通过；
- `npm test`：93 个用例全部通过，新增 `tests/unit/ocr-engines.test.mjs`（14 例，覆盖迁移/端口清洗/优先级/路由/服务分组）与 `tests/unit/ocr-convert.test.mjs`（34 例，LaTeX→Typst）；
- `npm run build`：通过；`dist/index.js` 1.69MB，`dist/mathlive/` 1.1MB；
- 插件已安装到本机思源（0.9.58，`/plugins/siyuan-pdf-zotero/mathlive/*`、`katex.min.css`、`index.js` 均返回 200）。

## 2. 兼容性

- 旧 `OCR-Service-Portable` 用户升级后：`ocrServerPath/ocrPort` → Pix2Text 卡片，`unimernetPath` 存在时 UniMERNet 卡片指向同一目录且同端口 → 仍是一个进程两个引擎，请求带 `engine` 参数，行为不变；
- 旧版 `pz_ocr_server.py`（无 capabilities/pid）仍可工作：能力检查在服务未上报时默认放行，「停止」按钮因无 PID 会提示手动关闭；
- 新版 `pz_ocr_server.py` 增加字段属于向后兼容扩展。

## 3. 尚未完成 / 待验收

| 项 | 状态 |
| --- | --- |
| **Pix2Text 独立引擎包**（`OCR-Pix2Text-Portable.zip`） | ✅ 已完成：精简 runtime（1.63GB）+ 预置模型缓存（256MB）+ 独立 `service.py`；`--selftest`、`/health`、`/ocr`（公式/文本）实测通过 |
| **UniMERNet 独立引擎包**（`OCR-UniMERNet-Portable.zip`） | ✅ 已完成（绕开 upstream 包）：官方模型包的 Lightning checkpoint 与 upstream `unimernet` 代码架构不匹配（`d_model=1024/8` vs 代码默认 `512/6`），但其权重键 `model.model.*` 与 `transformers.VisionEncoderDecoderModel`（config.json 声明 `donut-swin + mbart`）完全对应。新增脚本把 checkpoint 转成标准 HF 目录（safetensors 1.19GB），服务改用 **纯 transformers** 推理（不需要 lightning/iopath/timm），`--selftest` 两条示例公式均正确 |
| 弹窗与设置页的真实 UI 验收 | 已补 **DOM 级自动化冒烟**（jsdom，7 个用例）：设置页三张引擎卡片/路由/共享运行时/保存收集；OCR 弹窗的 Texo 布局、KaTeX 渲染、源码同步、复制 LaTeX/Typst、截断/降级提示、关闭清理，全部通过（`npm test` 100 个用例全绿）。**视觉与真机交互仍建议人工过一遍**（本沙箱无法跑浏览器自动化） |
| 三种部署组合（只装 Texo / 只装 Pix2Text / 两者都装）联调 | 单包启动与协议已分别验证；组合切换需人工或允许浏览器的终端里验证 |
| Texo / Pix2Text 引擎包的 GPU 支持 | 未做（CPU onnxruntime） |

### 3.1 Pix2Text 独立包构建要点

- 包结构：`runtime/`（精简 Python 3.13，1.63GB） + `userprofile/AppData/Roaming/{pix2text,cnocr,cnstd}` 预置模型（256MB） + `service.py` + `config.json`（端口 8891）+ `start.bat` + `README.md` + `samples/`。
- `scripts/build-engine-runtime.py`：按「实际 import 追踪」裁剪 runtime——用 import hook 记录引擎真实加载的模块，映射到 site-packages 分发名，只复制所需分发（Pix2Text 追踪出 72 个分发 / 193 个顶层模块）。踩坑：RECORD 里的单文件模块（`six.py`、`typing_extensions.py`、`threadpoolctl.py`）需按去掉 `.py` 后匹配；`.pth` 钩子（`pywin32.pth`）会引用未复制模块，须全部丢弃。
- 独立服务与旧共用服务协议一致，只是 `/health` 上报 `engine: "pix2text"` 与三项 capabilities。
- 实测：`--selftest` 通过（公式识别正确）；HTTP `/health` 返回 `modelReady=true`、`capabilities={formula,text,mixed}`；`POST /ocr` 公式 0.9s、文本模式正常。
- 启动时间：首次冷启动（含 pycache 生成/Defender 扫描）可能 60–90s，之后 25–40s（模型加载为主）；插件启动超时已放宽到 120s，且服务启动后常驻，识别时不再重复加载。
- 发布包：`release/OCR-Pix2Text-Portable.zip`（1.82GB 解压 / 857.6MB 压缩，包含预编译 `__pycache__` 以缩短首次启动），SHA-256 `ad9fbb5e0cd7c078883161c5d4e3e3e2146d79ef6a6572328009d893bafffff1`。

### 3.2 UniMERNet：从“阻塞”到可用（绕开 upstream 包）

官方模型包的 Lightning checkpoint 与 upstream unimernet 代码构建出的模型架构不匹配：

`	ext
size mismatch for model.model.decoder.model.decoder.layers.7.encoder_attn.q_proj.weight:
    copying a param with shape torch.Size([1024, 1024]) from checkpoint,
    the shape in current model is torch.Size([512, 1024]).
`

但 models/unimernet_base/config.json 是一个合法的 HF VisionEncoderDecoderModel 配置（donut-swin 编码器 + mbart 解码器），且 checkpoint 权重键带固定前缀 model.model.*。新增脚本 scripts/prepare-unimernet-model.py：

1. 	orch.load(..., mmap=True) 读 checkpoint（4.9GB，含 optimizer，低内存）；
2. 去掉 model.model. 前缀 → 622 个张量与 HF 模型 **missing=0**（unexpected 34 个是 counting_decoder 训练残留，可忽略）；
3. 保存标准 transformers 目录（model.safetensors 1.19GB + tokenizer/config）；
4. 服务 service.py 用 VisionEncoderDecoderModel.from_pretrained + PreTrainedTokenizerFast 纯 transformers 推理，**不再需要 upstream unimernet / lightning / iopath / timm**。

实测（--selftest，CPU）：	est-formula.png → E = m c^{2} + \int_{0}^{1} \! x^{2} d x ✅；上游单行公式示例 → 基本正确（\dim vs \lim 一处误读）。首次推理含模型加载约 85s，热推理 2.5s 左右；插件启动超时已设 240s。

发布包：
elease/OCR-UniMERNet-Portable.zip，解压约 2.4GB（模型 1.19GB + 精简 runtime），SHA-256 见 README 下载表。

## 4. 下一步

1. 人工 UI 验收（上面第 3 节），根据反馈微调节奏与文案；
2. 发布 v0.9.58 Release（附件：插件包、Texo / Pix2Text / UniMERNet 三个引擎包、PDF2zh 包、旧 OCR 包），README 下载表与 SHA-256 已对齐；
3. UniMERNet 可选优化：首次推理冷启动约 1–2 分钟（模型加载 + CPU 首次 generate），可考虑 fp16/量化或“服务启动时后台预热”进一步缩短等待。

## 5. 三包最终产物（v0.9.58）

| 包 | 解压体积 | 压缩体积 | SHA-256 |
| --- | --- | --- | --- |
| `OCR-Texo-Portable.zip` | 205MB | 121.6MB | `f7b2fde60db1e51f8cd8c233d8d2baccc9e0cd16e014f6396ed4b88e7bf5e56b` |
| `OCR-Pix2Text-Portable.zip` | 1.82GB | 857.6MB | `ad9fbb5e0cd7c078883161c5d4e3e3e2146d79ef6a6572328009d893bafffff1` |
| `OCR-UniMERNet-Portable.zip` | 2.35GB | 1.53GB | `f220a189a2c11fd97617f1d9ee1b968b9aeb65d939a04fcb01c693a2fe2a003a` |
| `siyuan-pdf-zotero-0.9.58.zip` | — | 5.9MB | `17175687e43bdd41086fff88b38970be073e21bdfbbf3bc6e139f8e64fbb7b6a` |

> 三个引擎包均为「解压 → 插件设置里选目录 → 检测 → 自动启动」；指向同一目录的引擎共用一个服务进程（兼容旧版共用包）。
