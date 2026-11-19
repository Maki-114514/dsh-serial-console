# DSH 串口控制台插件 — 迁移交接说明

面向「把这套东西搬到 Mac 上继续调试」的交接文档。仓库本身包含全部源码与历史，
所以最省事的做法是：`git clone` 仓库，再读本文。

- 仓库：<https://github.com/Maki-114514/dsh-serial-console>
- 当前版本：**0.4.0**（tag `v0.4.0`，main 分支）
- 平台：Windows / Linux / macOS 一套代码，运行时按 `process.platform` 自动选传输层
- 状态：Windows 全链路已实测（含真实 ESP32 读取）；macOS 已在 CP2102N + ESP32-S31 上实测通过
  （115200 读到启动日志，见 6.1）。0.4.0 的内容：修复「先 open 再 stty」的驱动复位问题、
  标签状态点、日志着色（ESP 级别 + 自定义规则）、面板逐帧跟随与更省的 presence 轮询

---

## 1. 这个插件是什么

一个 DSH（DeepSeek Harness）Web UI 插件，把串口变成对话里可直接使用的能力：

| 面向 | 能力 |
| --- | --- |
| Agent（工具 `serial`） | `list_ports` / `open` / `read`（可阻塞 `waitMs`）/ `write` / `reset` / `close` / `status` / `clear`，返回文本 + 游标，可 `since` 续读 |
| 用户（会话视图） | 「串口」标签页：选端口、波特率、**数据位/校验/停止位**，连接、断开、复位、发送、日志固定高度内滚 |
| 对话页右侧 | 当 agent（或本会话）在驱动串口时，右侧悬浮面板实时显示同一路数据；只在**本会话的对话页**出现，切到轨迹/其它会话自动消失 |
| 全局提示 | 注册了 `## Serial console` 系统提示段（order 880），所以**任何会话**都知道有这个工具 |

---

## 2. 架构

```
浏览器（client.js）
  ├─ conversation.view   → 「串口」标签页（SerialView）
  ├─ shell.overlay       → 右侧悬浮面板（SerialDrawer），停靠在消息滚动容器内侧并为其预留宽度
  ├─ conversation.chat.* → 零尺寸探针（PresenceProbe）：判断「本会话的对话页是否在前台」
  └─ fetch('/serial-console/api/...')  ── 同源 HTTP ──┐
                                                      │
Host（index.js，Cordis 插件）                          │
  ├─ webServer.register  /status /ports /open /close /write /reset /clear
  ├─ tools.register      serial（10 个 action）
  ├─ systemPrompt.section ## Serial console
  ├─ 环形缓冲（256 KiB 文本 + 游标 + generation）
  └─ 传输层分发
       ├─ win32  → PowerShell 子进程 serial-host.ps1（System.IO.Ports.SerialPort，行协议）
       └─ 其它   → posix-serial.js（stty 配置 + fs 读写，无原生依赖）
```

要点：

- **没有原生模块**，所以不需要编译，也不需要 `serialport` 包。
- Windows 走常驻 PowerShell 桥（stdin/stdout 行协议，base64 载荷）；
  macOS/Linux 直接在 Host 进程里 `stty` + `fs.read/write`。
- 浏览器端不依赖 Typert/remote，纯同源 `fetch`（Host 侧有同源校验，拒绝跨站）。

---

## 3. 文件清单

