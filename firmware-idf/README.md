# InkOS PaperS3 ESP-IDF 客户端

这是网页版 PaperS3 播放器对应的真实硬件客户端，目标板仅为
M5Stack PaperS3（ESP32-S3、960×540、16 级灰度、GT911 触摸与板载 IMU）。
它是原生 ESP-IDF/C++ 工程，不依赖 Arduino Core，也不修改旧的
`firmware/` PlatformIO 客户端。

客户端版本为 `paperS3 1.0.0`。加载包时会严格检查
`compatibility.minimumClientVersions.paperS3`、格式主版本、必需能力和
PaperS3 屏幕 profile；高于本客户端版本的最低版本声明不会被忽略。

## 显示与内容模型

设备不在本地排版结构化 JSON。服务端负责语义内容到页面的布局，设备只执行
已经验证的 PNG 和配套 `inkos.frame-sidecar/v1`：

- 竖屏逻辑尺寸为 540×960，`displayRotation=90`；默认是手动竖屏。
- 横屏逻辑尺寸为 960×540，`displayRotation=0`。
- 帧必须是带 16 色灰阶调色板的 4-bit indexed PNG（`gray4`）。普通图片、地图、未知
  内容类型和依赖中间灰阶的页面使用 `epd_quality` 刷新；带
  `frame.source-image-jpeg-v1` 的原始 JPEG 对比页固定执行三段：
  `epd_text` 整屏清白、`epd_quality` 完整 16 灰阶主体（纯黑主体改用
  `epd_text`）、`epd_fast` 仅强化黑白端点。固件会在解码前检查
  IHDR 的 bit depth/color type、恰好
  16 个互不重复且 `R=G=B` 的 PLTE 项，以及 IDAT/IEND 完整性；全帧和局刷
  sprite 都显式使用 M5GFX `grayscale_8bit`，不会经过 RGB332 合并灰阶。
- 点击区域使用 sidecar 半开区间坐标；重叠时选择面积最小的命中区域。
- 图片全屏不是设备端缩放特例，而是包中的普通图片预览文档/链接，因此仍然
  经过同一套 UUID、分页、SHA-256 和返回导航逻辑。

联网读取把 manifest、document、sidecar 和 PNG 当作一次事务。所有 manifest
派生请求都携带强 `If-Match`，并检查声明长度、SHA-256、包/文档/variant/page
血缘以及 PNG 尺寸。遇到 `412` 时仅刷新同一个 package manifest 并完整重试
一次；第二次变化或任何校验失败都保留屏幕上的上一张已验证帧。当前显示组合
没有预渲染帧时，客户端调用 `POST /api/ink/v1/packages/{id}/render`，不会在
设备上近似修改字号。PaperS3 客户端只请求稳定的白底显示；旧 NVS 中的反色值会在
启动时自动移除，服务器通用协议里的 `invert` 字段固定发送 `false`。

外部 HTTPS 链接由设备提交到 `POST /api/ink/v1/sources/resolve`。Chromium 抓取、
Markdown/InkOS JSON 结构化和渲染全部留在服务器；异步任务最多等待 180 秒，
等待期间只在当前画面底部局刷一行具体进度，不再重复显示“正在载入”，也不会先用
居中模态覆盖整页。设备从不直接抓取目标网站；在线翻页也使用同一提示，成功或回滚
后再显示干净的最终帧。

设备保存的 RSS、网站和图片列表也遵守这条边界。RSS 与网站条目被转换为无坐标
`inkos.content/v2` list，并调用 `POST /api/ink/v1/render`。列表排版、分页
和 hitbox 仍由服务器完成；点中具体条目后，其 HTTPS URL 才进入
`sources/resolve`。新内置包只用两个精确保留动作打开阅读列表：
`inkos://collection/rss` 和 `inkos://collection/website`。旧包中的精确
`inkos://collection/other` 仍可读取，但会映射到同一个网络阅读器；新包不再生成它。
集合数据采用 `inkos.device-collections/v2`（RSS + websites + images）；升级时旧 v1
的 `other` 会按顺序去重并入 websites，随后原子重写为 v2。

