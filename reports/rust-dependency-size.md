# Rust 后端依赖体积探索

日期：2026-10-15。平台：本地 Linux x86_64。基线为 Hayro 统一至 0.7 后的版本。

## 方法与边界

- 使用当前 release 配置，未调整符号剥离、优化级别或 LTO。
- `cargo rustc --release --locked --offline --bin lib-ts -- -C link-arg=-Wl,-Map=/tmp/libts-release.map` 生成链接映射。
- 按映射中的输入 archive 汇总保留下来的 section 字节。数字是各包的链接贡献，不是移除功能后的实测收益，也不包含泛型在调用方实例化的全部体积。不能把相关包简单相加作为保证值。
- 此处衡量可执行文件体积，未测运行时 RSS。Linux 的动态系统库不包含在可执行文件大小中，Windows 需另外测量。

## 候选

| 能力 | 主要包 | 链接贡献 | 可行性与代价 |
| --- | --- | ---: | --- |
| Typst 参考文献 | hayagriva、citationberg、icu_collator | 合计 6.44 MiB | 最大候选，但当前 Typst 没有可关闭此能力的 feature；需维护上游补丁，且 bibliography/cite 和相关模板会受影响。ICU 与其他能力存在共享，不能保证全部移除。 |
| Typst WASM 插件 | wasmi、wasmparser 及 wasmi 支持包 | 合计 1.74 MiB | 当前 Typst 无对应 feature。需同时处理 plugin 加载入口和函数调用实现；仅禁止入口并不能保证解释器被移除。依赖 WASM 的包会失效。 |
| Typst 多语言断词 | hypher | 1.12 MiB | 上游支持语言 feature，但 typst-layout 使用默认全语言配置；在项目中追加 default-features=false 不能抵消上游已开启的 feature。需要补丁或上游支持。实测见下。 |
| Typst 代码高亮 | two-face、syntect、fancy-regex | 合计 1.34 MiB | two-face 的内嵌语法数据占约 0.88 MiB。外置数据可保留能力，但需维护补丁、部署资源和加载逻辑；禁用会影响 raw 代码高亮及自定义语法。 |
| Git | libgit2-sys、git2 | 合计 0.94 MiB | 改为 Git CLI 可能缩小文件，但增加外部程序依赖并需要重验 diff/status 等行为。收益优先级较低。 |
| Markdown | comrak | 0.49 MiB | 已关闭默认 feature。换解析器需要重做 AST、扩展和源码行号适配，体积收益上限较小。 |
| Typst 工具组件 | typst-kit、ureq、native-tls、openssl、chrono、fontdb | 合计 0.37 MiB | 本地二进制贡献较小，且 TLS 使用动态系统库。仅为缩小当前 Linux 可执行文件，不值得重写下载器和字体发现。 |

参考文献 archive 原始资源约 2.97 MiB，是可进一步探索的资源外置对象；它只占参考文献能力的一部分。移除 archive 不等于可以移除整个参考文献处理器。

typst-assets 在当前二进制中的链接贡献只有约 0.034 MiB。虽然 crate 源码包含约 9.6 MiB 字体，但当前配置没有启用内嵌字体，不能把这些文件当作可削减的二进制体积。

## 实验：仅保留英文断词

实验在 `/tmp/libts-hypher-experiment` 复制 manifest、锁文件和 hypher 源码，通过临时 `[patch.crates-io]` 将 hypher 默认 feature 从 `alloc, full` 改为 `alloc, english`。项目源码与字体通过符号链接复用。然后在同一个临时 manifest 中移除补丁，构建完整词典作为对照。

| 配置 | 可执行文件字节 | MiB |
| --- | ---: | ---: |
| 完整词典对照 | 43,719,408 | 41.69 |
| 仅英文词典 | 42,577,392 | 40.61 |
| 减少 | 1,142,016 | 1.09 |

减少约 2.61%。两次使用相同 release 配置。正式项目未采用词典裁剪，已重新执行 `cargo build --release --locked --offline` 恢复正式产物。

这个实验仅验证体积，不证明精简后的排版兼容性。中文本身不使用此类单词断词，英文词典保留，但其他语言的断词和分页可能变化。

## 取舍

在保留现有完整功能、使用现有上游包且不维护补丁的条件下，尚未找到第二个与 Hayro 重复版本合并相当的明显收益项。余下重复版本多由不兼容的版本约束引起，或属于构建期依赖，不能直接强行合并。

下一步若接受功能裁剪，优先为 Typst 的参考文献和 WASM 插件向上游或受控 fork 引入可选 feature，并逐项实测。若完整 Typst 能力必须保留，优先评估统一的独立渲染进程，使主服务可单独分发并在渲染进程退出后回收内存；完整安装包不会因此同幅度缩小。