| 文件 | 作用 | 关键位置 |
| --- | --- | --- |
| `index.js` | Host 半边：缓冲、路由、工具、平台分发、提示段 | `TRANSPORT` :51，`pushBytes` :280，`handleLine` :296，`startBridge` :420，`listPorts` :514，`normalizePort` :534，`normalizeParity/StopBits/DataBits` :562/:579/:587，`openPort` :596，`closePort` :656，`writeText` :687，`resetTarget` :713，`snapshot` :725，`waitForData` :762，`apply` :843，`systemPrompt.section` :953，工具定义 :966 |
| `posix-serial.js` | Linux/macOS 传输层：stty 配置 + 回读校验 + fs 读写 | `PARITY_TOKENS` :34，`STOP_TOKENS` :40，`buildLineConfig` :57，`parseSttyShow` :115，`runStty` :139，`frameMatches` :160，`configureLine` :177，`createPosixSerial` :267，`open`（先 open 再配置）:395 |
| `serial-host.ps1` | Windows 桥：持有 `SerialPort`，行协议 | `Get-PortList`、`Open`（含 `ReadBufferSize`/`WriteTimeout`/`ReadTimeout`）、主循环 `Start-Sleep -Milliseconds 4` |
| `client.js` | 浏览器半边：标签页、右侧面板、探针、轮询、日志着色 | `API` :21，`POLL_*` :22-28，`buildPaint` :413，`paintText` :501，`LogLine` :727，`Switch` :738，`RuleRow` :759，`SerialView` :865，`findFlow` :1277，`PresenceProbe` :1461，`applyReserve` :1541，`computeDock` :1572，`SerialDrawer` :1651，槽位注册 :1786/:1840 |
| `package.json` | DSH bundle 元数据（`dsh.bundle.patch` / `dsh.client`）与版本 | — |
| `cordis.patch.yml` | 插件挂载补丁（`insert` 一条 entry） | — |
| `locale/en.json`、`locale/zh.json` | 插件页标题/描述 | — |
| `icon.png` | 128×128 图标（自己画的，MIT 随仓库） | — |
| `README.md` | 对外文档：安装、用法、两平台传输细节、刷新策略、停靠策略 | — |

---

## 4. 版本与提交

| tag | commit | 内容 |
| --- | --- | --- |
| `v0.2.2` | `a1ace82` / `616b734` | 首次进仓库 + 文档化「用仓库地址安装」 |
| `v0.2.3` | `b8bd075` | **修 Mac 端口路径被大写**导致 `port must be a device path…`；新增 `normalizePort`（标签、`\\.\COM3`、零宽字符、裸 `cu.*`/`ttyUSB*`） |
| `v0.3.0` | `84911ac` | **乱码修复**（ispeed/ospeed 三写 + `stty -a` 回读校验 + 显式重试）、**数据位/校验/停止位可选**、`line: …` 生效帧格式日志 |
| `v0.3.1` | `584b22e` | 补齐 `-ignbrk -brkint -parmrk`（对齐 `cfmakeraw`）；stty 关键字不被支持时退回最小参数集 |
| `v0.4.0` | `git rev-parse v0.4.0` | **先 open 再 stty**（DriverKit 串口驱动在最后一个 fd 关闭时复位行设置，旧顺序会把波特率丢掉）；标签状态点；日志着色（ESP 级别 + 自定义规则）；停靠面板逐帧跟随；presence 轮询 400 ms → 1 s；`closePort` 清掉陈旧错误 |

测试数据点（Windows，用于对照）：

- COM6（Silicon Labs CP210x）115200 打开后读到 ESP32 启动日志（`s31_face_recognize`、ESP-IDF v6.1、PSRAM 16384K），说明文本解码与线路正常。
- COM3（蓝牙 SPP）9600 可开可读，无对端时 `write` 会超时但不拖垮桥。

---

## 5. 在 Mac 上继续

### 5.1 安装/升级（最常用）

插件页 → 移除 `dsh-serial-console` → 安装：

```
https://github.com/Maki-114514/dsh-serial-console#v0.4.0
```

装完**刷新一次页面**（前端 bundle 变了，不刷新看不到新的「数据位/校验/停止位」下拉框）。

> 为什么必须「先移除再装」：DSH 的插件管理器在包已安装时会以 `already-installed` 拒绝，
> 不会静默升级。

### 5.2 想改代码调试（推荐开发方式）

```sh
# 1. 取代码
git clone https://github.com/Maki-114514/dsh-serial-console.git
cd dsh-serial-console

# 2. 安装成本地目录（不要用 URL，否则装的是打包副本）
#    让 agent 执行，或在插件页粘贴绝对路径：
#    /Users/<你>/…/dsh-serial-console
```

