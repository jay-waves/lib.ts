# lib.comrak

独立 Markdown → HTML 编译器。Rust / Comrak 解析 Markdown，内嵌 QuickJS 在编译时执行 KaTeX、highlight.js 和 Pele。默认输出不包含渲染脚本；交互式 `viz` 可显式保留初始化模块。运行不需要启动后端或安装 Node.js。

## 构建

在仓库根目录安装现有 Node 依赖，然后执行：

```sh
npm ci
npm run package:comrak
```

产物为 `release/lib.comrak-<platform>-<arch>/lib.comrak.exe`（Windows）或 `lib.comrak`（其他平台）。Cargo 内部二进制名为 `lib-comrak`；打包脚本使用对外名称 `lib.comrak`。此包不依赖 lib.ts 的 HTTP 服务、Typst 或媒体处理模块。

单独构建和测试：

```sh
npm run build:comrak-assets
cargo build --release --locked -p lib-comrak
cargo test --release --locked -p lib-comrak
```

修改前端渲染代码、主题或 npm 依赖后，重新运行资源构建脚本。生成资源不提交 Git。构建需要 Node 和 C 编译器（QuickJS）；运行 exe 不需要这些环境。

## 使用

```sh
lib.comrak compile note.md
lib.comrak compile note.md output.html
lib.comrak compile notes/topic/note.md output.html --root .
lib.comrak compile note.md -o output.html --diagnostic-format short
lib.comrak compile note.md --site-root _site
lib.comrak compile note.md output.html --standalone
lib.comrak watch note.md
```

`watch` 接受与 `compile` 相同的选项，启动后立即编译，并监听 Markdown、引用的 D3/Mermaid 文件以及引用的本地图片；保存后自动重新编译，按 Ctrl+C 停止。编辑器连续保存会合并处理，编译失败保留上次成功的 HTML，并在文件修复后继续重试。watch 启动仅监听 127.0.0.1 的 HTTP 预览服务，并用 `Preview: http://127.0.0.1:3000/` 显示地址。编译状态使用 Typst 风格的带时间行；支持 `--no-fullscreen --color never --diagnostic-format short`。浏览器每 750 毫秒检查成功编译的版本并整页刷新；编译失败保留上次成功的页面。静态输出仍可直接打开。预览通过 HTTP 加载本地资源，资源请求要求重新验证缓存，避免图片更新后显示旧内容。渲染结果在进程内缓存，因此修改普通正文时可以复用未改变的公式、高亮和图表。

图表的编译结果按脚本内容复用；请让绘图输出仅由脚本和内置数据决定，避免依赖随机数或时间。修改脚本会使缓存失效。

仓库提供可选 HTTP 预览脚本：`node scripts/preview-comrak.mjs output.html 8765`，仅监听 `127.0.0.1`。HTML 使用 ETag 条件缓存，刷新时内容未变则返回 304；此脚本不自动刷新或执行 DOM 复用，也不会由编译器自动启动。

图表 ID 根据声明及相同声明的出现次序生成，不随普通正文的增删而改变；JS 或 Mermaid 文件内容变化会重新渲染图表。多个完全相同的声明依靠出现次序区分，插入或删除其中一个时，其后的相同声明可能获得不同 ID。

也允许省略 `compile`。默认输出为输入文件同名 `.html`，本地图片内嵌。`--help` 列出所有选项。成功退出码为 0，编译失败为 1，参数错误为 2。支持 `--option=value` 和 `--` 后的文件名。

生成的 HTML 与主应用共用块级定位：`output.html#L42` 跳到起始行不超过第 42 行的最近块顶部，空行归入前一块；首块之前及文末之后分别定位首块、末块。每块只标记一个从 1 开始的 `data-line`，标题原有的 `#标题` 锚点保留。HTML 附带小型定位脚本，字体和图片加载后会校正定位；关闭 JavaScript 时仍可使用精确标题锚点。

短诊断格式为 `path:line:column: error: message`，行列从 1 开始；数学或图表渲染错误、附件错误定位到对应 Markdown 节点。人类格式使用 `error:` 与 `--> path:line:column`。诊断写 stderr，成功时仅输出警告（如有）。编译失败不会覆盖已有 HTML。

## 输出模式

默认 standalone：内嵌基础 CSS、本地图片，以及当前页面需要的公式字体、图表资源。无公式页面不附带 KaTeX 样式和字体。远程图片保留 URL，由浏览器加载。

显式传入 `--site-root _site` 启用站点模式：

```sh
lib.comrak compile ai/chatgpt/note.md --site-root _site
lib.comrak watch ai/chatgpt/note.md
```

笔记库根目录默认当前工作目录，可通过 `--root DIR` 指定。示例输出 `_site/ai/chatgpt/note/index.html`，本地附件按笔记库目录结构复制，页面生成相对 URL。`/assets/example.webp` 表示笔记库根目录下的资源，生成 `../../../assets/example.webp`。Markdown 链接改为对应的 `目录/index.html` 链接，但不会递归编译其他笔记。

共享资源位于 `_site/_shared/lib-comrak/<内容版本>/`；内容一致时复用，缺失或损坏时修复，不删除其他文件。`--site-root` 决定输出位置，不与 OUTPUT、`--output` 或 `--standalone` 混用。站点图片默认复制引用，可显式 `--images embed`。

watch 强制使用系统缓存中的独立站点，启动本地 HTTP 预览服务；使用终端显示的 URL 访问。watch 不接受输出路径、`--site-root` 或 `--standalone`。

## 图片和路径

相对路径基于输入 Markdown 所在目录解释，支持 `../`、URL 编码、查询参数和片段。默认 root 为当前工作目录，`--root` 可覆盖；解析符号链接后检查边界。站点模式中以 `/` 开头的路径基于笔记库 root 解释。

standalone 内嵌本地图片，普通本地链接仍指向源文件。站点模式复制附件并生成页面相对链接，`.md` 链接映射为对应的 `目录/index.html`，其他笔记须另行编译。允许普通链接目标尚不存在，悬空符号链接或越过 root 的路径报错。