首页还可使用两个精确服务端应用动作：`inkos://app/random-image` 和
`inkos://app/baidu-map`。设备为每次进入生成随机 nonce/时间戳，只把动作、当前
显示参数和持久化 `images` 列表提交到 `POST /api/ink/v1/apps/execute`；不会直接
访问 Picsum、普通图片站或百度。图片列表最多 16 项，每项一个全屏页，上下翻页
复用本次 nonce。列表中的内置随机来源也是管理页可见、可改删的真实 Picsum HTTPS
地址；服务器只对这个精确默认地址注入当前屏幕方向和 nonce，保证每次重新进入换图，
其他 HTTPS 图片始终使用用户填写的原地址。旧固件保存的
`inkos://app/random-image` 图片条目会原位迁移成该 HTTPS 地址；应用首页动作本身不变。地图
使用高清、无损、无照片抖动的墨水屏线稿处理；当前位置暂由服务器按出口 IP 推测，
不是设备 GPS。地图密钥只存在服务端环境变量 `INKOS_BAIDU_MAP_AK`，不进入固件、
NVS 或日志。固件还会精确校验服务端的 `X-Ink-App-Image-Mode`：
图片查看器必须是 `photo-papers3-slideshow-gray16-rgb-png-v3`，地图必须是
`diagnostic-raw-colour-png-v1`；缺失、互换或未知值都会保留旧画面并拒绝激活。
照片模式先执行 0.5% 两端自动对比度、1.08 全局对比度、轻量反锐化，再用蛇形
Floyd–Steinberg 量化为 16 级并编码成 M5GFX 稳定灰阶桶中心；地图不进入这条照片
处理链。无论图片像素由照片模式、地图模式还是 `.ink` 包提供，只要文档语义是
`image`，设备切图都统一执行 `epd_text` 整屏清白、`epd_quality` 16 灰阶完整
绘制、`epd_fast` 黑白端点强化三段刷新；检测到纯黑图片时第二段改用
`epd_text`。服务端 profile 只决定像素预处理，不再决定设备是否执行完整图片刷新。

协议细节见 [`../docs/client-protocol.md`](../docs/client-protocol.md)、
[`../docs/ink-package-format.md`](../docs/ink-package-format.md) 和
[`../docs/service-api.md`](../docs/service-api.md)。

## 内置应用首页

`main/assets/home.ink` 通过 `target_add_binary_data` 直接链接进 app 分区，首次启动、
无网络或在线读取失败时都可使用。它是不可修改的最终 fallback。管理后台可上传一个
替换首页；固件写入非活动 `home_a/home_b` 槽，验证完整 ZIP、manifest、兼容性、
父图、所有 document/sidecar/PNG 的规范路径与声明长度，并在提交前逐项读取全部
50 个 document 与 236 个 page，验证 ZIP CRC、manifest SHA-256、document envelope、
sidecar 血缘和 PNG gray4 几何后，才原子提交一条带 CRC 的 NVS 活动记录。页面在
首次显示前仍会再次做内容校验作为纵深防御。上传中断、坏包、断电或启动复验
失败都不会破坏内置首页。HTTP 上传允许最多 120 秒把文件完整接收到 PSRAM，同时
保留 8 秒无前进进度超时，随后返回 `202 Accepted`；较慢的 Flash 写入和校验在
后台执行，管理页每秒查询
`GET /api/home/status` 显示进度，因此请求不会再等待整次 Flash 编程完成。返回
`202` 前固件会先创建后台任务，再取得编译期固定在内部 DRAM 的 2 KiB 写入缓冲。
该缓冲不依赖运行时已经高度碎片化的内部堆；任务栈申请失败或单上传缓冲正在占用时
同步返回 `503`，不会出现已经接受任务、后台才因写入缓冲不足立即失败的情况。

后台 Flash 任务以低优先级固定在 CPU1（Wi-Fi 固定在 CPU0）。写入路径只做逐个
4 KiB sector erase，禁止一次 64 KiB block erase；单次 Flash 写最多 2 KiB，且每次
erase/write 后留出 10 ms 调度窗口，快速 read/compare 每 64 KiB 让步一次，避免长
时间 cache-off 饿死 Wi-Fi、idle task 或 watchdog。串口每 256 KiB 输出写入进度、
任务栈最低余量、内部堆与 PSRAM 的 free/largest block，便于实机定位。

