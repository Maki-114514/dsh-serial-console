# dsh-serial-console

A serial port console for the DSH web GUI: open a serial port, watch its output
live in the session View row, and let the agent read and drive the same port
through one model-visible tool.

Works on **Windows, Linux and macOS** from one bundle — the platform is detected
at load time and the matching transport is used.

Built for firmware work — flash an ESP32, reset it, and read the boot log
without leaving the conversation.

## What it adds

| Piece | Where |
| --- | --- |
| Host routes | `GET /serial-console/api/status?since=<cursor>`, `GET /serial-console/api/ports`, `POST /serial-console/api/{open,close,write,reset,clear}` |
| Agent tool | `serial` — `list_ports \| open \| close \| read \| write \| reset \| status \| clear` |
| Session view | a **Serial** tab in the conversation View row (`conversation.view` slot, id `serial`, order 25) |

Both callers go through the same host functions, so the tool and the panel can
never disagree about which port is open.

## How the port is driven

There is no serial npm package in the DSH host, so the transport is
platform-specific behind one small interface (`list/open/write/close/reset`):

### Windows — PowerShell bridge

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

### Linux and macOS — direct device node

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

### Shared decoding

The host decodes the byte stream with a streaming `TextDecoder`, strips ANSI
escapes, normalizes CR/CRLF to LF, and keeps the result in a 256 KiB ring buffer
addressed by **opaque byte cursors** — a caller asks for "everything after N" and
never races the stream. A cursor older than the buffer reports
`truncated: true`.

## Using the tool from a conversation

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

## Refresh behaviour

The browser half polls `/status` adaptively: 120 ms while the port is open, 16 ms
while data keeps arriving (so a burst is drained in one go), 900 ms when the port
is closed or the last request failed. Appends are coalesced into at most one
render per animation frame, log rows are memoized and keyed by a monotonic id (so
trimming the head no longer remounts the whole log), and the tab and the drawer
share one poller. Polling stops entirely while the page is hidden.

## Placement

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

## Limits

- One port per host process, shared by every session view and tool call.
- The ring buffer holds 256 KiB of text; older output is dropped.
- POSIX has no DTR/RTS control without a native module, so `reset` there is a
  best-effort DTR drop (see above).

## Install

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

## Layout

```
index.js          host half: transport dispatch, ring buffer, HTTP routes, `serial` tool
posix-serial.js   Linux/macOS transport: stty + fs read/write on the device node
client.js         browser half: the Serial view (module-loader bundle)
serial-host.ps1   the Windows PowerShell process that owns the serial port
cordis.patch.yml  bundle row inserted on install
locale/{en,zh}.json  display name and description
```
