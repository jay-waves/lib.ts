# 内存回归基准

从仓库根目录运行（需要安装依赖和仓库字体）：

```bash
npm run bench:memory
npm run bench:memory -- --save-baseline reports/benchmark-memory/baseline.json
npm run bench:memory -- --baseline reports/benchmark-memory/baseline.json
npm run bench:memory -- --full --save-baseline reports/benchmark-memory/full-baseline.json
```

默认运行 edit、switch 两种场景，每种使用三个全新父进程，各编译 1024 次。
edit 连续修改一个短文档；switch 在八个较长的中文、公式文档间切换。
每次编译后渲染第一页，并交替切换主题。使用生产默认的 256 次编译回收策略，
每轮覆盖四个完整 Worker 生命周期和三次回收。完整模式每种运行五轮、每轮 2048 次。
两种模式的基线分别保存。实际运行耗时取决于机器。

`coldCompileMs` 从首次请求开始，包含子进程创建、模块加载、字体及引擎初始化和编译；
`coldPageMs` 是首次页面渲染；`coldReadyMs` 是首次请求到页面就绪的总耗时。
它们表示全新进程启动，操作系统文件缓存可能已经预热。
`restartReadyMedianMs` 包含旧 Worker 停止、新 Worker 启动、编译和页面渲染。
预热编译耗时排除每个生命周期的前八次编译，不包含页面渲染。

RSS 以父进程与当前子进程合计值为主，保存分项、每 64 次编译的快照、各生命周期峰值，
以及清空产物和停止 Worker 后的值。子进程通过生产诊断事件上报 RSS，父进程每 10ms 采样；
这些是采样峰值，可能漏掉两次事件之间的短峰，不能代替 OS 级峰值测量。
停止后的父进程 RSS 不要求回到启动值，分配器可能保留内存。

判定规则：

- 每一轮总 RSS 采样峰值不得超过 768 MiB。
- 每一轮最后一个完整生命周期的峰值相对第一个增长不得超过 64 MiB。
- Worker 启动次数必须符合默认回收策略，编译和页面渲染必须成功。
- 提供基线时，两种场景分别比较多轮中位数：总 RSS 峰值、首次页面就绪 RSS、
  停止后的父进程 RSS。增长同时超过 15% 和 32 MiB 才失败。
- 耗时用于观察，暂不阻断。每轮超时十分钟，失败返回非零退出码。

768/64 MiB 是初始工程预算，并非产品内存承诺；应按固定 CI runner 的历史波动调整。
基线必须匹配系统、CPU、Node、lockfile、字体内容及运行配置；变更依赖后需明确重新采集。
在固定 runner 上先运行主分支采集基线，再运行待合并版本比较；失败时保留报告，
不要自动用待合并版本覆盖基线。默认命令无基线也会执行绝对预算检查。

报告默认写入 `reports/benchmark-memory/latest.json`（已忽略），可用 `--output PATH` 修改。
`--save-baseline PATH` 仅在检查通过后保存。集成流程应将 JSON 作为构建产物上传，
日常集成使用默认模式，定时或发布前使用 `--full`。此基准覆盖 Typst Worker 路径，
HTTP 服务缓存、浏览器 DOM、PDF 和 Markdown 内存需要各自的场景。
