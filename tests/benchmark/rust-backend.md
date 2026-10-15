# Rust 后端性能基准

基准由默认忽略的 Rust 集成测试提供，避免性能场景拖慢普通测试。固定 runner 上使用 release profile：

```bash
RUST_BACKEND_PERF_ITERATIONS=15 \
RUST_BACKEND_PERF_OUTPUT=reports/benchmark-backend/rust.json \
cargo test --release --locked --test rust_backend_perf \
  report_native_backend_parse_compile_performance -- --ignored --nocapture
```

Windows PowerShell 可用 `$env:RUST_BACKEND_PERF_ITERATIONS=15` 和 `$env:RUST_BACKEND_PERF_OUTPUT=...` 设置参数。默认迭代数为 25；先用 3 次确认流程，再用完整轮次记录结果。

性能场景覆盖 Markdown AST/HTML、PDF 解析与页面 SVG、Typst 语法解析、冷/热编译、缓存命中和未缓存页面 SVG。输入夹具位于 `tests/fixtures/backend-perf.md` 与 `tests/fixtures/backend-perf.typ`；PDF 由基准代码确定性生成。报告包括输入大小、迭代次数、p50/p95/min、输出规模和进程 RSS 快照。

RSS/HWM 是整个基准进程的快照，包含测试运行时和 Typst 字体初始化；不是单阶段分配量。RSS 用于观察资源变化，不代表单独库的内存成本，也不要求分配器在释放对象后立即把内存还给操作系统。

独立资源生命周期场景可运行：

```bash
cargo test --release --locked --test rust_backend_perf \
  report_native_resource_lifecycle -- --ignored --nocapture
```

该场景覆盖连续编辑、多个活跃文档、主题切换、PDF 修订、分页渲染和最终释放，并输出每轮资源计数与 RSS。运行环境、Rust 版本和字体集合变化时，不要将耗时或内存数值直接视为回归。