ZIP/manifest 校验与 Flash/NVS 写入被刻意分成两个执行域：只读校验固定在 CPU1 的
32 KiB PSRAM 栈上，原内部栈任务等待结果后才负责 `munmap` 和 NVS commit，PSRAM
栈永远不执行会关闭 Flash cache 的写操作。工程同时把普通 `malloc/new` 的
`CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` 阈值设为 `0`，让 523 项 ZIP 目录、181 KiB
manifest 的 cJSON 节点和 C++ 路径对象优先进入 PSRAM，保留内部堆给 Wi-Fi、lwIP
和 Flash 驱动。接收阶段每 256 KiB 输出累计字节、耗时和内存余量，并只在 RTC
no-init 内存更新 `receiving` 检查点，不会在网络热路径写 NVS 或 Flash。校验日志及
RTC warm-reset 检查点继续细分为 `zip-directory`、
`manifest-extract`、`manifest-parse`、`references`、`entry-frames`、`payloads`、
`commit`；payload 阶段持续输出 `documents=x/50 pages=y/236`、耗时和内存余量。
`GET /api/home/status` 的 `recoveryCheckpoint` 可在 watchdog/软件复位后报告最后阶段。

安全边界为：首次接受上传时验证全 ZIP 的目录/路径/大小闭包，以及每个 manifest
引用 payload 的完整内容；任何非入口压缩流损坏也会在 `writeHomeRecord` 前失败。
NVS 只记录这一已完整验证 archive 的 SHA-256。随后激活或重启重新计算全 archive
SHA、打开 ZIP 并解析 manifest；SHA 相同即证明仍是此前逐项验证过的相同字节。

当前包包含两列四行应用 grid 首页：网络阅读器、RSS 阅读器、老黄历、图片查看器、
百度地图、墨水屏测试、使用指南和时钟；竖屏及横屏基础 variant
都已打包。标题右侧的齿轮通过精确本机动作打开设置，不经过网络抓取。它不是运行时
下载文件，也不会因清除 NVS 而丢失。

首页时钟由服务端 sidecar 声明 `dynamicRegions` 的精确矩形、字号、颜色和刷新
节奏。日期使用清晰的次级标题而不是小号元信息。设备联网后直接使用 SNTP（阿里云、
pool.ntp.org、Cloudflare）校时，按 `Asia/Shanghai` 的整秒边界更新：秒跳、分钟和小时
变化都只提交实际变化的数字字形。服务端 PNG 只为空白时钟区域保留几何位置，不再先
画“校时中”等静态字样。首次本地绘制覆盖整个保留区域，确保兼容旧包中的占位符；之后
只更新变化字形。

PaperS3 的 `epd_quality` 波形包含先把变化像素移到中灰、再稳定到目标色的 32 次扫描，
不适合每秒调用。时钟先把 DejaVu 抗锯齿字形以固定阈值二值化，再使用无擦除阶段的
`epd_fast`。本项目同时让 Panel_EPD 的 fast 分支只比较两个 4-bit 目标像素，不再把
quality/fast 的 LUT 编号差异误判为白底像素变化，因此不会产生整块背景脉冲或 Bayer
网纹。物理 dirty range 也扩展到驱动任务实际消费的四像素边界，避免窄字形右缘的最后
两个像素被遗漏。时钟不执行周期性的“白底一次、字形一次”双相刷新；离开页面后的
完整质量刷新负责清理。时间不可用时保留空白区域和日期、时区说明，不会阻断页面。

完整页面刷新使用三态权限：在线/动态帧缺失 `refreshHint` 时为
`QualityRequired`，只有响应头与 `inkos.frame/v2` manifest 同时明确声明
`binary-text` 才成为快刷候选；两者不一致、未知字符串或非字符串会直接拒绝该帧。
旧版离线/内置 `.ink` 没有该字段，显式使用 `LegacyUnspecified`，仅为兼容而继续
使用设备端启发式。默认值是 `QualityRequired`，新增动态路径即使忘记赋值也不会
意外放宽刷新策略。

