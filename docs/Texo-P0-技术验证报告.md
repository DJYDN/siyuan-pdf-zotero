# Texo 本地公式引擎 · P0 技术验证报告

> 日期：2026-11-15
> 范围：只做技术可行性验证，**未改动插件代码**；产物为 `release/OCR-Texo-Portable/` 的模型与推理引擎骨架。
> 关联需求：[Texo本地公式引擎-需求确认.md](./Texo本地公式引擎-需求确认.md)

## 1. 结论（先看这里）

| 决策点 | 结论 | 证据 |
| --- | --- | --- |
| 推理路线 | **纯 onnxruntime + tokenizers**，不需要 torch / transformers / optimum | 见 §3、§4，输出与官方预处理逐像素一致、数据集 70% 完全一致 |
| 服务包模型体积 | **80.1 MB**（encoder 54.2MB + merged decoder 25.9MB + tokenizer 配置） | 见 §2 |
| 解码实现 | 单 session `decoder_model_merged.onnx`，`use_cache_branch` 切换首步/续步 | 与 split 双 session 输出 **12/12 完全一致**，少 46MB |
| 线程配置 | `intra_op_num_threads=4`（合并 session 最优） | 见 §4 表 |
| 速度 | 常见公式中位 **0.10–0.28s**；长公式 ~0.6–1.6s | 见 §4 |
| 质量 | UniMER 训练样本 30 张：完全一致 21/30（70%），CER 0.72% | 见 §5 |
| 权重来源 | hf-mirror（huggingface.co 在本机直连超时），SHA-256 与 HF LFS oid 完全一致 | 见 §2 |
| 运行内存 | 加载后 150MB，连续识别后稳定在 ~214MB RSS | 见 §4 |

**P0 通过，可以进入 P1**（Texo 独立服务 + 精简 runtime + 包结构）。

## 2. 权重获取与校验

