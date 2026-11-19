/**
 * POSIX serial transport (Linux + macOS) for dsh-serial-console.
 *
 * Windows keeps its dedicated PowerShell bridge (serial-host.ps1) because it
 * can enumerate friendly device names and pulse DTR/RTS through
 * System.IO.Ports. On POSIX there is no such helper, so this module talks to
 * the device node directly:
 *
 *   - line settings are applied with `stty` (baud, 8N1, raw, no flow control)
 *   - bytes are read with fs.read() on an O_NONBLOCK descriptor and written
 *     with fs.write(), so no native module and no child process is needed at
 *     runtime beyond the one-shot `stty` call
 *   - enumeration reads /dev (macOS `cu.*`, Linux `ttyUSB*`/`ttyACM*`/...
 *     plus the stable /dev/serial/by-id links)
 *
 * DTR/RTS cannot be driven without ioctl: opening the device raises DTR, and
 * reset() does a best-effort pulse by closing the descriptor (which drops DTR
 * given HUPCL) and reopening it. Boards whose auto-reset needs an RTS pulse
 * may need the reset button or `esptool --before default_reset`.
 */

import { spawn } from 'node:child_process'
import { constants as FS } from 'node:fs'
import { open as openFile, readdir, realpath, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const READ_CHUNK = 8192
const IDLE_MS = 3
const WRITE_TIMEOUT_MS = 2000
const DARWIN = process.platform === 'darwin'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sttyFlag() {
  // macOS: stty -f /dev/x; Linux: stty -F /dev/x
  return DARWIN ? '-f' : '-F'
}

function sttyArgs(device, settings) {
  const args = [sttyFlag(), device]
  if (settings) {
    args.push(
      String(settings.baudRate),
      'raw',
      '-echo',
      '-echoe',
      '-echok',
      '-echonl',
      '-iexten',
      '-ixon',
      '-ixoff',
      '-crtscts',
      'cs8',
      '-cstopb',
      '-parenb',
      'clocal',
      'hupcl',
    )
  }
  return args
}

/** Run stty once and resolve with {ok, out}. Never throws. */
function runStty(device, settings) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('stty', sttyArgs(device, settings), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, out: String(error && error.message) })
      return
    }
    let out = ''
    const collect = (chunk) => {
      if (out.length < 4000) out += chunk
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => resolve({ ok: false, out: String(error && error.message) }))
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }))
  })
}

function describeError(error) {
  const code = error && error.code
  const message = String((error && error.message) || error)
  if (code === 'EACCES' || code === 'EPERM') return `permission denied opening the device (${message})`
  if (code === 'EBUSY') return `device is busy (${message})`
  if (code === 'ENOENT') return `device does not exist (${message})`
  if (code === 'EIO') return `device disappeared (${message})`
  return message
}

/**
 * Create one POSIX serial port controller.
 * `onBytes(buffer)` receives every chunk of raw device output.
 * `onNote(text)` receives human-readable session notes.
 */