候选帧仍要经过两道设备端否决：服务端验证过的 `contentType` 必须是
`detail/list/reader`，并扫描解码后的 8-bit canvas；只有中间灰不超过 4%、
不贴近黑白边缘的内部中灰不超过 0.25% 时，才把它视为“近二值页面”并使用
保留 16 灰阶的高对比 `epd_text`。因此 `binary-text` 只是许可而不是命令，带照片、渐变或灰底卡片的
详情/列表仍自动回退 `epd_quality`；普通 `image` 和未知类型不进入文字波形，
也不会仅凭 `contentType=image` 进入图片强化波形。只有 capability-gated source
JPEG，或通过上述响应头验证的图片查看器 PNG，才带强类型
`PaperS3PhotoGray16` 档位并执行 `epd_text` 白场清理、`epd_quality` 16 灰阶主体、
`epd_fast` 黑白端点强化的三段刷新；地图和普通包 PNG 保持通用质量刷新。`epd_text`
自带擦除阶段，不再沿用旧 `epd_fast` 的“四帧后强制质量刷新”预算；第 12 个稳定页面
仍执行白场清理，再用内容对应的 text/quality 波形稳定。首次显示、旋转以及
设置/状态全屏 UI 后也执行同一清理路径。串口日志记录 hint、
中间灰覆盖率、内部中灰覆盖率、最终模式和实测耗时，便于实机校准阈值。

RSS/网页导航使用一组可关联的结构化串口事件：`NAV_INPUT` 记录手势，
`NAV_TARGET` 记录目标类别，`NAV_START`/`NAV_OK` 以递增 `id` 关联一次导航，
`SOURCE_JOB` 记录 URL 解析任务的 queued/running/complete/failed 阶段，
`NAV_RETRY`、`NAV_FALLBACK` 和 `NAV_RETAIN` 则携带稳定的 typed error code。
由用户配置或远端内容提供的完整 URL、标题和自由文本错误不会写入这些事件；
URL 只以 SHA-256 前 12 位 `source_ref`/`target_ref` 出现，既能对齐
collection → feed → article 的链路，也不会把凭据、query 或私有主机名留在串口。

局部刷新使用等尺寸 `M5Canvas`，在一次 `startWrite`/`pushSprite`/`endWrite`
事务中让 Panel_EPD 从实际写入计算 dirty rectangle；秒跳还用 clip 将 dirty rectangle
收紧到变化字形的实际墨迹边界。常规页面和 UI 在事务前后等待 EPD BUSY；底部单行
加载条使用 `epd_fast` 异步提交，提交后立即继续网络工作，最终页面入口负责等待该
波形完成后再绘制。依赖锁定为已修复旋转 region 问题的 M5GFX 0.2.25，M5Unified
锁定为 0.2.17。

更新内置包时同时替换 `home.ink` 和 `home.version.json`，然后先运行：

```sh
cd firmware-idf
python3 tools/verify_embedded_home.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

校验器会遍历整个 ZIP，拒绝路径穿越、重复/加密/未知压缩条目，并验证 archive
版本记录、manifest、全部文档 envelope、variant/page、每个文件长度和
SHA-256、PNG gray4 几何、sidecar 命中区以及横竖屏时钟动态区域。它也要求 ZIP
中不存在 manifest 未声明的文件。

该校验不是可选的发布脚本：`main/CMakeLists.txt` 把它作为 app component 的构建
依赖，`home.ink`、版本记录或校验器变化都会重新执行；校验失败时 `idf.py build`
无法产生固件。

## 首次联网与配置入口

没有完整网络配置或启动连接失败时，设备继续保留内置首页，同时开放无密码热点：

```text
InkOS-PaperS3-XXXX
```

手机连接后打开 `http://192.168.4.1/`。内置 DNS 会把常见系统联网探测引向配置
页；配置页可填写 Wi-Fi SSID、密码和 InkOS 渲染服务根地址，例如
`http://192.168.1.10:3000`。服务器地址只接受无用户名、路径、query、fragment
的 `http://` 或 `https://` 根地址。配置与显示设置保存在 NVS。

连接成功后 HTTP 服务不会随配置热点关闭，而是在 station 地址继续提供同一个管理
后台；设备设置的“管理后台”一行直接显示 `http://<设备局域网 IP>/`。后台可以修改
Wi-Fi/服务器、维护 RSS/网络阅读/图片查看器、上传并激活首页 `.ink`，或删除上传版恢复
内置首页。API 与大小限制见
[`../docs/papers3-device-management.md`](../docs/papers3-device-management.md)。它只适合
可信局域网/AP，不应直接映射到公网。

