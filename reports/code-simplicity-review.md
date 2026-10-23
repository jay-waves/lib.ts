# 代码简洁性与职责审查

审查日期：2026-10-23。重点覆盖 HTTP 路由与前端 API 契约、文档描述缓存、搜索、渲染资源回收及持久化设置；没有进行浏览器或真实前后端联调。

## 已修改

- 删除 7 个带 `Json<T>` 提取器的路由中重复的 Content-Type 检查与无用 HeaderMap 参数。JSON 解析和媒体类型校验交给 Axum；无 JSON 提取器的仓库使用标记、清空历史接口仍保留检查。现在带 JSON 的路由也接受 Axum 支持的 JSON 媒体类型，不再额外限制为手写字符串前缀。
- 前端 `visitedAt`、`defaultRepoId` 与后端实际响应保持一致：前者必填，后者必填且允许 null。删除默认值和 optional 造成的旧响应兼容。`listRepositories` 直接推导返回类型，避免手写重复定义。
- 删除没有消费者的 `treeSchema`，`FileTree` 从目录列表契约派生。保留根树不含 path 的现有内存结构。
- 文档描述缓存批量合并改为先建立当前仓库的路径索引，避免每个文件重复扫描缓存；仍保留文件版本、类型和 MIME 一致性检查，防止沿用过期媒体尺寸。
- 删除目录显示设置的旧布尔存储格式兼容分支。旧布尔值按无效数据处理；当前对象格式、目录排序、缩放及滚动位置继续使用原逻辑。旧格式的显示偏好需要用户重新选择。
- 仓库与历史记录时间戳直接使用 `OffsetDateTime::now_utc()` 格式化，删除 SystemTime 纳秒中转、空字符串和 1970 年兜底。格式化失败视为时钟值不可表示的异常，而不再持久化伪造时间。
- Rust 使用 let chains、`?`、固定大小切片分组以及 filter/map 等惯用写法，移除多余借用、错误分支 unwrap 和只在测试使用的生产导入。为复杂的脚注组、树缓存与日期依赖类型命名。
- 编译器空闲回收使用显式循环汇总结果，确保所有编译器都执行回收。不能直接替换为短路的 `.all()`。

## API 与前后端职责结论

| 职责 | 当前归属 | 判断 |
| --- | --- | --- |
| 文件路径规范化、仓库和私有目录边界 | Rust | 必须保留；前端路径检查不能替代服务端检查 |
| 文件类型、MIME、图片尺寸、视频属性 | Rust | 合理；画廊和阅读器共用服务端描述，避免浏览器自行猜测类型 |
| Markdown、Typst、PDF 内容与页面渲染 | Rust | 合理；前端负责页面窗口、缩放和导航 |
| 搜索解析、过滤、分页快照、结果范围 | Rust | 合理；前端保留快照一致性检查，避免串页 |
| 目录排序、画廊布局、滚动和阅读状态 | 前端 | 属于交互和显示；不必为了减少前端代码增加服务端会话状态 |
| 桌面文件/目录打开 | Rust 服务所在机器 | API 的 server 目标语义明确，前端不应把它当作用户本机路径 |
| JSON/SSE 外部数据校验 | 前端 API 层 | 保留边界校验；TypeScript 类型不能验证网络数据 |

`/document/info` 是低成本描述，`/document` 是按视图加载的内容，媒体批量尺寸接口服务画廊。三者存在字段交集，但用途与成本不同，合并会增加画廊或打开文件的工作量，当前保留分离更合适。

## 仍存在的边界问题

1. `library_open` 对显式 repo 的查找使用 `.ok().flatten().or_else(...)`：未知 repo 或仓库存储错误可能落到 URI 对应的默认仓库。`library_session` 也把查找错误归入无效客户端。这里混合了“不存在”和“存储不可用”，需要单独确定 404/500 以及默认仓库的协议语义；本次没有改动打开目标行为。
2. 若干 async 路由直接执行 canonicalize、目录遍历或同步持久化。大部分耗时渲染已有独立 worker，但慢盘/网络盘上的这些操作仍可能占用 Tokio 执行线程。迁移时需要明确任务预算与错误传播，不能只机械包一层 spawn_blocking。本次没有重写 I/O 调度。
3. 前端仍有 JSX/MJS，tsconfig 的 checkJs 为 false。因此类型检查通过不代表这些模块全部受到严格检查；本次用现有 Node 单元测试覆盖其行为，没有进行全量 TypeScript 迁移。
4. Rust 部分响应仍使用 serde_json::Value，网络契约由 TypeScript schema 另外维护。这是未来字段漂移的来源。本次收紧已确认的字段，并将历史记录响应改为具名 Rust 结构体；没有引入代码生成或新的契约依赖。