改完代码后：移除 → 以同一本地目录再装一次（Host 半边会重新加载；只改前端也要刷新页面）。
DSH 对本地目录是 `link` 安装，所以「移除再装」很快，不需要拷文件。

### 5.3 只在 Mac 上跑、不装插件也可以

`posix-serial.js` 是纯 ESM、无依赖，可以单独跑：

```sh
node -e "import('./posix-serial.js').then(async m => {
  const s = m.createPosixSerial({ onBytes: b => process.stdout.write(Buffer.from(b)),
                                   onNote: t => console.error('note:', t) })
  console.log(await s.list())
  await s.open({ port: '/dev/cu.usbserial-110', baudRate: 115200, dataBits: 8, parity: 'None', stopBits: 'One' })
  setTimeout(async () => { console.log(await s.status()); await s.close() }, 3000)
})"
```

这条命令能独立验证「是不是插件 UI 的问题」还是「传输层的问题」。

### 5.4 日志着色（客户端，2026-11-19）

纯前端特性，host 一行没改，改完刷新页面即可：

- 两个开关在 Serial 页第三行工具栏；规则列表只在「自定义颜色」打开时出现。
- 着色发生在渲染层：`LogLine` 把 `paint`（不可变快照，`buildPaint` 带自增
  `version`）纳入 `React.memo` 比较，因此流式追加只绘新增行，只有改设置才重绘存量。
- 规则词/hex 键入走 300 ms 防抖（`scheduleHighlight`）再重建 paint，避免每敲一字
  就把 200k 字符日志重排；开关与增删规则立即提交。
- 级别色用主题 token（`--dsw-alias-state-error|warn|success-primary`、
  `--dsw-alias-brand-primary`、`--dsw-alias-label-secondary`），自定义色是字面量。
  自定义规则先于级别色，列表顺序优先；只作用于 `rx`（`tx`/`sys` 保持原样式）。
- 识别词按大小写不敏感的子串匹配（不是正则），全/半角逗号、分号都能分列；
  上限 20 条规则、每规则 50 词、单词 64 字符。
- 持久化：`localStorage['dsh-serial-console.highlight']`，浏览器本地，不同步到 host。
- 纯函数单测钩子：`globalThis.__DSH_SERIAL_TEST__ = true` 时模块对象多出
  `__serialTest = { parseRuleWords, normalizeHex, buildPaint, paintText, colorOfLine }`，
  浏览器里不设标记就不会暴露；测试脚本见交付说明。

---

## 6. macOS 乱码：根因、修复与实测

### 症状

连接正常、数据在流动，但**在正确波特率下全部乱码**；同一设备用其它监视器（screen / picocom / ESP-IDF monitor / CoolTerm）正常。

### 判断（当前假设）

其它监视器都显式设置了**输入速度**；`stty` 在部分 BSD/macOS 组合下对 USB 桥可能只让输出速度生效，
输入侧仍停在旧速率（常见 9600）。若输入采样率与设备不符，解出来就必然是垃圾字节 —— 表现为
「波特率明明对，但全是乱码」。这正是 v0.3.0 针对的路径：

1. 速度**三写**：`<baud> ispeed <baud> ospeed <baud>`；
2. 应用后立刻 `stty -a` **回读**，比对速度/数据位/校验/停止位；
3. 不一致就用显式 `ispeed/ospeed` 形式**重试**；
4. 仍不一致则**报错并打印驱动自己的数字**，而不是继续显示乱码；
5. v0.3.1 补齐 `-ignbrk -brkint -parmrk`，与 `cfmakeraw` 对齐，断帧/帧错误不再凭空插入 `0x00`。

### 升级后怎么判断「好了没有」

打开串口后，日志里会出现一行（进入 0.3.x 才有）：

```
line: 115200 8N1 on /dev/cu.usbserial-110
```

