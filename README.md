# Saved notes library

本地 Markdown、Typst、PDF 和源码浏览器，读取已保存的文件；编辑后自动更新预览。前端使用 React，网络服务由纯 Rust 后端提供。

## 启动

开发环境需要 Rust/Cargo、Node.js 和 npm。Node.js 仅用于构建前端：

```sh
npm ci
npm run build
npm run serve -- E:/notes
```

先运行 `npm run build` 构建前端，再用上述命令启动 Rust 服务。也可直接执行 `cargo run --release -- E:/notes`。打开 `http://127.0.0.1:49191/`；启动日志中的 JSON `ready` 事件包含实际地址。不传目录时会恢复已保存的仓库；首次启动可在侧栏 Repos 中添加目录。显式传入目录时会添加该目录并作为默认仓库。

外部程序可调用 `POST /api/library/open`，传入服务所在机器上的文件绝对路径，无需查询 repoId：

```bash
curl -X POST http://127.0.0.1:49191/api/library/open \
  -H 'Content-Type: application/json' \
  -d '{"file":"E:/notes/docs/guide.md"}'
```

服务仅接受已注册 repo 内存在的普通文件，解析真实路径后匹配仓库，嵌套仓库优先选择最深的根目录；不会自动注册仓库。已连接的 lib 页面会切换到文件（优先复用同仓库页面），否则在服务所在机器上启动默认浏览器打开 lib 文件页。返回 `{"reused":true,"url":"/仓库/tree/docs/guide.md"}` 或 `{"reused":false,"url":"/仓库/tree/docs/guide.md"}`，其中 URL 会按实际路径编码。启动浏览器失败返回 500，同时保留 URL 供调用者处理。

可选参数 `line` 为正整数，`view` 为 `"preview"` 或 `"raw"`，例如 `{"file":"E:/notes/docs/guide.md","line":20,"view":"raw"}`。无效参数或目录返回 400，文件不存在或不属于已注册 repo 返回 404，跨源 Origin 返回 403，非 JSON 请求返回 415。服务默认仅监听 `127.0.0.1`。绑定到 `0.0.0.0` 会让仓库浏览和 API 对局域网开放；远程使用时应设置 `PREVIEW_PUBLIC_URL`，并只在可信网络中运行。

修改前端后重新构建；修改后端后重启服务。Rust 服务构建入口为 `cargo build --release`。

## 配置与数据

| 环境变量 | 用途 |
| --- | --- |
| `NODE_PREVIEW_PORT` 或 `PREVIEW_PORT` | 端口，默认 `49191` |
| `PREVIEW_BIND_ADDRESS` | 监听 IP，默认 `127.0.0.1`；设为 `0.0.0.0` 可从局域网访问 |
| `PREVIEW_PUBLIC_URL` | 对外访问的基础 URL；远程访问时设为 `http://<本机局域网IP>:<端口>` |
| `LIBRARY_DATA_DIRECTORY` | 数据目录，默认项目旁的 `data/` |
| `RUST_LOG` | Rust 服务日志过滤器，默认 `info`；例如 `RUST_LOG=debug` |
| `TYPST_FONTS` | 覆盖应用字体目录的路径列表，使用系统路径分隔符 |

Typst 编译和分页 SVG 渲染使用官方 Typst Rust crates，在服务进程内运行。`@preview` 包可按需下载；`@local` 包需自行安装。部署时不需要安装 Node.js。

字体随应用分发于 `fonts/`，不从 CDN 下载字体。原生编译器同时提供内置默认字体和系统字体。应用字体包括 Georgia、Iosevka、思源宋体／黑体及默认排版字体，许可证随字体分发。设置 `TYPST_FONTS` 可覆盖应用字体目录；旧变量 `TYPST_WASM_FONTS` 不再读取。

渲染使用独立的有界线程 worker，不占用 Tokio 的文件 I/O 与搜索/Git 阻塞线程池：

| 任务 | Worker 数 | 排队上限 |
| --- | --- | --- |
| 文档读取、Markdown/HTML 解析、PDF 元数据 | 1 | 16 |
| Typst 编译 | 1 | 8 |
| Typst/PDF 分页 SVG | 2 | 32 |

队列满时返回 `503` 和 `Retry-After: 1`；请求断开后，尚未开始的任务会被跳过。编译任务的运行和排队源码预算合计为 32 MiB（按两份源码计）。线程内已经开始的任务不能强制终止；需要硬超时或进程内存限制时，应使用独立进程隔离。

文本/Markdown/Typst/HTML 的文档接口源码上限为 16 MiB。Typst 布局通常保留 4 份，每个路径和主题最多保留两版；租约保护最新版本，活跃布局最多允许 32 份。额外仓库编译器通常保留 3 个，活跃或正在使用的编译器不会被自动淘汰，最多保留 8 个。SVG 缓存每个编译器最多 8 MiB。空闲 5 分钟后释放未被租约保留的布局和字体引用；所有编译器空闲后清理 Typst 的全局 memoization 缓存。

PDF 预览使用 Hayro Rust crates，单份输入上限 64 MiB，缓存最多保留 3 份且输入字节总量不超过 128 MiB，页面 SVG 缓存总量最多 8 MiB。5 分钟未访问的 PDF 会被清理。分页渲染使用固定版本快照，文件更新不会让一次渲染混用不同版本。输入与缓存预算不等于进程 RSS 上限，排版、图片解码和 SVG 生成仍有临时内存开销。

HTML（`.html` / `.htm`）支持 Preview 和 Raw。预览默认允许脚本，使用隔离 iframe，支持相对路径的仓库内 JS、CSS、图片及字体；禁止网络连接、外部资源、弹窗、表单提交、下载和嵌套页面，不开放应用存储及 DOM。保存 HTML 后自动刷新。依赖联网、`eval` 或浏览器存储的页面可能无法运行；暂不保存预览内部的滚动位置，iframe 也不保证独立进程或阻止脚本占满 CPU。



### Typst 主题约定

预览应用每次编译都传入 `sys.inputs` 的 `theme=light` 或 `theme=dark`，与界面主题同步。
无主题参数的请求默认使用 `light`，切换主题会重新编译，编译缓存区分主题。
不读取模板 `typst.toml` 私有字段，不需要配置 JSON；普通文档也可以读取此输入。

模板读取方式：`theme: sys.inputs.at("theme", default: "light")`。
文档仍通过 `#show: template` 应用模板，显式 `template.with(theme: "dark")` 优先。
原生 CLI 可用 `typst compile --input theme=dark note.typ`；布局继续由模板参数设置。

仓库注册、书签和阅读位置保存在 `data/`，笔记留在原目录。升级时保留数据目录；迁移时确保注册的绝对路径仍有效。同一数据目录只运行一个服务进程。

## 部署与验证

`npm run package` 构建前端和 Rust 服务，并生成 `release/` 下的目标平台部署目录。复制整个目录后执行：

```sh
saved-notes-library E:/notes
```

部署包包含 `fonts/` 的字体和许可证；Typst 包缓存和现有用户数据不随部署包复制。

功能回归：`node --test tests/*.test.mjs`。构建检查：`npm run build`。

后端为 Rust 原生服务；`npm run bench:memory` 是迁移期间保留的旧 Node 基准工具。

使用与接口见 [web/README.md](web/README.md)；缓存约束和调优提示见 [CODE_REVIEW.md](CODE_REVIEW.md)。
