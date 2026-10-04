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

修改前端后重新构建；修改后端后重启服务。依赖变更使用 `npm install` 更新锁文件，其他安装使用 `npm ci`。

## 配置与数据

| 环境变量 | 用途 |
| --- | --- |
| `NODE_PREVIEW_PORT` | 端口，默认 `49191`，仅监听本机 |
| `LIBRARY_DATA_DIRECTORY` | 数据目录，默认项目旁的 `data/` |
| `WASM_PREWARM=0` | 关闭 Typst 和 PDFium 引擎预热 |
| `TYPST_WASM_FONTS` | 字体文件路径，使用分号分隔 |
| `TYPST_WASM_PROFILE=1` | 输出启动、编译和 SVG 渲染耗时 |
| `TYPST_WASM_MEMORY=1` | 输出 WASM 内存信息 |

Typst 使用 WASM，无需安装原生 Typst CLI。缺失的 `@preview` 包首次使用时需要联网下载；`@local` 包需自行安装。WASM 字体与原生 Typst 内置字体独立。

仓库注册、书签和阅读位置保存在 `data/`，笔记留在原目录。升级时保留数据目录；迁移时确保注册的绝对路径仍有效。同一数据目录只运行一个服务进程。

## 部署与验证

`npm run package` 构建并生成 `release/` 下的部署目录。复制整个目录，在目标机器安装 Node.js，然后执行：

```sh
npm ci --omit=dev
node server-node.mjs E:/notes
```

字体、Typst 包缓存和现有用户数据不随部署包复制。

功能回归：`node --test tests/*.test.mjs tests/*.test.cjs`。构建检查：`npm run build`。

使用与接口见 [library/README.md](library/README.md)；缓存约束和调优提示见 [CODE_REVIEW.md](CODE_REVIEW.md)。