- **有这行 + 输出正常** → 修复生效，收工。
- **有这行 + 还是乱码** → 说明驱动确实接受了 115200 8N1 但解码仍错，按第 7 节抓证据：
  多半是「设备的真实波特率/帧格式」或「适配器固件速率」问题，而不是插件。
- **没有这行、变成报错** `cannot set … stty reports speed …` → 直接把这段发我：
  它包含驱动真实接受的速度/数据位/校验/停止位，能一步定位。
- **出现 `(minimal stty set)`** → 该机器的 stty 不认某些关键字，已自动降级；也请把整行发我。

### 6.1 实测根因（2026-11-19，macOS + CP2102N，DriverKit 串口驱动）

上一节的「输入/输出速度不同步」假设在 CP2102N 上**不是**根因。真实原因是**设置顺序**：

- 该驱动节点为 `/dev/cu.usbserial-210`（Silicon Labs CP2102N，Apple `com.apple.driver.driverkit.serial` 链路）。
  设备在**没有 fd 打开**时，行设置不会保留：最后一条 fd 关闭后速度回到驱动默认 9600。
- 因此旧代码「先 `stty -f <dev> …` 再 `open()`」里的设置在 `open()` 生效那一刻就被驱动重置成 9600，
  紧接着 `stty -a` 回读自然报 `speed 9600`，于是出现
  `cannot set 115200 8N1 on /dev/cu.usbserial-210: stty reports speed 9600 …`。
- 实测对照（同一条命令，仅改变「是否持有 fd」）：

  | 操作 | `stty -a` 读回 |
  |---|---|
  | 设备关闭时 `stty -f dev 115200` | 仍是 9600（退出码 0，静默忽略） |
  | 先 `open(dev)` 持有 fd，再 `stty -f dev 115200` | 115200，且在 fd 关闭前一直保持 |
  | fd 关闭后 | 回到 9600 |

- **修复**：`posix-serial.js` 的 `open()` 改为「先打开 fd → 再 `configureLine()` → 失败则关闭 fd 并抛错」。
  回读校验也随之在 fd 持有期间完成，`line: 115200 8N1 on …` 才是真的。
- **验证**：修复后在 GUI / `serial` 工具打开 115200，`stty -a` 显示 `speed 115200`，并完整读到
  ESP32-S31 的启动日志（`ESP-ROM:esp32s31-…` / `boot.esp32s31: SPI Speed : 80MHz` 全部可读），
  说明线上速率确实是 115200 而非「看起来对、实际乱码」。
- **对第 7 节诊断脚本的影响**：`stty -f dev …` 之后再 `stty -a` 会看到 9600，**这不代表设置失败**。
  手工验证时必须让设备保持打开，例如：

  ```sh
  python3 - <<'EOF'
  import serial, subprocess, time
  p = '/dev/cu.usbserial-210'
  s = serial.Serial(p, 115200, timeout=0.2)
  print(subprocess.run(['stty','-f',p,'-a'],capture_output=True,text=True).stdout.split('\n')[0])
  time.sleep(1); print(s.read(4096))
  s.close()
  EOF
  ```

  或者直接在插件里点「连接」后看 `serial status` 的 `connection.baudRate` 与日志区输出。

---

## 7. 诊断手册（Mac 上可直接跑）

```sh
# 0) 端口在哪
ls -l /dev/cu.* /dev/tty.*      # cu.* 不等待载波，优先用 cu.*

# 1) 打开前：驱动现状（关键！看 speed / ispeed 是否一致）
stty -f /dev/cu.usbserial-110 -a

# 2) 手动按插件的方式设置，然后再读一次
stty -f /dev/cu.usbserial-110 115200 ispeed 115200 ospeed 115200 raw \
     -ignbrk -brkint -parmrk -echo -echoe -echok -iexten -ixon -ixoff \
     -istrip -inlcr -igncr -icrnl -opost -isig -icanon -crtscts clocal hupcl \
     cs8 -parenb -cstopb min 1 time 0
stty -f /dev/cu.usbserial-110 -a     # 确认 speed=115200、cs8、-parenb、-cstopb

# 3) 不经过插件，直接看原始字节（乱码与否一目了然）
cat /dev/cu.usbserial-110 | head -c 200 | xxd

# 4) 对照：pyserial（如果有）读 100 字节
python3 - <<'PY'
import serial
s = serial.Serial('/dev/cu.usbserial-110', 115200, timeout=2)
print(s.read(100))
PY
```

