> 历史对比记录：项目现已统一使用 MuPDF，EmbedPDF 依赖、引擎切换选项及双引擎比较脚本已移除。以下数据保留迁移前的测试条件与结果。

# PDF 引擎实测与维护成本

比较当前项目的 EmbedPDF v3（3.0.0-next.14）与 MuPDF.js（1.28.1）Worker。默认仍为 EmbedPDF。

两个引擎共用文档缓存、并发去重、版本检查、空闲回收、主线程 WebP 缓存及 Worker 基础设施。MuPDF 新增适配层 61 行，EmbedPDF 适配层 55 行加书签兼容层 38 行，共 93 行；共用逻辑不计入双方。行数仅说明当前实现复杂度，不是质量指标。

| 文件 | 指标 | EmbedPDF | MuPDF | MuPDF 降幅 |
| --- | --- | ---: | ---: | ---: |
| Understanding Deep Learning，64.42 MiB / 541 页 | 打开 | 795.2 ms | 394.0 ms | 50.4% |
| Understanding Deep Learning，64.42 MiB / 541 页 | 首张图渲染 | 175.0 ms | 188.3 ms | -7.6% |
| Understanding Deep Learning，64.42 MiB / 541 页 | 热渲染 | 206.4 ms | 167.7 ms | 18.7% |
| Understanding Deep Learning，64.42 MiB / 541 页 | 采样进程 RSS 峰值增量 | 316.8 MiB | 303.2 MiB | 4.3% |
| High-Dimensional Probability，4.05 MiB / 299 页 | 打开 | 174.2 ms | 114.0 ms | 34.6% |
| High-Dimensional Probability，4.05 MiB / 299 页 | 首张图渲染 | 276.4 ms | 220.7 ms | 20.1% |
| High-Dimensional Probability，4.05 MiB / 299 页 | 热渲染 | 230.2 ms | 196.2 ms | 14.8% |
| High-Dimensional Probability，4.05 MiB / 299 页 | 采样进程 RSS 峰值增量 | 202.5 MiB | 118.6 MiB | 41.4% |

两本书均运行三轮独立进程，交替引擎顺序；每本均匀抽取六页，各两轮热渲染。统一输出宽度 1800、WebP 质量 92，直接调用 Worker 绕过图片缓存。

两本书的全部页面尺寸、目录顺序/标题/层级/目标页及抽样输出尺寸均一致。目录分别为 181 条和 107 条。抽查正文、公式、插图未见明显缺失；未做逐页视觉认证，也未覆盖扫描件、加密 PDF 和全部中文字体情况。

打开时间包含 Worker 和 WASM 初始化、读取文件、获取全部页尺寸和目录；不清理操作系统文件缓存。当前 EmbedPDF 的书签兼容层会在同一 runtime 临时再打开一次 PDF，额外开销计入本次测量。结果是当前完整适配方案的比较，不代表两个底层引擎的极限性能。

内存为隔离子进程每 5ms 采样 RSS 的相对初始值增量，包含 WASM、原生分配、Worker 和缓冲区，不是精确峰值。大文件的内存收益仅约 4%，不能推广为所有文件都会显著省内存。MuPDF 第一本文档的首张图渲染略慢。

安装体积（本机核心包合计，共用 Sharp 不计）：MuPDF 13.66 MiB，EmbedPDF 五包 32.29 MiB，后者尚未计 zod/detect-libc。WASM 本体则是 MuPDF 9.93 MiB、EmbedPDF 7.20 MiB。包小不等于 WASM 小或运行时内存小。原型当前同时安装两套引擎，总依赖体积会增加。

维护判断：针对当前只读预览需求，MuPDF 内置目录和同步位图接口，省掉书签兼容层、Transport/自定义 Engine 编码器接入，并使用正式版本；更适合减少适配代码。代价是必须显式释放页面、设备和位图，尤其需等 Sharp 编码完成后再释放像素内存。实现已用 finally 处理，两套引擎通过同一组 Worker 测试和真实多文档关闭/重开测试。

授权：MuPDF 为 AGPL-3.0-or-later / 商业双授权；EmbedPDF 当前使用的核心包为 Apache-2.0。这是维护和分发决策的一部分。

31 项 PDF/Worker 测试及 Vite 构建通过。Typst 未改。

试用 MuPDF：

```bash
PDF_BACKEND=mupdf node server-node.mjs
```

原始结果：`results.json`、`probability/results.json`；完整并排预览：`comparison.html`、`probability/comparison.html`。

## 追加：Real-Time Rendering 提炼总结

100.10 MiB，252 页，288 条目录。三轮隔离进程，相同 1800 像素输出及 WebP 质量 92；抽样第 1、51、101、152、202、252 页。

| 指标 | EmbedPDF | MuPDF | MuPDF 降幅 |
| --- | ---: | ---: | ---: |
| 打开 | 334.9 ms | 213.3 ms | 36.3% |
| 首张图渲染 | 181.4 ms | 184.0 ms | -1.4% |
| 热渲染 | 216.0 ms | 200.0 ms | 7.4% |
| 采样 RSS 峰值增量 | 436.9 MiB | 371.0 MiB | 15.1% |

全部页面尺寸、288 条目录的标题/层级/目标页，以及抽样图像尺寸均一致。抽查中文正文未见明显缺失；两种引擎的像素和字体抗锯齿并非完全相同。

本书 MuPDF 打开约快 36%，热渲染约快 7%，采样内存峰值增量约低 15%；首张图渲染略慢约 1%。三本书均支持 MuPDF 更适合当前服务的判断，但内存收益幅度明显依赖文档，不能承诺统一降幅。

原始结果和并排预览：`real-time-rendering/results.json`、`real-time-rendering/comparison.html`。