如需重配，在设置窗口点“管理后台”；离线时该行会重新开放配置热点。页面也提供
清除已保存网络配置的按钮。
普通掉线不会清空内容，设备会保留当前帧并每 30 秒重试连接。公网 HTTPS 使用
ESP-IDF 系统 CA bundle，不使用 `setInsecure`；局域网自签证书需要换成受信 CA，
或者在可信局域网内使用 HTTP。

按需渲染把 frame manifest、sidecar 和 warnings 放在 base64url 响应头中。ESP-IDF
的 16 KiB receive buffer 只是分段读取大小，并不会截断跨 read 的 header；工程将
HTTP parser 上限设为 2.25 MiB，并在客户端按 key/value 累计实施独立的 2 MiB
硬上限。这个额度可同时容纳 512 KiB sidecar 及同量级 frame manifest 的 base64
编码和常规 warnings；超限响应会被明确拒绝并保留旧帧，不会被当作不完整 JSON 使用。

## 触摸与设置

| 操作 | 行为 |
| --- | --- |
| 点击命中区域 | 打开包内文档、图片预览，或交给服务器解析外部网址 |
| 上划 | 下一页；末页时返回上一层/历史 |
| 下划 | 上一页；第一页时返回父文档/历史 |
| 左划 | 后退 |
| 右划 | 前进 |
| 在屏幕上部 20% 按住至少 5 秒 | 打开设置窗口 |

设置长按最多允许 12 像素移动，避免滚动时误触。普通手势只在抬手后确认：滑动至少
56 像素（或短边 10%）、主方向须比副方向强 40%，持续时间为 60 ms 至 2 s；点击
最多允许 16 像素移动和 750 ms。一次操作开始后，固件丢弃刷新/网络等待期间产生的
触摸，待完全抬手并静默 250 ms 后才接收下一次输入，因此不会把一次长触摸排成两次
导航。设置包括：

- 自动/手动旋转；手动方向可选竖屏或横屏，默认手动竖屏。
- 字号 `-2…+2`。
- 管理后台地址；离线时可重新开放配置热点。

自动旋转读取板载加速度计，使用方向优势阈值和三次采样去抖。应用设置前会先尝试
取得相应的精确 variant/在线渲染；失败时回滚 NVS 和设置，并恢复旧帧。

## 构建、烧录与验证

需要 ESP-IDF `>=5.4,<5.5`（当前验证版本 5.4.3）。组件管理器会按
`dependencies.lock` 获取固定版本的 M5Unified/M5GFX。同步 HTTP/TLS、ZIP/JSON
校验和 PNG 解码都在 `app_main` 任务执行，因此工程显式预留 32 KiB main-task
stack，不使用 ESP-IDF 较小的默认值。串口日志会在启动完成和每次帧激活后输出
`app_main` 历史最小剩余 stack 字节数，方便实机压力测试确认余量。

```sh
source /path/to/esp-idf-v5.4/export.sh
cd firmware-idf
idf.py set-target esp32s3       # 新 checkout 首次执行
python3 tools/verify_embedded_home.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
idf.py build
idf.py size
idf.py -p /dev/ttyACM0 flash monitor
```

flash 按 PaperS3 的 Quad SPI 设为 QIO/80 MHz；ESP-IDF 会按其既定启动流程先把
bootloader 镜像头写成 DIO，再由 bootloader 切到 QIO，这不是配置降级。分区表按
PaperS3 16 MiB flash 配置：NVS 88 KiB、factory app 7.25 MiB、core dump
64 KiB，以及两个各 4.25 MiB、首地址按 64 KiB 对齐的 raw `home_a/home_b` 槽；
flash 尾部保留 64 KiB。在线普通帧只驻留在
内存中；大首页不写 NVS，NVS 只保存紧凑列表与活动槽身份。当前构建约 6.24 MiB，
在 app 分区还留约 1.01 MiB；每次更换内置首页后仍必须以 `idf.py build` 的
partition size gate 为准。

构建成功可证明真实 ESP32-S3 工具链、组件和链接布局成立，但不能代替实机验收。
首次烧录后仍应检查：PaperS3 板型探测、Octal PSRAM、触摸坐标、IMU 方向、16 灰阶
质量、局部刷新残影、各手机系统 captive portal、掉电/NVS 行为和长时间功耗。