判读：

- 步骤 3 用 `cat/xxd` 也是乱码 → 与插件无关（线路/设备/适配器层面），重点查设备真实波特率、
  适配器是否被别的进程占用、USB 线/供电。
- 步骤 3 正常、插件乱码 → 插件侧，把 `line: …` 行与 `stty -a` 前后对比发我。
- 步骤 1 里 `speed` 与 `ispeed`/`ospeed` 不一致 → 正是本次修复要覆盖的场景，升级到 0.3.1 应消失。

---

## 8. Host ↔ PowerShell 桥协议（Windows，排查用）

stdin（每行一条，ASCII）：

```
PING <id> | PORTS <id> | OPEN <id> <base64 json> | CLOSE <id>
WRITE <id> <base64 bytes> | RESET <id> | EXIT
```

stdout：

```
READY | PONG <id> | PORTS <id> <b64 json>（先快照一次，WMI 富化后再发一次）
OPENED <id> <b64 json> | CLOSED <id> | WRITTEN <id> | RESET <id>
DATA <b64> | NOTE <b64> | ERR <id|-> <b64>
```

- 主循环 8 轮串口 drain（每轮上限 8 KiB）→ 非阻塞 stdin 读 → `Start-Sleep -Milliseconds 4`。
- 桥挂了会自动重启（`startBridge` 有 `READY_TIMEOUT_MS = 20000` 与重启计数）。

---

## 9. 已知限制 / 待办

1. macOS 乱码的根因与修复已在 CP2102N + ESP32-S31 上闭环（见 6.1）；换用其它 USB 桥（CH34x/FTDI/PL2303）时，仍需用第 7 节的诊断脚本确认 `speed` 回读。
2. `reset` 在 POSIX 上是**尽力而为**：关 fd 触发 DTR 落下（`hupcl`）后重开，能复位多数 ESP32；
   需要 RTS 脉冲的自复位电路可能仍要用板载按钮或 `esptool --before default_reset`。
3. Linux 需要用户在 `dialout` 组：`sudo usermod -aG dialout $USER`，重新登录。
4. 数据位/停止位在 Windows 分支已支持全部组合（含 Mark/Space、1.5 停止位需 5 数据位）；
   POSIX 只支持 None/Even/Odd 与 1/2 停止位（`stty` 能力限制）。
5. 插件安装是「先移除再安装」，没有版本升级命令。
6. 右侧面板只在**本会话的对话页**显示；其它会话、其它页面不显示（这是刻意设计）。
7. 面板可停靠的最小宽度 176 px，窗口更窄时自动隐藏并在串口页提示。
8. 日志着色规则只存在当前浏览器（`localStorage`），没有导出/导入，也不随会话同步；
   自定义色是字面量，不跟随明暗主题（级别色跟随）。
9. 级别识别依赖 ESP-IDF 的 `L (timestamp)` 行首格式；其它日志风格只能靠自定义
   识别词整行着色。

---

## 10. 迁移包内容

`dsh-serial-console-handoff-0.3.1.zip` 内含：

```
serial-console/            源码工作树（不含 .git、node_modules）
serial-console.bundle      git bundle（含全部分支/标签，可离线 clone）
HANDOFF.md                 本文
mac-serial-check.sh        Mac 一键诊断脚本（第 7 节的命令封装）
```

离线恢复仓库：

```sh
git clone serial-console.bundle dsh-serial-console
cd dsh-serial-console && git tag      # 应能看到 v0.2.2 … v0.4.0
```
