# Rust / JavaScript 后端性能对比

原生资源生命周期场景（128 次编辑、8 个活跃文档、主题切换、PDF 修订、逐页渲染与最终释放）可单独运行：

```bash
cargo test --release --locked --test rust_backend_perf report_native_resource_lifecycle -- --ignored --nocapture
```

该场景逐轮断言文档、源码与页面缓存预算，输出每 16 轮的 RSS 与持有资源计数，最后验证应用缓存全部清空。RSS 只作观察，不要求分配器立即归还内存。

Rust 基准是一个默认忽略的集成测试，避免性能场景拖慢普通测试。固定 runner 上应使用 release profile：

```bash
RUST_BACKEND_PERF_ITERATIONS=15 \
RUST_BACKEND_PERF_OUTPUT=reports/benchmark-backend/rust.json \
cargo test --release --test rust_backend_perf \
  report_native_backend_parse_compile_performance -- --ignored --nocapture
```

Windows 可在 PowerShell 中用 `$env:RUST_BACKEND_PERF_ITERATIONS=15` 和 `$env:RUST_BACKEND_PERF_OUTPUT=...` 设置环境变量。默认迭代数为 25；先用 3 次做 smoke test，不要拿 smoke test 的耗时作结论。

JS 对照基准运行：

```bash
BENCHMARK_REVISION="$(git rev-parse --short HEAD)" \
JS_BACKEND_PERF_ITERATIONS=15 \
JS_BACKEND_PERF_OUTPUT=reports/benchmark-backend/js.json \
node tests/benchmark/js-backend.mjs
```

两份采样报告保存在 `reports/benchmark-backend/{rust,js}.json`。当前 JS 报告来自 Node v22，Linux x64；JS `markdown_parse` 只测 MarkdownIt 核心 tokenization，`typst_parse` 则包含 tree-sitter 语法分析和标题/块提取，因此这两项与 Rust 的纯解析阶段不等价。端到端 Markdown 渲染和 Typst 冷/热编译更接近实际服务路径。PDF 的 JS 路径输出 WebP 位图，Rust 输出 SVG 矢量图，耗时不可直接比较。RSS 是整进程数据，且 Node 与 Rust 的运行时基线不同；应看部署进程总内存，不将差值归因于单个库。

测试使用共享夹具 `tests/fixtures/backend-perf.md`、`tests/fixtures/backend-perf.typ`，以及基准文件中生成的确定性 PDF：12 页，每页含 80 个矢量矩形。PDF 字节数和页数会写入 JSON。JS 侧应直接读取相同的 Markdown、Typst 夹具，并按相同对象数、页面数和图元数生成 PDF；对比前校验 `fixture_bytes`。

输出 JSON schema version 1，`results` 中每项都含输入字节、迭代数、p50/p95/min 毫秒数和输出规模。`output_unit` 标明输出是 AST 节点、源字节、页数还是 SVG/HTML 字节。阶段名称含义如下：

- `pdf_parse`：Hayro 解析字节并建立 PDF 文档对象。
- `pdf_render_page_svg`：已解析文档的第一页 SVG 渲染，不含 PDF 解析。
- `pdf_document_parse_and_cache`：生产 PDF 服务从磁盘加载并提取页数/目录。
- `pdf_document_parse_and_render_page_svg`：生产服务冷缓存的加载、解析和第一页 SVG。
- `markdown_parse`：Comrak 解析 AST；`markdown_parse_and_render_html` 是生产 Markdown 路径，含 AST 改写、HTML 序列化和后处理。
- `typst_parse`：Typst 语法树解析；`typst_compile_cold` 包含进程内首次字体加载，`typst_compile_warm` 通过修改不影响布局的注释测量后续完整编译。
- `typst_compile_cache_hit`：源码、主题和实际读取的依赖均未变化时的应用层缓存命中。与完整热编译分别报告，不将两者的耗时混用。
- `typst_render_page_svg_uncached`：已编译文档的首次页面 SVG 导出，避免命中 Rust 服务的 SVG 缓存。

报告的 RSS/HWM 是整个基准测试进程的快照，包含测试运行时和 Typst 字体初始化；不是单阶段分配量。Rust 的 `rss_after_kib` 在显式运行 Typst 空闲清理后采样，`peak_rss_after_kib` 记录清理前后的进程峰值。Linux 会填入 `/proc/self/status` 数据，其他平台为 `null`。Node 与 Rust 的清理时点不同，RSS 只能作为各自全新进程工作后的量级参考，不应当作单阶段分配量或峰值增量。

JS 侧建议输出相同顶层字段和阶段名；如果已有自己的报告格式，至少保留相同的输入、阶段边界、迭代次数、p50/p95、输出规模、Node/Rust 版本、OS/架构、字体集合和仓库 revision。固定机器、release 构建、相同夹具与冷/热定义后再比较。Typst 冷编译会把运行时字体扫描纳入测量，热编译不含它；不要把冷值与热值混在一起。