export function createPosixSerial({ onBytes, onNote } = {}) {
  const state = {
    handle: null,
    fd: null,
    device: '',
    config: null,
    generation: 0,
    reading: false,
    closed: true,
    lastError: '',
  }

  const emitNote = (text) => {
    try {
      if (onNote) onNote(text)
    } catch {
      /* a note must never break the transport */
    }
  }

  const emitBytes = (buffer) => {
    try {
      if (onBytes) onBytes(buffer)
    } catch {
      /* ignore consumer failures */
    }
  }

  async function readLoop(generation) {
    const buffer = Buffer.allocUnsafe(READ_CHUNK)
    while (state.reading && generation === state.generation && state.handle !== null) {
      const handle = state.handle
      let bytes = 0
      try {
        const result = await handle.read(buffer, 0, READ_CHUNK, null)
        bytes = result.bytesRead
      } catch (error) {
        const code = error && error.code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          await sleep(IDLE_MS)
          continue
        }
        if (code === 'EBADF') return
        if (generation === state.generation) {
          state.lastError = describeError(error)
          emitNote(`port closed: ${state.device} (${state.lastError})`)
          await shutdown()
        }
        return
      }
      if (bytes > 0) {
        emitBytes(Buffer.from(buffer.subarray(0, bytes)))
        continue
      }
      await sleep(IDLE_MS)
    }
  }

  async function shutdown() {
    state.reading = false
    state.generation += 1
    const handle = state.handle
    state.handle = null
    state.fd = null
    state.closed = true
    state.device = ''
    state.config = null
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* already gone */
      }
    }
  }

  /** Enumerate candidate devices without touching the serial hardware. */
  async function list() {
    const found = new Map()
    const add = (port, label, detail) => {
      if (!port || found.has(port)) {
        if (port && found.has(port) && label && !found.get(port).label) found.get(port).label = label
        return
      }
      found.set(port, { port, label: label || '', detail: detail || '' })
    }

    if (DARWIN) {
      let names = []
      try {
        names = (await readdir('/dev')).filter((name) => name.startsWith('cu.'))
      } catch {
        names = []
      }
      names.sort()
      for (const name of names) add(`/dev/${name}`, name.replace(/^cu\./, ''), name)
      return [...found.values()]
    }

    // Linux: stable by-id links first, then plain device nodes.
    try {
      const links = await readdir('/dev/serial/by-id')
      for (const link of links.sort()) {
        const path = `/dev/serial/by-id/${link}`
        let target = ''
        try {
          target = await realpath(path)
        } catch {
          target = ''
        }
        if (target) add(target, link.replace(/^usb-/, ''), link)
      }
    } catch {
      /* no by-id tree */
    }

    let names = []
    try {
      names = (await readdir('/dev')).filter((name) => /^(ttyUSB|ttyACM|ttyAMA|ttyXRUSB|rfcomm)\d+$/.test(name))
    } catch {
      names = []
    }
    names.sort()
    for (const name of names) add(`/dev/${name}`, '', name)

    return [...found.values()].sort((a, b) => a.port.localeCompare(b.port))
  }

  async function open(config) {
    const device = String((config && config.port) || '').trim()
    if (!device.startsWith('/dev/')) throw new Error(`port must be a device path such as /dev/ttyUSB0 or /dev/cu.usbserial-1420 (got ${JSON.stringify(device)})`)
    if (!existsSync(device)) throw new Error(`${device} does not exist (refresh the port list)`)

    await shutdown()
    state.lastError = ''

    const stty = await runStty(device, config)
    if (!stty.ok) {
      // A missing stty is not fatal: the device may already be configured.
      const missing = /ENOENT|not found|command not found/i.test(stty.out)
      if (!missing) throw new Error(`cannot configure ${device}: ${stty.out || 'stty failed'}`)
      emitNote(`stty unavailable, using the device settings as-is (${device})`)
    }

    let handle
    try {
      handle = await openFile(device, FS.O_RDWR | FS.O_NOCTTY | FS.O_NONBLOCK)
    } catch (error) {
      throw new Error(`cannot open ${device}: ${describeError(error)}`)
    }

    state.handle = handle
    state.fd = typeof handle.fd === 'number' ? handle.fd : null
    state.device = device
    state.config = { ...config, port: device }
    state.closed = false
    state.reading = true
    state.generation += 1
    const generation = state.generation
    readLoop(generation).catch(() => {})

    let detail = ''
    try {
      const info = await stat(device)
      detail = `rdev ${info.rdev}`
    } catch {
      detail = ''
    }
    return { port: device, detail }
  }

  async function write(buffer) {
    if (state.handle === null) throw new Error('no serial port is open')
    const handle = state.handle
    let offset = 0
    const deadline = Date.now() + WRITE_TIMEOUT_MS
    while (offset < buffer.length) {
      try {
        const result = await handle.write(buffer, offset, buffer.length - offset, null)
        offset += result.bytesWritten
      } catch (error) {
        const code = error && error.code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          if (Date.now() > deadline) throw new Error('write timed out')
          await sleep(IDLE_MS)
          continue
        }
        throw new Error(`write failed: ${describeError(error)}`)
      }
    }
    return offset
  }

  async function close() {
    await shutdown()
  }

  /** Best-effort DTR pulse: drop it by closing, then bring the port back. */
  async function reset() {
    if (state.handle === null) throw new Error('no serial port is open')
    const config = state.config
    await shutdown()
    await sleep(180)
    if (!config) return
    await open(config)
  }

  return {
    list,
    open,
    write,
    close,
    reset,
    status: () => ({
      open: state.handle !== null,
      device: state.device,
      lastError: state.lastError,
      config: state.config ? { ...state.config } : null,
    }),
  }
}
