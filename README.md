# dsh-serial-console

A serial port console for the DSH web GUI: open a serial port, watch its output live in the session View row, and let the agent read and drive the same port through one model-visible tool.

面向 DSH Web GUI 的串口控制台：打开串口，在会话的 View 标签行里实时查看输出，并让 agent 通过同一个模型可见的工具读取、驱动同一个端口。

**[English](#english)** · **[中文](#中文)**

---

## English

Works on **Windows, Linux and macOS** from one bundle — the platform is detected
at load time and the matching transport is used.

Built for firmware work — flash an ESP32, reset it, and read the boot log
without leaving the conversation.

### What it adds

| Piece | Where |
| --- | --- |
| Host routes | `GET /serial-console/api/status?since=<cursor>`, `GET /serial-console/api/ports`, `POST /serial-console/api/{open,close,write,reset,clear}` |
| Agent tool | `serial` — `list_ports \| open \| close \| read \| write \| reset \| status \| clear` |
| Session view | a **Serial** tab in the conversation View row (`conversation.view` slot, id `serial`, order 25) |
| Right panel | a docked console beside the message scroller, so output stays visible while the agent drives the port (`shell.overlay` slot, id `serial-drawer`) |
| Tab status dot | grey = no port, green = open, red = the last open failed or the host is unreachable — painted just before the **Serial** tab label, so it stays readable while the right panel is closed (hover the tab for the port and baud) |
| Log highlighting | two switches in the Serial view: ESP level colours (E/W/I/D/V) and custom whole-line rules — each rule is a colour (picker or hex) plus match words separated by commas or semicolons; settings are stored per browser |

Both callers go through the same host functions, so the tool and the panel can
never disagree about which port is open.

### How the port is driven

There is no serial npm package in the DSH host, so the transport is
platform-specific behind one small interface (`list/open/write/close/reset`):

#### Windows — PowerShell bridge

A single long-lived `powershell.exe -File serial-host.ps1` owns a
`System.IO.Ports.SerialPort`. The host spawns it once and speaks a line protocol
over stdin/stdout; every payload is base64, so the pipe never depends on a
console code page:

```
stdin   PING <id> | PORTS <id> | OPEN <id> <b64 json> | CLOSE <id> |
        WRITE <id> <b64 bytes> | RESET <id> | EXIT
stdout  READY | PONG <id> | PORTS <id> <b64 json> | OPENED <id> <b64 json> |
        CLOSED <id> | WRITTEN <id> | RESET <id> | DATA <b64 bytes> |
        NOTE <b64 text> | ERR <id|-> <b64 text>
```

The bridge loop drains up to 8 KiB of serial data per pass, then polls stdin
non-blocking, then sleeps 8 ms, so writes and reads interleave without blocking
either side. `PORTS` answers twice: the fast list first (`GetPortNames()` +
`SERIALCOMM`), then the same list enriched with device friendly names, so the
panel paints immediately instead of waiting on WMI. `RESET` pulses DTR/RTS.

#### Linux and macOS — direct device node

`posix-serial.js` configures the device with `stty` (`-f` on macOS, `-F` on
Linux), then opens the node with `O_RDWR | O_NOCTTY | O_NONBLOCK` and pumps it
with `fs.read`/`fs.write`:

- the frame is built from the selected **baud / data bits / parity / stop
  bits** (default 115200 8N1): `raw -ignbrk -brkint -parmrk -echo -echoe -echok
  -iexten -ixon -ixoff -istrip -inlcr -igncr -icrnl -opost -isig -icanon
  -crtscts clocal hupcl cs<n> (-parenb | parenb [-parodd]) (-cstopb | cstopb)
  min 1 time 0` — the same set `cfmakeraw` clears, so no byte is invented by the
  line discipline;
- the speed is set three ways (`<baud> ispeed <baud> ospeed <baud>`) because a
  USB bridge that keeps a stale **input** speed decodes correctly-bauded bytes
  as noise — the classic "garbage at the right baud rate" symptom;
- after applying it, `stty -a` is read back and compared with what was asked
  for; a mismatch retries with the explicit `ispeed`/`ospeed` form and then
  fails loudly with the driver's own numbers instead of streaming garbage;
- the applied frame is written to the session log (`line: 115200 8N1 on
  /dev/cu.usbserial-110`) so the setting in force is never implicit;
- **macOS ports**: every `/dev/cu.*` device (`/dev/cu.usbserial-1420`,
  `/dev/cu.SLAB_USBtoUART`, …); the `tty.*` twin is skipped on purpose because
  `cu.*` does not block on carrier detect.
- **Linux ports**: stable `/dev/serial/by-id/*` links first (their names carry
  the adapter model), then `/dev/ttyUSB*`, `/dev/ttyACM*`, `/dev/ttyAMA*`,
  `/dev/rfcomm*`.
- **reset** is best effort: closing the descriptor drops DTR (HUPCL) and the
  device is reopened, which reboots most ESP32 boards. Auto-reset circuits that
  need an RTS pulse may need the board button or
  `esptool --before default_reset`.
- readable serial devices normally need to be in the `dialout` group on Linux
  (`sudo usermod -aG dialout $USER`, then log in again).

#### Shared decoding

The host decodes the byte stream with a streaming `TextDecoder`, strips ANSI
escapes, normalizes CR/CRLF to LF, and keeps the result in a 256 KiB ring buffer
addressed by **opaque byte cursors** — a caller asks for "everything after N" and
never races the stream. A cursor older than the buffer reports
`truncated: true`.

### Using the tool from a conversation

```
serial { action: "list_ports" }                                  → COM6 — Silicon Labs CP210x …
serial { action: "open", port: "COM6", baudRate: 115200 }
serial { action: "reset" }                                       → reboot, then:
serial { action: "read", waitMs: 4000 }                          → boot log
serial { action: "write", text: "help", ending: "crlf" }
serial { action: "close" }
```

On Linux/macOS the port argument is a device path:

```
serial { action: "open", port: "/dev/ttyUSB0", baudRate: 921600 }
serial { action: "open", port: "/dev/cu.usbserial-1420", baudRate: 115200 }
```

The frame is selectable on both platforms — `dataBits` (5–8), `parity`
(`None`/`Even`/`Odd`, plus `Mark`/`Space` on Windows) and `stopBits`
(`1`/`2`, `1.5` with 5 data bits on Windows):

```
serial { action: "open", port: "COM6", baudRate: 9600, parity: "Even", dataBits: 7, stopBits: "One" }
serial { action: "open", port: "/dev/cu.usbserial-110", baudRate: 115200, dataBits: 8, parity: "None", stopBits: "Two" }
```

The Serial view has matching Bits / Parity / Stop selectors next to the baud
list, and both the status line and the panel header show the frame in force
(`/dev/cu.usbserial-110 · 115200 8N1`).

`read` blocks up to `waitMs` (max 15000) for new output instead of returning an
empty string, which is what makes "reset and read the boot log" one tool call
each instead of a polling loop. Pass `since` (the `cursor` from a previous
read) to continue where you left off.

Pass the device path on its own. The panel shows each entry as
`<port> — <label>`, and pasting that whole line (or a `\\.\COM3` form, a bare
`cu.usbserial-110` / `ttyUSB0`, or a path carrying zero-width characters) is
repaired before the port is opened — but POSIX paths are case-sensitive, so
`/dev/cu.usbserial-110` must keep its lower case.

`status` reports which transport is active (`transport: posix (linux)` or
`transport: powershell (win32)`).

### Log highlighting

Two switches in the Serial view colour the device output without changing a
single byte of it — the text stays exactly what arrived, so a copy still pastes
into another tool unchanged. The right-hand panel uses the same renderer and
shows the same colours.

- **ESP level colors** (on by default) recognises the ESP-IDF line shape
  `L (timestamp) tag: message` and colours the whole line by level: `E` error,
  `W` warning, `I` info, `D` debug, `V` verbose. Theme tokens are used, so the
  colours follow light/dark mode.
- **Custom colors** (off by default) applies a list of rules. Each rule has a
  colour (pick it, or type `#aabbcc`, `abc`, …) and one or more match words
  separated by ASCII or full-width commas and semicolons (`ERROR, error，失败`).
  A line containing any of a rule's words is painted entirely in that rule's
  colour; when several rules match, the first one in the list wins. Custom rules
  are evaluated before the level colours, so they override them for the lines
  they match. Matching is case-insensitive and treats the words as plain text
  (not regular expressions).

Only device output (`rx`) is coloured: what you send stays green and the plugin's
own notes stay grey italics. Settings live in `localStorage` under
`dsh-serial-console.highlight` — per browser, not per host.

### Refresh behaviour

The browser half polls `/status` adaptively: 120 ms while the port is open, 16 ms
while data keeps arriving (so a burst is drained in one go), 900 ms when the port
is closed or the last request failed. Appends are coalesced into at most one
render per animation frame, log rows are memoized and keyed by a monotonic id (so
trimming the head no longer remounts the whole log), and the tab and the drawer
share one poller. Polling stops entirely while the page is hidden.

### Placement

The floating panel docks inside the message scroller of the conversation, not on
top of it. A zero-size probe inside the Chat view measures that scroller (its
box, its scrollbar band and the viewport) and the panel is laid out against the
measured right edge, 8 px inside it and left of the scrollbar. While the panel is
shown the scroller reserves the same width plus 12 px of padding on its right, so
Chat text reflows beside the panel instead of running underneath it.

Because the scroller shrinks when the right document column opens (for example a
Markdown preview), the measured box shrinks with it and the panel follows: the
two never overlap. When the conversation column becomes too narrow to hold both
(`< 176 px` of usable width) the panel is not drawn and the Serial tab shows a
hint instead. Closing the panel restores the previous inline `padding-right` of
the scroller.

### Limits

- One port per host process, shared by every session view and tool call.
- The ring buffer holds 256 KiB of text; older output is dropped.
- POSIX has no DTR/RTS control without a native module, so `reset` there is a
  best-effort DTR drop (see above).
- Log-colour rules are a browser-side view preference: they are not read by the
  `serial` tool, not shared between browsers, and a custom colour is a literal
  hex value, so it does not follow the theme (the built-in level colours do).
- The tab status dot is a CSS pseudo-element on the tab button. The View tab row
  exposes no per-view hook for it (`conversation.view` registers only
  `id`/`order`/`label`), so the button is located through the row's
  `[data-conversation-tabs]` anchor and the tab's own label text. If a future DSH
  changes either, the dot stops appearing; nothing else degrades.

### Install

Two ways, both through the **Plugins** page (or the `plugin_manager` tool).

**From this repository** — paste the repository address into the Plugins page:

```
https://github.com/Maki-114514/dsh-serial-console
```

The plugin manager accepts Git hosts as install specs, so that URL is cloned and
packed as-is. Pin a release by appending a ref, for example
`https://github.com/Maki-114514/dsh-serial-console#v0.2.2`. Upgrade later by
removing and installing again, since an already-installed package is rejected
while HMR is active.

**From a local checkout** — point at the directory instead:

```
plugin_manager { action: "install_bundle", target: "<absolute path to this directory>" }
```

The package ships only `index.js`, `posix-serial.js`, `client.js`,
`serial-host.ps1`, the patch, the icon and the two locale files; nothing is
generated at install time, so a fresh clone is immediately installable.

### Layout

```
index.js          host half: transport dispatch, ring buffer, HTTP routes, `serial` tool
posix-serial.js   Linux/macOS transport: stty + fs read/write on the device node
client.js         browser half: the Serial view (module-loader bundle)
serial-host.ps1   the Windows PowerShell process that owns the serial port
cordis.patch.yml  bundle row inserted on install
locale/{en,zh}.json  display name and description
```

## 中文

同一套代码支持 **Windows、Linux 和 macOS**：加载时自动探测平台，选用对应的传输层。

为固件调试而生 —— 烧录 ESP32、复位、读启动日志，全程不离开对话。

### 新增了什么

| 组成 | 位置 |
| --- | --- |
| Host 路由 | `GET /serial-console/api/status?since=<cursor>`、`GET /serial-console/api/ports`、`POST /serial-console/api/{open,close,write,reset,clear}` |
| Agent 工具 | `serial` —— `list_ports \| open \| close \| read \| write \| reset \| status \| clear` |
| 会话视图 | 会话 View 行里的 **串口** 标签页（`conversation.view` 槽，id `serial`，order 25） |
| 右侧面板 | 停靠在消息滚动区旁边的控制台，agent 驱动端口时输出始终可见（`shell.overlay` 槽，id `serial-drawer`） |
| 标签状态点 | 灰 = 未打开，绿 = 已打开，红 = 上次打开失败或 host 失联 —— 画在 **串口** 标签文字之前，右侧面板关闭时也看得到（悬停标签可看端口与波特率） |
| 日志着色 | 串口页的两个开关：ESP 级别着色（E/W/I/D/V），以及自定义整行规则 —— 每条规则是一个颜色（拾色器或十六进制）加一组识别词，词之间用逗号或分号分隔；设置按浏览器保存 |

工具与面板走同一组 host 函数，所以两者对「当前打开的是哪个端口」永远不会各执一词。

### 端口是怎么驱动的

DSH host 里没有串口 npm 包，所以传输层按平台实现，共同收敛到一个很小的接口（`list/open/write/close/reset`）：

#### Windows —— PowerShell 桥

一个长期存活的 `powershell.exe -File serial-host.ps1` 持有 `System.IO.Ports.SerialPort`。Host 只启动它一次，之后用行协议在 stdin/stdout 上通信；所有载荷都是 base64，因此管道不依赖控制台代码页：

```
stdin   PING <id> | PORTS <id> | OPEN <id> <b64 json> | CLOSE <id> |
        WRITE <id> <b64 bytes> | RESET <id> | EXIT
stdout  READY | PONG <id> | PORTS <id> <b64 json> | OPENED <id> <b64 json> |
        CLOSED <id> | WRITTEN <id> | RESET <id> | DATA <b64 bytes> |
        NOTE <b64 text> | ERR <id|-> <b64 text>
```

桥接循环每轮最多抽 8 KiB 串口数据，然后非阻塞地轮询 stdin，再睡 8 ms，让读写在两侧都不互相阻塞。`PORTS` 会回答两次：先给快列表（`GetPortNames()` + `SERIALCOMM`），再给带设备友好名的同一份列表，于是面板立刻能画出来，不必等 WMI。`RESET` 打 DTR/RTS 脉冲。

#### Linux 与 macOS —— 直接操作设备节点

`posix-serial.js` 先用 `stty` 配置设备（macOS 用 `-f`，Linux 用 `-F`），再以 `O_RDWR | O_NOCTTY | O_NONBLOCK` 打开节点，用 `fs.read`/`fs.write` 收发：

- 帧参数由选定的 **波特率 / 数据位 / 校验 / 停止位**（默认 115200 8N1）拼出：`raw -ignbrk -brkint -parmrk -echo -echoe -echok -iexten -ixon -ixoff -istrip -inlcr -igncr -icrnl -opost -isig -icanon -crtscts clocal hupcl cs<n> (-parenb | parenb [-parodd]) (-cstopb | cstopb) min 1 time 0` —— 与 `cfmakeraw` 清除的集合一致，行规程不会凭空造出字节；
- 速度用三种写法一起设置（`<baud> ispeed <baud> ospeed <baud>`），因为保持旧**输入**速率的 USB 桥会把波特率正确的字节解码成噪声 —— 这就是经典的「波特率对、但全是乱码」；
- 设置完回读 `stty -a` 与请求值比对；不一致就用显式的 `ispeed`/`ospeed` 再试一次，仍不成就带着驱动自己报的数字明确失败，而不是继续输出垃圾；
- 生效的帧会写进会话日志（`line: 115200 8N1 on /dev/cu.usbserial-110`），当前生效的设置从不靠猜；
- **macOS 端口**：所有 `/dev/cu.*` 设备（`/dev/cu.usbserial-1420`、`/dev/cu.SLAB_USBtoUART` 等）；故意跳过 `tty.*` 孪生节点，因为 `cu.*` 不会因载波检测而阻塞；
- **Linux 端口**：优先稳定的 `/dev/serial/by-id/*` 链接（名字里带适配器型号），然后是 `/dev/ttyUSB*`、`/dev/ttyACM*`、`/dev/ttyAMA*`、`/dev/rfcomm*`；
- **reset** 是尽力而为：关闭描述符让 DTR 落下（HUPCL），再重新打开，多数 ESP32 板会因此重启。需要 RTS 脉冲的自复位电路，可能仍要按板载复位键或使用 `esptool --before default_reset`；
- 在 Linux 上，可读的串口设备通常要求用户在 `dialout` 组（`sudo usermod -aG dialout $USER`，然后重新登录）。

#### 共享的解码

Host 用流式 `TextDecoder` 解码字节流，剥掉 ANSI 转义，把 CR/CRLF 规范化成 LF，结果放进 256 KiB 的环形缓冲，用**不透明字节游标**寻址 —— 调用方只说「给我第 N 字节之后的所有内容」，永远不与数据流竞争。比缓冲还老的游标会返回 `truncated: true`。

### 在对话里使用工具

```
serial { action: "list_ports" }                                  → COM6 — Silicon Labs CP210x …
serial { action: "open", port: "COM6", baudRate: 115200 }
serial { action: "reset" }                                       → 重启，然后：
serial { action: "read", waitMs: 4000 }                          → 启动日志
serial { action: "write", text: "help", ending: "crlf" }
serial { action: "close" }
```

在 Linux/macOS 上，端口参数就是设备路径：

```
serial { action: "open", port: "/dev/ttyUSB0", baudRate: 921600 }
serial { action: "open", port: "/dev/cu.usbserial-1420", baudRate: 115200 }
```

两个平台都可以选帧参数 —— `dataBits`（5–8）、`parity`（`None`/`Even`/`Odd`，Windows 另支持 `Mark`/`Space`）与 `stopBits`（`1`/`2`，Windows 上 5 数据位时可用 `1.5`）：

```
serial { action: "open", port: "COM6", baudRate: 9600, parity: "Even", dataBits: 7, stopBits: "One" }
serial { action: "open", port: "/dev/cu.usbserial-110", baudRate: 115200, dataBits: 8, parity: "None", stopBits: "Two" }
```

串口页在波特率下拉旁边有对应的 Bits / Parity / Stop 选择器，状态行和面板标题都会显示当前生效的帧（`/dev/cu.usbserial-110 · 115200 8N1`）。

`read` 最多阻塞 `waitMs`（上限 15000）等新输出，而不是直接返回空串 —— 这让「复位并读启动日志」变成两个工具调用，而不是一轮轮询。把上一次 read 返回的 `cursor` 作为 `since` 传进去，就能接着上次的位置读。

端口只传设备路径本身。面板把每个条目显示成 `<port> — <label>`，把整行粘进去（或粘 `\\.\COM3` 形式、裸的 `cu.usbserial-110` / `ttyUSB0`、夹带零宽字符的路径）都会在打开前被修正 —— 但 POSIX 路径区分大小写，`/dev/cu.usbserial-110` 必须保持小写。

`status` 会报告当前生效的传输层（`transport: posix (linux)` 或 `transport: powershell (win32)`）。

### 日志着色

串口页里的两个开关给设备输出上色，但**不改动任何一个字节** —— 文本仍是你收到的原文，复制出去粘到别处也不会变形。右侧抽屉用同一套渲染器，颜色一致。

- **ESP 级别着色**（默认开启）识别 ESP-IDF 的行首形状 `L (timestamp) tag: message`，按级别给整行上色：`E` 错误、`W` 警告、`I` 信息、`D` 调试、`V` 详细。用的是主题 token，所以明暗模式自动适配。
- **自定义颜色**（默认关闭）应用一组规则。每条规则有一个颜色（用拾色器选，或直接敲 `#aabbcc`、`abc` 等）和一到多个识别词，用半角/全角的逗号、分号分隔（`ERROR, error，失败`）。一行里只要含某条规则的任意识别词，就整行用该规则的颜色；多条规则同时命中时，列表里靠前的生效。自定义规则先于级别色判断，所以命中的行会覆盖级别色。匹配大小写不敏感，识别词按纯文本处理（不是正则）。

只有设备输出（`rx`）会上色：你发送的内容保持绿色，插件自己的提示保持灰色斜体。设置存在 `localStorage` 的 `dsh-serial-console.highlight` 下 —— 按浏览器保存，不按 host。

### 刷新行为

浏览器半边自适应轮询 `/status`：端口打开时 120 ms，数据持续到达时 16 ms（一轮就把突发抽干），端口关闭或上次请求失败时 900 ms。追加合并在每个动画帧里至多渲染一次；日志行做了 memo 并以单调递增的 id 作 key（所以裁掉头部不再重挂整个日志）；标签页与抽屉共用一个轮询器。页面隐藏时完全停止轮询。

### 停靠位置

悬浮面板停靠在对话的消息滚动区**内部**，而不是盖在上面。Chat 视图里有一个零尺寸探针测量这个滚动区（盒子、滚动条带、视口），面板贴着测得的右边缘往内 8 px、位于滚动条左侧排版。面板显示期间，滚动区在右侧预留同样宽度再加 12 px 内边距，于是 Chat 文本在面板旁边重排，而不是钻到面板底下。

因为右侧文档栏打开时（例如 Markdown 预览）滚动区会变窄，测得的盒子随之缩小、面板跟着走：两者永不重叠。对话栏窄到放不下两者时（可用宽度 `< 176 px`），面板不绘制，串口页改为显示一条提示。关闭面板会恢复滚动区原来的行内 `padding-right`。

### 限制

- 每个 host 进程只有一个端口，被所有会话视图与工具调用共享。
- 环形缓冲保存 256 KiB 文本，更旧的输出会被丢弃。
- POSIX 上没有原生模块就没有 DTR/RTS 控制，所以那里的 `reset` 只是尽力落下 DTR（见上）。
- 日志着色规则是浏览器侧的视图偏好：`serial` 工具读不到它们，也不跨浏览器共享；自定义色是字面量十六进制值，不跟随主题（内置级别色跟随）。
- 标签状态点是标签按钮上的 CSS 伪元素。View 标签行没有给单个视图留钩子（`conversation.view` 只注册 `id`/`order`/`label`），所以按钮是通过行上的 `[data-conversation-tabs]` 锚点加标签文字定位的。未来 DSH 改了其中任一处，圆点就不再出现，其它功能不受影响。

### 安装

两种方式，都走 **插件** 页（或 `plugin_manager` 工具）。

**从本仓库安装** —— 把仓库地址粘到插件页：

```
https://github.com/Maki-114514/dsh-serial-console
```

插件管理器接受 Git 地址作为安装源，所以这个 URL 会被 clone 并按原样打包。要固定到某个发布，在末尾加 ref，例如 `https://github.com/Maki-114514/dsh-serial-console#v0.4.0`。升级时先移除再安装，因为 HMR 激活期间已安装的包会被拒绝。

**从本地检出安装** —— 直接指向目录：

```
plugin_manager { action: "install_bundle", target: "<本目录的绝对路径>" }
```

包里只有 `index.js`、`posix-serial.js`、`client.js`、`serial-host.ps1`、patch、图标和两个 locale 文件；安装时不生成任何东西，所以新 clone 下来即可安装。

### 代码结构

```
index.js          host 半边：传输层分派、环形缓冲、HTTP 路由、`serial` 工具
posix-serial.js   Linux/macOS 传输层：stty + 对设备节点的 fs 读写
client.js         浏览器半边：串口视图与右侧面板（module-loader bundle）
serial-host.ps1   持有串口的 Windows PowerShell 进程
cordis.patch.yml  安装时插入的 bundle 行
locale/{en,zh}.json  显示名称与描述
```
