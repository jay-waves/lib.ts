# Saved notes library

本地 Markdown、Typst、PDF、HTML 和源码浏览器。通过侧栏管理多个目录，保存书签和阅读位置，文件保存后自动更新预览。

## 启动

从源码运行需要 Rust/Cargo、Node.js 和 npm：

```sh
npm ci
npm run build
npm run serve -- /path/to/notes
```

Windows 路径可用 `E:/notes`。打开 <http://127.0.0.1:49191/>；实际地址以启动日志为准。不传目录时恢复已注册仓库，首次使用可在 Repos 中添加目录。

使用说明见 [web/README.md](web/README.md)。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `PREVIEW_PORT`（兼容 `NODE_PREVIEW_PORT`） | 端口，默认 `49191` |
| `PREVIEW_BIND_ADDRESS` | 监听地址，默认 `127.0.0.1` |
| `PREVIEW_PUBLIC_URL` | 对外访问地址；局域网或反向代理访问时设置 |
| `LIBRARY_DATA_DIRECTORY` | 数据目录，默认 `data/` |
| `TYPST_FONTS` | 自定义 Typst 字体目录或文件路径列表，使用系统路径分隔符 |
| `RUST_LOG` | 日志级别，默认 `info` |

仓库注册、书签和阅读位置保存在数据目录，笔记留在原目录。升级时保留数据目录，迁移后确保仓库路径仍有效。同一数据目录只运行一个服务进程。

字体和许可证随应用分发，无需字体 CDN。Typst 包可能需要首次联网下载；本地包需自行安装。

## 局域网与反向代理

将监听地址设为 `0.0.0.0`，并设置 `PREVIEW_PUBLIC_URL`。在数据目录的 `access.json` 中加入访问使用的主机名或 IP，修改后重启：

```json
{ "allowedHosts": ["192.168.0.163", "notes.lan"] }
```

条目不含协议、端口或路径。HTTPS 反向代理需设置 HTTPS 公共地址，并保留原始 Host。应用没有用户登录认证，仓库内容只应向可信网络开放。

## 从外部程序打开文件

文件必须位于已注册仓库中：

```sh
curl -X POST http://127.0.0.1:49191/api/library/open \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:49191' \
  -d '{"file":"E:/notes/docs/guide.md","line":20,"view":"raw"}'
```

`line` 和 `view` 可省略。服务优先复用已有页面，否则在服务所在机器打开浏览器。使用其他访问地址时，相应调整请求 URL 和 Origin。

## 图片与视频画廊

目录菜单的 `Browse as gallery` 可浏览图片及 MP4、M4V、WebM、OGV 视频。视频悬停时静音循环播放，移开或离开可见区域后释放播放器；实际播放能力取决于浏览器支持的编码，暂不转码。

超过 800 万像素或 8 MiB 的可解码图片由后端生成最长边 800 px 的缩略图（保留比例，不放大）。普通图片使用原图；超出当前解码器支持范围的格式仍交给浏览器。视频封面通过 PATH 中的 `ffmpeg` 抽帧，未安装时封面会显示失败提示，浏览器支持的视频仍可播放。

缩略图与 HEIF 完整预览按源文件路径、大小和修改时间缓存于 `LIBRARY_DATA_DIRECTORY/thumbnails/YYYY-Www/`（UTC ISO 周），重启后继续复用。只读取本周、上周两个目录，新文件写入本周，保留约 7～14 天。服务启动和跨周后在后台删除更早的周目录；不逐文件统计时间或总大小。本周命中直接复用；上周命中通过重命名移入本周目录，不复制文件，也不改写文件时间，从而按最近一次服务端访问续期约 7～14 天。浏览器直接命中自身缓存时不会触发服务端续期。跨周检测每小时执行一次，仅周变化时遍历顶层目录，过期文件可能延后最多一小时清理。旧平铺缓存不读取、不迁移、不自动删除，可手动清理。透明图片保存为 PNG，其他图片和视频封面保存为 JPEG。可删除该目录清理缓存，后续访问会重新生成。

