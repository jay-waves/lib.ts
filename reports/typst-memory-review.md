# Typst 内存与架构审查

日期：2026-10-13。当前工作区包含大量既有重构；此次只新增诊断脚本与本报告，没有修改生产代码或依赖。

## 结论

持续增长已经在脱离 HTTP、浏览器及服务缓存的生产 Typst Worker 中复现。最明确的上游线索是：WASM 编译路径没有显式淘汰 comemo 全局计算缓存，而原生 Typst watch 每次重编译后会淘汰。现有 compiler.reset() 只处理另一层 VFS 缓存，不能替代 comemo 淘汰。

这定位了一个明确的生命周期缺口，但还不能把全部增长都归于它；渲染路径、WASM 分配器保留和绑定对象生命周期也有贡献的可能。没有重新构建带淘汰接口的 WASM 做修复后验证，因此不声称根因已完全证明或问题已修复。

## 文档及源码证据

1. [Typst 0.15.0 watch.rs](https://github.com/typst/typst/blob/v0.15.0/crates/typst-cli/src/watch.rs)：重编译循环在 compile_once 后调用 comemo::evict(10)，与 world.reset 分开。
2. [comemo 0.5.1 evict 文档](https://docs.rs/comemo/0.5.1/comemo/fn.evict.html)：缓存年龄按淘汰调用次数增长，命中归零；max_age=0 清空。10/30 不是秒数、MiB 或缓存条数。
3. [typst.ts 0.8.0-rc3 WASM compiler](https://github.com/Myriad-Dreamin/typst.ts/blob/v0.8.0-rc3/packages/compiler/src/lib.rs)：reset 调用 self.verse.evict(30)。快照、编译、query、vector 路径没有直接调用 comemo::evict。
4. 该版本 Cargo.lock 锁定 tinymist-world 0.15.0。读取 [官方 crate 源码包](https://static.crates.io/crates/tinymist-world/tinymist-world-0.15.0.crate)，src/world.rs:254 的 evict 只调用 vfs.reset_access_model 与 vfs.evict。在该 crate 的 Rust 源文件中未找到 comemo::evict 调用。
5. [同版本 NodeCompiler](https://github.com/Myriad-Dreamin/typst.ts/blob/v0.8.0-rc3/packages/typst.node/src/compiler/node.rs)：evict_cache 同时调用 comemo::evict 和 driver.evict；支持 compile、query、vector。原生包名为 @myriaddreamin/typst-ts-node-compiler，源码包声明 Windows x64/ARM64 构建目标。现有 Web 编译器没有对应的已导出 JS 淘汰接口。
6. [同版本 Vite 插件](https://github.com/Myriad-Dreamin/typst.ts/blob/v0.8.0-rc3/projects/vite-plugin-typst/src/compiler/node.ts) 实际调用 compiler/watcher 的 evictCache(30)。

## 已完成的定位实验

Windows x64，Node 24.21.0；三个很短的英文、中文和公式样本，每轮修改 Revision 文本，共 1500 轮、4500 次编译。同一虚拟文件路径、固定三个产物 ID；不是数千个缓存条目。Worker 内产物预算保持生产默认值。无浏览器、HTTP、服务端 HTML/SVG 缓存。

| 对照 | 结果 |
| --- | --- |
| 生产 Worker 编译并渲染第一页 | RSS：250 轮 252.6MiB、750 轮 369.2MiB、1500 轮 580.1MiB |
| 随后 retain([]) 清空产物 | 仍为 580.1MiB |
| 同一进程退出 Worker 后 | 199.0MiB，说明释放显著，但不保证进程立即回到基线 |
| 跳过 SVG 页生成，保留编译及页面元信息读取 | 1500 轮 RSS 450.4MiB；退出 Worker 后 73.3MiB |
| 仅调用编译器，runtime 仍初始化 renderer 但不使用它 | 250 轮 RSS 179.0MiB，1500 轮 246.6MiB；heapUsed 约 9.3MiB，external 从 78.4 增至 145.6MiB |
| 编译器每 25 轮 reset + resetShadow | 1500 轮 RSS 245.7MiB，external 145.6MiB，未阻止增长 |
| 编译器对照结束后强制 JS GC、reset、再 GC | RSS 没有明显下降 |
| 生产 Worker 每 100 轮退出重建，工作量相同 | 采样峰值 278.2MiB，最终 247.6MiB，退出后 105.1MiB |

这些是单次合成诊断结果，不是用户真实文档的内存承诺，不足以证明无限增长或每一字节的所有者。RSS 10ms 采样可能漏掉短峰；compiler-only 使用主线程且不包含 tree-sitter/页面元信息/页面渲染，不能简单相减当作组件精确占用。external 包含 arrayBuffers，二者不能相加。

复现：

```bash
PROBE_ROUNDS=1500 node scripts/benchmark-typst-memory.mjs
PROBE_ROUNDS=1500 PROBE_SKIP_PAGE=1 node scripts/benchmark-typst-memory.mjs
PROBE_ROUNDS=1500 PROBE_RESTART_EVERY=100 node scripts/benchmark-typst-memory.mjs
node --expose-gc scripts/benchmark-typst-cache.mjs
PROBE_RESET_EVERY=25 node --expose-gc scripts/benchmark-typst-cache.mjs
```

## 建议的处理次序

1. 优先解决编译器全局缓存淘汰。选择同系列原生 Node 编译器，或在 WASM Rust 层暴露 comemo::evict 并重新构建。仅在应用 JS 里调用现有 reset 不够。淘汰放在一次完整编译、query、vector 导出结束并释放临时结果之后，避免每个子操作都清空。
2. 原生 Node 编译器可保留 vector 产物和现有分页渲染接口，属于局部替换。需要核对字体名称与 SC 别名、包加载、依赖追踪、诊断和源码锚点；原生文档对象也必须有明确释放策略。保留 WASM renderer 后，渲染侧的增长仍需独立处理。
3. Worker 安全轮换是有效兜底，已有对照支持，但不是根因修复。应在串行任务边界退出、等待退出再创建，不在 compile→page 的中间随意终止；复用现有 ARTIFACT_MISSING 恢复逻辑。现有 active 文档使 worker-runtime 的空闲回收永久暂停，因此持续阅读时不能靠 60 秒闲置策略控制积累。
4. 若更看重代码简化，可评估原生 CLI 直接输出分页 SVG。官方支持 SVG compile/watch，但需重新接入诊断、源码锚点、页内链接及主题参数。只把编译搬到子进程不等于降低总内存，应计入全部子进程。

## 其余代码审查发现

- **依赖元信息持续累积**：server/typst/engine.mjs 的 revisions Map 为整个引擎所有历史读取文件的并集，每次编译都复制到结果；没有按文档收敛。会增加元信息并造成无关文件参与恢复校验。不能简单每次 clear，因为编译器可能命中内部缓存而不触发 onRead，需准确依赖清单或一致的失效策略。
- **绑定层释放**：已安装 typst.ts 的 retrievePagesInfo 创建 PagesInfo/PageInfo 包装对象而未显式 free，依赖 FinalizationRegistry；runWithWorld 的 world.free 没有 finally，回调抛异常时不能保证即时释放。前者是待核查的回收延迟，后者是异常路径问题，均不能直接解释所有成功编译时的增长。
- **已有架构合理**：server-node.mjs 统一创建 Typst/PDF/Markdown 服务，没有每仓库一套引擎；Worker 懒加载、串行队列、请求合并、版本与取消规则值得保留。重写 Hono 或 React 没有针对这次 Node 增长的证据。
- **PDF**：目前 8 百万像素、至少 DPR 2、RGBA 渲染使单页原始像素最大约 30.5MiB，另有编码/引擎内存。这影响 PDF 峰值，与此次 Typst 累积问题分开。MuPDF 已显式 destroy，Sharp cache 已关闭。
- **文件响应**：file-response.mjs 整文件 readFile 后构造 Response；流式响应能减少大资源读取的临时缓冲，但应保留现有路径与类型验证。
- **前端**：Markdown 保存净化后的离屏 DOM，更新时再 clone 并 morph；大文档可能同时保留多份 DOM。raw-highlight 对未知语言使用 highlightAuto，可对大源码设置阈值或纯文本回退。两者影响浏览器，不能解决 Typst Node 内存。
- **依赖简化**：parse5 在 server/web/shared/scripts 中没有直接引用，疑似旧 Markdown 对照方案遗留；删除前仍应检查测试和打包需求。
- **文档漂移**：CODE_REVIEW.md 仍写 PDF 400 万像素、渲染并发 2 和 PDFium；当前实现为 800 万像素、默认串行 Worker 和 MuPDF。后续调优应先统一这些描述。

当前未替换引擎、没有宣称功能回归已通过。两个诊断脚本已实际运行；生产生命周期修改应另外验证文档恢复、依赖变更、主题切换、取消、源码定位与连续编辑。
