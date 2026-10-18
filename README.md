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

缩略图按源文件路径、大小和修改时间缓存于 `LIBRARY_DATA_DIRECTORY/thumbnails/`，重启后继续复用。透明图片保存为 PNG，其他图片和视频封面保存为 JPEG。可删除该目录清理缓存，后续访问会重新生成。

HEIC/HEIF 使用 FFmpeg 转为 JPEG，分别缓存画廊缩略图和完整尺寸预览，原始文件保持不变。建议使用带 HEVC 解码支持的 FFmpeg 8.1 或更新版本，以正确处理 iPhone 常见的分块 HEIF；暂不处理 Live Photo 配对及 HDR 增益图还原。

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