媒体接口统一位于 `/{仓库}/api/media`：

| 请求 | 用途 |
| --- | --- |
| `GET /media?path=…&v=…` | 原始媒体，支持 Range 分段读取 |
| `GET /media/thumbnail?path=…&v=…` | 画廊缩略图和视频封面，小图片直接返回原图 |
| `GET /media/preview?path=…&v=…` | HEIC/HEIF 的完整尺寸预览 |
| `GET /media/metadata?path=…` | 异步视频元数据，与画廊尺寸读取共用探测缓存 |
| `POST /media/open` | 请求服务所在机器用系统默认应用打开原始照片或视频 |
| `POST /media/dimensions` | 批量尺寸和可选拍摄时间；接口最多接收 512 个路径，画廊每批请求 64 个 |

图片文档响应中的 `preview` 字段由后端确定：`original`、`thumbnail` 或 `converted`。前端直接使用该策略，避免重复维护图片大小阈值。媒体资源的 `v` 参数与源文件修改时间一致时启用浏览器私有缓存；无版本或版本不符时重新校验。画廊与单文件预览使用相同的缩略图 URL，以复用浏览器缓存。

HEIC/HEIF 使用 FFmpeg 转为 JPEG，分别缓存画廊缩略图和完整尺寸预览，原始文件保持不变。建议使用带 HEVC 解码支持的 FFmpeg 8.1 或更新版本，以正确处理 iPhone 常见的分块 HEIF；暂不处理 Live Photo 配对及 HDR 增益图还原。

媒体处理按常用格式和正确扩展名设计；只有 `.ts` 额外检查文件头，以区别 TypeScript。详情页以浏览器实际加载的图片或视频尺寸为准，后端尺寸用于加载前占位；视频探测处理常见的 90°/270° 旋转。独立 SVG 的尺寸和显示完全交给浏览器，不做后端专门解析。PDF/Typst 的 SVG 页面直接使用各自解析/排版结果的尺寸，不经过此图片探测路径。画廊缺尺寸时接受 4:3 占位。元信息缺失不阻止预览，FFprobe 最多等待 10 秒，FFmpeg 缩略图或 HEIF 转换最多等待 30 秒，超时按读取失败处理。不自动重试、转码或修复异常文件，预览失败可用系统应用打开。动态图允许画廊大图缩略图为静态、较小原图保留动画；不增加动画重编码、特殊像素比例或额外 TS 变体兼容。磁盘缓存按周整批淘汰，不维护文件级 LRU 或容量统计。


## 构建与打包

```sh
npm run typecheck
npm run build
cargo build --release --locked
```

修改前端后重新构建，修改后端后重新编译并重启服务。

`npm run package` 在 `release/` 生成当前平台的部署目录和 `.tar.xz` 压缩包；打包环境需要支持 xz 的 `tar`（GNU tar 还需安装 `xz`）。GitHub 发布包也使用 `.tar.xz`，以减少字体下载体积。解压或复制整个目录后运行 `lib-ts`（Windows 为 `lib-ts.exe`），部署环境无需 Node.js。现有用户数据及 Typst 包缓存不随包复制。

现有回归检查：

```sh
node --test tests/*.test.mjs
cargo test --release --locked
```

独立 MPEG-TS（`.ts`）视频按文件内容识别，与 TypeScript 源码区分。画廊只显示抽帧封面，不进行悬停或自动播放。打开 TS 等不走浏览器播放的格式，或照片、视频预览失败时，可点击“Open in system application”，直接用系统默认应用打开原文件；不转封装、不生成视频副本，不支持 `.m3u8` 播放列表。系统打开与目录资源管理器共用后端启动入口，当前在运行 lib.ts 的机器上执行，需要桌面环境和对应的文件关联；前端通过 API 请求，不依赖本地绝对路径，未来可扩展其他打开目标。照片、视频工具栏默认仅显示像素尺寸，其他元信息在悬停或聚焦尺寸时显示。
