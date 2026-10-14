# Typst 原生编译迁移

日期：2026-10-13；Windows x64，Node 24.21.0。原生编译器、renderer 均固定为 0.8.0-rc3。

## 实现

- Web compiler WASM 替换为 @myriaddreamin/typst-ts-node-compiler。WASM renderer 和按需单页 SVG 保留。
- 一次 compile 返回的 NodeTypstDocument 直接用于 metadata query、内容指纹和 vector 导出；移除 runWithWorld、手动虚拟路径映射、JS 包下载/解压和历史读取文件并集。
- finally 中移除主文件 shadow，再调用 evictCache(30)。这是原生绑定对 comemo::evict(30) 和 VFS 淘汰的封装，保留近期命中的计算结果。
- 原生 takeError/takeWarnings 分开收集；数字 severity 与零基行列统一转为现有前端格式。
- 原生字体使用文件路径按需加载，取消 WASM 字体 metadata 构建及缓存。SC 别名通过缓存的 SFNT 名称表适配副本保留；原始字体文件不变。原生编译器还有自己的内置字体。
- 原生包管理器处理 @preview/@local 包，已有本机模板通过回归。
- 原生 NodeCompiler 在当前 Windows 环境下反复终止 worker_threads 会出现访问冲突（进程退出码 -1073741819）。Typst 改用 fork/IPC 子进程，保留现有 RPC、串行队列、引用计数、懒启动和空闲退出。
- evictCache 单独不能证明整个绑定/渲染链路无限期稳定。每个 Typst 子进程完成 256 次编译后，在下一次编译前退出重建；不终止运行中的编译或渲染。旧页面 ID 的缓存与恢复逻辑仍可使用。
- 原生 vector 字节跨进程有非确定性，不能直接作为恢复指纹。使用原生 plainSvg(document) 的 SHA-256，仅保留摘要。恢复时同时检查主文件修订、页尺寸与摘要，依赖变化造成输出变化则返回 410。

## 内存测量

合成负载：每轮三个英文/中文/公式短文档，每次变更 Revision 文本、编译并渲染第一页。没有浏览器或 HTTP 服务，缓存中只有固定的三个产物 ID。旧 WASM 诊断和原始测量数据可从 Git 历史查阅。

| 方案 | 编译次数 | 结果 |
| --- | ---: | --- |
| 原 WASM Worker，无轮换 | 4500 | 采样峰值 580.1MiB |
| 原生编译 + evictCache，无批次回收 | 4500 | 主进程与子进程合计采样峰值 250.7MiB |
| 原生编译 + evictCache，无批次回收 | 18000 | 合计采样峰值 434.5MiB，仍有累计趋势 |
| 最终方案：原生编译 + evictCache + 256 次编译回收 | 18000 | 合计采样峰值 190.2MiB；后 6000 次工作区间约 180–186MiB |
| 最终方案子进程退出后 | — | 主进程 63.8MiB |

这些是合成负载的一次定位测量，不能承诺真实大文档的峰值。批次回收控制累计生命周期，不是单次编译内存硬上限。WASM 旧方案在父进程每 10ms 读取整个进程 RSS；新方案使用子进程各阶段上报 RSS，与父进程 RSS 合计并采样。阶段之间短峰可能遗漏，两个方案的采样方式存在差异。不能据此将全部差异归因于 comemo、原生执行或进程隔离中的某一项。

一次性诊断脚本和原始数据已清理。当前回归测量使用 `npm run bench:memory`，包含冷启动、连续编辑、文档切换及进程回收；用法见 [benchmark 说明](../tests/benchmark/README.md)。历史数值与新基准的负载不同，不能直接作为回归基线。

## 验证与取舍

- 242 项现有及迁移测试通过；npm run build 通过。
- 验证了英文/中文/公式字体、SC 别名、本机模板、主题、错误/警告、源码锚点、页内链接、闲置重启、导入变更、产物淘汰和批次回收后的旧 ID 恢复。
- 全量测试暴露一个既有 Markdown 缩进代码块问题：通用 token renderer 覆盖了 code_block 的实际 HTML 渲染。已改为保留默认 code_block 渲染并注入源行属性，现有回归通过。
- 每 256 次编译的首次任务承担子进程/引擎重新初始化成本；本次未完成真实用户文档的延迟分位数测试。
- 内容指纹额外生成完整的原生 SVG，增加每次编译的 CPU 和临时内存，换取原生 API 未公开依赖列表时的可靠恢复校验。分页显示仍按需生成；完整 SVG 字符串不驻留服务缓存。
- 未解决上游原生绑定/renderer 残余累计资源的精确所有者，也不声称 comemo 淘汰单独修复了全部增长。
- npm ci 在部署机器安装其平台原生二进制，无需 Typst CLI；旧 TYPST_WASM_* 配置保留兼容，新配置为 TYPST_FONTS / TYPST_PROFILE / TYPST_MEMORY。