上游模型：[`alephpi/FormulaNet`](https://huggingface.co/alephpi/FormulaNet)（20,043,360 参数，F32）。
下载通道：`https://hf-mirror.com/...`（本机 `huggingface.co` 直连超时；`api.github.com`、`cdn.jsdelivr.net` 可用但慢）。

| 文件 | 大小（字节） | SHA-256 | 与 HF LFS oid |
| --- | --- | --- | --- |
| `onnx/encoder_model.onnx` | 54,168,561 | `fbd69cf63cf833db1e2ef40013d859b560671c1253278441a01bde4516b624ae` | ✅ 一致 |
| `onnx/decoder_model_merged.onnx` | 25,946,299 | `61d4e9e60e3caa62af3f28a15a22bc13567eb4e618c87917d9597461e54c46be` | ✅ 一致 |

其余随包文件：`generation_config.json`（`max_length=1024`, `bos=0`, `eos=2`, `pad=1`）、`tokenizer.json`、
`tokenizer_config.json`、`special_tokens_map.json`、`config.json`（模型结构参考，运行时不需要）。

**未随包**（P0 实验后剔除）：`decoder_model.onnx`（26MB）、`decoder_with_past_model.onnx`（20MB）、
safetensors 全量权重（80MB）、`checkpoints/*.pt` —— 合并解码器已验证等价，故只保留合并版。

## 3. 推理链路与实现要点

```text
imageBase64 → PIL
  → crop_margin（灰度 min/max 拉伸 + 阈值<200 取墨迹包围盒裁剪）
  → resize：短边到 384（torchvision F.resize 语义：int 截断、PIL bilinear）
  → PIL thumbnail((384,384))（BICUBIC, reducing_gap=2.0）
  → 居中补黑边到 384×384
  → 灰度 → (x/255 - 0.7931)/0.1738 → NCHW float32
  → encoder_model.onnx（pixel_values → last_hidden_state [1,144,2048]）
  → decoder_model_merged.onnx 贪心解码（bos=0 / eos=2 / max 1024）
  → tokenizers.Tokenizer.decode(skip_special_tokens=True)
```

三个必须踩对的坑（均已解决，写进 `texo_engine.py`）：

1. **合并解码器的 encoder KV**：`use_cache_branch=true` 时 merged 输出的 `present.*.encoder.*` 是空张量，
   必须保留首步（`use_cache_branch=false`）得到的 encoder KV 并在每步重新塞回去；否则第 3 个 token 起输出
   彻底跑飞（复现：`666,29,18` 正确 → 不保留时 `666,29,681,681,...`）。
2. **预处理尺寸取整**：torchvision 对 PIL 图走 `int()` 截断而非四舍五入；用 `round()` 会导致补边前尺寸差 1px，
   图像整体错位（逐像素最大差 255）。修正后 **39/39 张图与 torchvision 参考实现逐像素完全相同（maxdiff=0）**。
3. **线程数**：encoder 是卷积主干，线程越多越快（1/2/4/8 线程 → 147/88/58/37 ms）；decoder 是逐 token 小算子，
   线程越多越慢（8 线程下 49ms/token）。合并单 session 取 `intra_op_num_threads=4` 折中。

安全阀（对上游的一处刻意偏差，需在包 README 说明）：模型在非公式输入（截图、表格）上会退化成一串重复 token，
上游会一直生成到 1024 token（1.5s+ 且输出垃圾）。`texo_engine.py` 增加 `REPEAT_GUARD=32`：连续 32 个相同 token
即停止，返回 `finish: "repeat"`。实测把退化图的耗时从 1535ms 降到 160ms，正常公式结果不受影响（30 张数据集样本
上 repeat 触发 0 次，完全一致数仍为 21/30）。

## 4. 性能与资源

测试机：Intel 64-bit（16 逻辑核），CPU 推理，`intra_op_num_threads=4`，冷启动。

| 场景 | n | 中位 | p90 | 最大 | 平均 token |
| --- | --- | --- | --- | --- | --- |
| UniMER 训练样本 | 30 | 0.10s | 0.31s | 0.29s | 30 |
| 上游示例图（单行/多行/表格） | 5 | 0.28s | 1.48s | 1.48s | 52–1024 |
| 本仓库真实公式图 | 9 | 0.63s | 1.60s | 1.73s | 31–1023 |

- 引擎加载：**343–357ms**（两个 ONNX session + tokenizer）。
- 单图最短 0.07s（单符号 `\equiv`），长多行公式 0.6–1.5s（如 433 token 的多行推导公式 612ms）。
- RSS：加载后 150MB，连续识别 10 张后 214MB（稳定）。
- 线程对比（12 张图、544 token）：merged threads=4 **128ms/img**（2.8ms/tok）＜ split enc8/dec1 138ms ＜ merged threads=2 161ms ＜ merged threads=8 198ms ＜ merged threads=1 241ms。

## 5. 识别质量（本机实测）

**数据集样本**（`data/dataset/simple`，30 张，UniMER-Train 抽样）：完全一致 21/30（70%），平均编辑距离 1.10，
字符错误率 0.72%。不一致样本几乎都是等价写法差异而非错读，例如：

| 预测 | 标注 | 差异 |
| --- | --- | --- |
| `... \leq \Delta \omega ...` | `... \le \Delta \omega ...` | `\leq` vs `\le`，等价 |
| `\hat { G _ { e } }` | `\hat { G } _ { e }` | 分组位置不同，渲染基本一致 |
| `{ \frac { \partial { \tilde { H } } } ... }` | `\frac { \partial \tilde { H } } ...` | 多余括号，渲染等价 |
| `= \frac { 2 } { \sin A } ...`（多出开头 `=`） | `\frac { 2 } { \sin A } ...` | 真实错读 |

**上游示例图**（`TechnoSelection/test_img`）：
- `单行公式.png`：`2^{2^{\lim_{n→\infty}(1/2)^n} 90^\circ f|_{x=1}}` ✅ 正确
- `单行公式2.png`：长行内公式 ✅ 基本正确（`\rarr` 等排版细节有差异）
- `多行公式.png` / `多行公式2.jpg`：多行 `array` ✅ 正确
- `复杂表格.png`：❌ 表格超出模型能力（未训练），输出退化并被 repeat 保护截断 —— **符合预期，Texo 定位是公式而非表格**

**本仓库真实图**：
- `ocr-server/test-formula.png` → `E = mc^2 + \int_0^1 x^2 dx` ✅（125ms）
- `large-formula-0*.png`（整屏公式截图裁切）→ 382–414 token 的 `array` 长公式 ✅（0.57–0.65s）
- `large-formula-1.png` 与 OCR 界面截图类图 → 退化，被 repeat 保护在 47–98 token 内截断（160–266ms）❌ 非公式输入，符合预期

## 6. 局限与风险（进入 P1 前已知）

| 风险 | 现状 | 处理 |
| --- | --- | --- |
| 表格识别 | 不支持 | 服务 `/health` 的 `capabilities` 只声明 `formula`；弹窗遇到表格由用户切回 Pix2Text |
| 超长/整屏公式 | >1024 token 截断 | 返回 `truncated/finish`，弹窗提示"结果可能不完整" |
| 退化重复 | 有概率 | `REPEAT_GUARD=32` 已兜底；服务返回 `finish:"repeat"` |
| CUDA | 未验证 | 精简 runtime 只装 CPU 版 onnxruntime；如需 GPU 后续加 `onnxruntime-gpu` |
| 预处理一致性 | 已与 torchvision 参考逐像素对齐 | P1 打包时把该参考实现写成自检脚本（开发期用，包内不依赖 torchvision） |
| 与官方 PyTorch 推理的端到端比对 | 未做（需 torch + 自定义模型代码 + 80MB safetensors） | 暂不做：预处理像素级一致 + 数据集 70% 完全一致已足够；如后续出现争议再补 |

## 7. P0 产物清单

```text
release/OCR-Texo-Portable/
├─ texo_engine.py                 # 推理引擎（onnxruntime + numpy + PIL + tokenizers）
└─ models/
   ├─ config.json                 # 模型结构参考
   └─ onnx/
      ├─ encoder_model.onnx       # 54,168,561 B  sha256 fbd69cf6…
      ├─ decoder_model_merged.onnx# 25,946,299 B  sha256 61d4e9e6…
      ├─ generation_config.json
      ├─ tokenizer.json
      ├─ tokenizer_config.json
      └─ special_tokens_map.json
临时实验文件（不随包）：.tmp/texo-p0/
  ├─ texo_onnx_probe.py   # 逐像素/解码对齐用探针
  ├─ bench_final.py       # split vs merged、线程数、预处理校验
  ├─ bench_packaged.py    # 打包引擎基准
  ├─ probe-eval30.json / p0-final-results.json
  ├─ eval/                # 30 张训练样本 + 上游 5 张示例图 + train.txt
  └─ src/                 # 上游关键源码（image_processor / task / test_onnx …）
```

## 8. 下一步（P1）

1. `service.py`：`GET /health`（`engine=texo`、`capabilities={formula:true,text:false,mixed:false}`、`finish/repeat` 说明）+ `POST /ocr`（沿用现有请求/响应结构），模型单例懒加载、串行推理、错误直出。
2. 精简 runtime：从 `ocr-server/runtime` 复制后裁剪到 Python + onnxruntime/numpy/PIL/tokenizers（目标 100–120MB）。
3. 包结构补齐：`config.json`、`start.bat`、`README.md`、`LICENSE-Texo.md`、`samples/`。
4. 包内自检脚本：`python service.py --selftest`（用 `samples/` 跑一张，验证 runtime/模型齐全）。
