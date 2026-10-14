# Saved notes library

本地 Markdown、Typst、PDF 和源码浏览器，读取已保存的文件；编辑后自动更新预览。服务使用 Node.js + Hono，前端使用 React。当前版本没有 Neovim 专用命令或编辑器预览页面。

## 启动

安装 Node.js 和 npm，在项目目录执行：

```sh
npm ci
npm run build
npm run serve -- E:/notes
```

也可使用 `node server-node.mjs E:/notes`。打开 `http://127.0.0.1:49191/`；启动日志中的 JSON `ready` 事件包含实际地址。不传目录时不会自动添加启动目录，使用已保存的最近仓库；首次启动可在侧栏 Repos 中添加目录。显式传入目录时会添加该目录并作为默认仓库。

外部程序可调用 `POST /api/library/open`，传入服务所在机器上的文件绝对路径，无需查询 repoId：

```bash
curl -X POST http://127.0.0.1:49191/api/library/open \
  -H 'Content-Type: application/json' \
  -d '{"file":"E:/notes/docs/guide.md"}'
```

服务仅接受已注册 repo 内存在的普通文件，解析真实路径后匹配仓库，嵌套仓库优先选择最深的根目录；不会自动注册仓库。已连接的 lib 页面会切换到文件（优先复用同仓库页面），否则在服务所在机器上启动默认浏览器打开 lib 文件页。返回 `{"reused":true,"url":"/仓库/tree/docs/guide.md"}` 或 `{"reused":false,"url":"/仓库/tree/docs/guide.md"}`，其中 URL 会按实际路径编码。启动浏览器失败返回 500，同时保留 URL 供调用者处理。

可选参数 `line` 为正整数，`view` 为 `"preview"` 或 `"raw"`，例如 `{"file":"E:/notes/docs/guide.md","line":20,"view":"raw"}`。无效参数或目录返回 400，文件不存在或不属于已注册 repo 返回 404，跨源 Origin 返回 403，非 JSON 请求返回 415。服务仅监听 `127.0.0.1`，此接口沿用现有本机调用权限模型，没有独立 token 鉴权。

修改前端后重新构建；修改后端后重启服务。依赖变更使用 `npm install` 更新锁文件，其他安装使用 `npm ci`。

## 配置与数据

| 环境变量 | 用途 |
| --- | --- |
| `NODE_PREVIEW_PORT` | 端口，默认 `49191`，仅监听本机 |
| `LIBRARY_DATA_DIRECTORY` | 数据目录，默认项目旁的 `data/` |
| `TYPST_FONTS` | 覆盖默认字体清单的文件路径，使用分号分隔 |
| `TYPST_PROFILE=1` | 输出编译进程启动、编译和页面渲染耗时（兼容旧 TYPST_WASM_PROFILE） |
| `TYPST_MEMORY=1` | 输出 Typst 子进程 RSS、JS 堆与 external 内存（兼容旧 TYPST_WASM_MEMORY） |

Typst 编译使用原生 `@myriaddreamin/typst-ts-node-compiler`，分页 SVG 渲染仍使用 WASM renderer，无需安装 Typst CLI。缺失的 `@preview` 包由原生包管理器下载；`@local` 包需自行安装。部署时 `npm ci` 会安装目标平台的原生二进制，不能跨平台复制 node_modules。

字体随应用分发于 `fonts/`，通过 `fonts/manifest.json` 提供应用字体，不扫描模板字体目录或从 CDN 下载字体。原生编译器同时提供内置默认字体。应用字体包括 Georgia、Iosevka、思源宋体／黑体及默认排版字体，许可证随字体分发。设置 `TYPST_FONTS` 替换应用字体清单，使用分号分隔路径；旧变量 `TYPST_WASM_FONTS` 仍兼容。

Typst 编译和分页渲染运行在一个按需启动的独立 Node 子进程中。当前原生绑定在 Windows 上反复销毁 worker_threads 会发生访问冲突，因此使用进程隔离。无活动文档和待处理任务后空闲 60 秒退出；正在阅读时保留进程。每次编译、metadata 查询和导出完成后调用 `evictCache(30)`，淘汰过期 comemo 计算缓存和文件缓存，近期命中的结果继续复用。主文件内存覆盖在调用结束后释放。每个进程最多执行 256 次编译，之后在下一次编译开始前重建，限制原生绑定/renderer 的残余累计占用。

主进程缓存文档信息与有预算的 SVG，子进程保存有预算的 vector 产物。产物丢失后按原 ID 重编译，以主文件修订、页尺寸和原生 SVG 内容指纹验证一致性；导入文件或图片改变输出时返回 410。原生接口不公开依赖清单，因此不再积累历史读取文件的并集。内容指纹需要额外导出完整 SVG，但只保留摘要，页面显示仍按需生成。

原生字体不支持 WASM resolver 的自定义家族别名。为兼容现有 Source Han Serif/Sans SC 名称，应用在 `%LOCALAPPDATA%/markdown-preview/typst-font-aliases/`（未设置时使用临时目录）生成名称表适配副本，并通过文件路径按需加载；原始分发字体保持原样。

PDF 预览使用 MuPDF.js `1.28.1`，运行在独立 Worker 中，首次打开时启动，没有活动 PDF 和待处理任务后空闲 60 秒退出。页面按显示缩放及屏幕 DPR 渲染，目标 DPR 至少为 2，像素宽度按 450 分档，最高 3600；单页位图上限 800 万像素。WebP 质量为 92，主线程图片缓存上限 8 MiB，Worker 不重复缓存编码图片。多份 PDF 共用一个 MuPDF runtime，每个文件版本分别回收，目录由内置接口读取。页面、绘图设备和位图在编码完成后释放。MuPDF.js 采用 AGPL-3.0-or-later / 商业双授权。

PDF 已统一使用 MuPDF，无需引擎环境变量。

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

`npm run package` 构建并生成 `release/` 下的部署目录。复制整个目录，在目标机器安装 Node.js，然后执行：

```sh
npm ci --omit=dev
node server-node.mjs E:/notes
```

部署包包含 `fonts/` 的字体和许可证；Typst 包缓存和现有用户数据不随部署包复制。

功能回归：`node --test tests/*.test.mjs`。构建检查：`npm run build`。

Typst 内存与冷启动基准：`npm run bench:memory`。基线采集、回归比较及完整模式见 [benchmark 说明](tests/benchmark/README.md)。

使用与接口见 [web/README.md](web/README.md)；缓存约束和调优提示见 [CODE_REVIEW.md](CODE_REVIEW.md)。