PDF 旧式命名目标、Windows 路径规则、文件型书签默认位置都属于当前支持的数据或平台语义，不是可以直接删除的历史实现包袱。取消、租约、资源预算、持久化数据校验也都有明确作用，已保留。

## 验证

- `cargo fmt --check`、`cargo clippy --release --locked --bin lib-ts -- -D warnings`。
- Rust binary 中非顶层 HTTP 测试：90 项通过；跳过 main_tests.rs 中 14 项，未运行 tests/ 下的 Rust 集成测试。
- Node 单元测试：49 个测试文件通过，覆盖 tests/、web/、画廊与视频模块。
- `npm run typecheck`、`npm run build`。构建有依赖 use client 指令和大 chunk 提示。

需要用户联调：注册/切换仓库、书签和历史增删、目录打开与媒体打开、画廊尺寸及捕获时间排序、Markdown/Typst/PDF 切换与文件变更刷新。使用旧布尔显示设置的浏览器需确认恢复默认后能够重新保存偏好。


## 补充：依赖与实现复查

已执行以下调整：

- 删除未直接调用的 `typst-syntax` 依赖。Typst 自身仍依赖它，因此这属于直接依赖声明清理，不代表该 crate 从构建产物中消失。
- Axum 关闭默认特性，只保留 HTTP/1、JSON、原始 URI、查询参数、Tokio 和 tracing。项目没有 Form 或 MatchedPath 消费者，也没有使用 tower 的日志集成。特性定义已对照本地锁定版本和 [Axum 官方特性文档](https://docs.rs/crate/axum/0.8.9/features)。
- 删除未使用的 `tower-http/limit` 特性；它不是请求体限制的实际调用，移除不会改变现有路由限制行为。
- React、React DOM、Primer、DOMPurify、morphdom 统一归入应用 dependencies，构建器、类型工具留在 devDependencies。部署产物仍无需 Node.js。npm 锁文件同步了 dev 标记，并补齐 Tailwind 可选 WASM 包自带的 6 个嵌套依赖条目；没有修改已有包的版本。
- 历史响应由 `RecentFiles` 结构体序列化，移除临时 JSON Value 和中间 records 向量；原有 recent/visitedAt 响应格式不变，单元测试检查序列化字段与时间戳。
- Git 前端去掉 force 参数与服务端未读取的 refresh 查询参数；仍通过 no-store 请求最新状态。删除“后端跨页面去重”的不实注释，当前去重仅发生在单页面共享轮询中。

保留的依赖和写法：

- `tree-sitter-language-pack` 默认启用动态加载和下载。本地锁定版本的 get_language 会在缺少语法库时访问 GitHub release；失败后源码提取返回空定义列表。README 已补充首次联网和离线缺少导航的行为。直接关闭 download 会改变当前支持范围；后续如要求离线完整导航，应选择随包分发语法库或静态编译语言集合，并分别验证平台包和体积。
- Rust 依赖树中的 base64、ureq、dirs、SIMD 等重复版本来自上游不同版本约束。未用 patch 或强制覆盖合并，未宣称可以直接移除 Typst 内部能力。
- `image` 已关闭默认特性并明确选择格式；`comrak`、`git2` 等也已有裁剪配置，没有盲目更换库。
- `Win32_System_Registry` 虽没有直接模块导入，却是 windows-sys 的 SHELLEXECUTEINFOW 类型的特性门槛，不能按字符串扫描结果删除。
- highlight.js 和 KaTeX 的 Promise 缓存不能一概认定为冗余：高亮器被 React use() 消费，需要稳定 Promise；没有机械改写这些 loader。
- randomUUID 的 getRandomValues 分支服务于局域网非安全 HTTP 上下文，不应直接缩成 crypto.randomUUID()。

后续优先级：先明确源码定义导航的离线部署约定，再逐步将仍为动态 JSON 的稳定响应转为具名类型、补齐前端类型覆盖。相比换解析器或强行统一传递依赖，这些改进与当前问题更直接相关。

补充验证：严格 release Clippy、格式检查、TypeScript 检查、前端构建均通过；历史记录 Rust 单元测试 2 项、Git 轮询 Node 测试文件通过。前端构建仍有依赖 use client 和 chunk 大小提示。需要用户验证定义导航在首次联网/缓存命中/离线条件下的表现，以及 Windows 打包部署。
