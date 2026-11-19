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

const PARITY_TOKENS = {
  none: ['-parenb'],
  even: ['parenb', '-parodd'],
  odd: ['parenb', 'parodd'],
}

const STOP_TOKENS = {
  one: ['-cstopb'],
  two: ['cstopb'],
  onepointfive: ['cstopb'],
}

const PARITY_LETTER = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }
const STOP_LETTER = { one: '1', two: '2', onepointfive: '1.5' }

/**
 * Translate the plugin's line options into `stty` settings.
 *
 * The speed is expressed three ways on purpose: a bare operand means "both
 * speeds" to GNU stty, while BSD stty (macOS) is happier with explicit
 * `ispeed`/`ospeed`. USB bridges need the input speed set as well, and a stale
 * input speed is exactly what turns a correctly-bauded stream into garbage.
 */
export function buildLineConfig(config) {
  const input = config || {}
  const baudRate = Number(input.baudRate) > 0 ? Math.floor(Number(input.baudRate)) : 115200
  const dataBits = Number(input.dataBits) > 0 ? Math.floor(Number(input.dataBits)) : 8
  if (dataBits < 5 || dataBits > 8) throw new Error('dataBits must be 5 to 8')
  const parity = String(input.parity || 'None').toLowerCase()
  const stopBits = String(input.stopBits || 'One').toLowerCase()
  const parityTokens = PARITY_TOKENS[parity]
  if (!parityTokens) {
    throw new Error(`${input.parity} parity is not supported on this platform (use None, Even or Odd)`)
  }
  const stopTokens = STOP_TOKENS[stopBits]
  if (!stopTokens) throw new Error(`${input.stopBits} stop bits are not supported (use 1 or 2)`)
  if (stopBits === 'onepointfive' && dataBits !== 5) {
    throw new Error('1.5 stop bits need 5 data bits; pick 1 or 2 stop bits instead')
  }

  const speed = String(baudRate)
  const tokens = [
    speed,
    'ispeed',
    speed,
    'ospeed',
    speed,
    'raw',
    '-ignbrk',
    '-brkint',
    '-parmrk',
    '-echo',
    '-echoe',
    '-echok',
    '-echonl',
    '-iexten',
    '-ixon',
    '-ixoff',
    '-istrip',
    '-inlcr',
    '-igncr',
    '-icrnl',
    '-opost',
    '-isig',
    '-icanon',
    '-crtscts',
    'clocal',
    'hupcl',
    `cs${dataBits}`,
    ...parityTokens,
    ...stopTokens,
    'min',
    '1',
    'time',
    '0',
  ]
  const label = `${baudRate} ${dataBits}${PARITY_LETTER[parity] || 'N'}${STOP_LETTER[stopBits] || '1'}`
  return { baudRate, dataBits, parity, stopBits, tokens, label }
}

/** Read back what the driver really accepted (`stty -a`). */
export function parseSttyShow(text) {
  const out = { speed: null, dataBits: null, parenb: false, parodd: false, cstopb: false }
  const speed = /speed\s+(\d+)/.exec(text)
  if (speed) out.speed = Number(speed[1])
  const bits = /(?:^|[\s;])cs([5-8])(?=$|[\s;])/.exec(text)
  if (bits) out.dataBits = Number(bits[1])
  out.parenb = /(?:^|[\s;])parenb(?=$|[\s;])/.test(text)
  out.parodd = /(?:^|[\s;])parodd(?=$|[\s;])/.test(text)
  out.cstopb = /(?:^|[\s;])cstopb(?=$|[\s;])/.test(text)
  return out
}

function sttyFlag() {
  // macOS: stty -f /dev/x; Linux: stty -F /dev/x
  return DARWIN ? '-f' : '-F'
}

function sttyArgs(device, tokens) {
  const args = [sttyFlag(), device]
  if (Array.isArray(tokens)) args.push(...tokens)
  return args
}

/** Run stty once and resolve with {ok, out}. Never throws. */
function runStty(device, tokens) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('stty', sttyArgs(device, tokens), { stdio: ['ignore', 'pipe', 'pipe'] })
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

/** Does the driver's read-back match the requested frame? */
function frameMatches(readback, line) {
  const wantParity = line.parity !== 'none'
  const wantParodd = line.parity === 'odd'
  const wantStop2 = line.stopBits !== 'one'
  if (readback.parenb !== wantParity) return false
  if (wantParity && readback.parodd !== wantParodd) return false
  return readback.cstopb === wantStop2
}

/**
 * Apply the line settings and prove the driver accepted them.
 *
 * `stty` can exit 0 while leaving the input speed untouched, which shows up as
 * correctly-bauded output rendering as garbage. The read-back check catches
 * that and retries with the explicit speed operands before giving up with the
 * driver's own words.
 */
async function configureLine(device, config, emitNote) {
  const line = buildLineConfig(config)
  let first = await runStty(device, line.tokens)
  const show = await runStty(device, ['-a'])
  if (!show.ok) {
    const missing = /ENOENT|not found|command not found/i.test(`${first.out} ${show.out}`)
    if (first.ok) {
      emitNote(`line: ${line.label} on ${device} (stty cannot read the settings back)`)
      return line
    }
    if (missing) {
      emitNote(`stty unavailable, using the device settings as-is (${device})`)
      return line
    }
    throw new Error(`cannot configure ${device}: ${first.out || 'stty failed'}`)
  }

  let readback = parseSttyShow(show.out)

  // Some stty builds reject individual keywords (a missing `ispeed`, an
  // unknown flag). Fall back to the narrow set every POSIX stty understands
  // before giving up, so an exotic platform still gets a usable line.
  if (!first.ok && /invalid|unknown|illegal|not supported|usage/i.test(first.out)) {
    const minimal = [
      String(line.baudRate),
      'raw',
      '-echo',
      '-ixon',
      '-crtscts',
      'clocal',
      'hupcl',
      `cs${line.dataBits}`,
      ...PARITY_TOKENS[line.parity],
      ...STOP_TOKENS[line.stopBits],
    ]
    const minimalRun = await runStty(device, minimal)
    const minimalShow = await runStty(device, ['-a'])
    if (minimalShow.ok) readback = parseSttyShow(minimalShow.out)
    const speedOk = readback.speed === null || readback.speed === line.baudRate
    if (minimalRun.ok && speedOk) {
      emitNote(`line: ${line.label} on ${device} (minimal stty set)`)
      return line
    }
    first = minimalRun
  }

  const speedOk = readback.speed === null || readback.speed === line.baudRate
  const bitsOk = readback.dataBits === null || readback.dataBits === line.dataBits
  if (first.ok && speedOk && bitsOk && frameMatches(readback, line)) {
    emitNote(`line: ${line.label} on ${device}`)
    return line
  }

  // Retry without the bare speed operand: some BSD stty builds only honour the
  // explicit ispeed/ospeed pair for USB bridges.
  const retryTokens = ['ispeed', String(line.baudRate), 'ospeed', String(line.baudRate), ...line.tokens.slice(5)]
  const retry = await runStty(device, retryTokens)
  const second = await runStty(device, ['-a'])
  if (!second.ok) throw new Error(`cannot configure ${device}: ${retry.out || 'stty failed'}`)
  const final = parseSttyShow(second.out)
  const ok =
    (final.speed === null || final.speed === line.baudRate) &&
    (final.dataBits === null || final.dataBits === line.dataBits) &&
    frameMatches(final, line)
  if (!ok) {
    throw new Error(
      `cannot set ${line.label} on ${device}: stty reports speed ${final.speed === null ? '?' : final.speed}, ` +
        `${final.dataBits === null ? '?' : final.dataBits} data bits, parity ${final.parenb ? (final.parodd ? 'odd' : 'even') : 'off'}, ` +
        `${final.cstopb ? 2 : 1} stop bit(s) (${retry.out || show.out || 'no detail'})`,
    )
  }
  emitNote(`line: ${line.label} on ${device}`)
  return line
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

    const stty = await configureLine(device, config, emitNote)

    let handle
    try {
      handle = await openFile(device, FS.O_RDWR | FS.O_NOCTTY | FS.O_NONBLOCK)
    } catch (error) {
      throw new Error(`cannot open ${device}: ${describeError(error)}`)
    }

    state.handle = handle
    state.fd = typeof handle.fd === 'number' ? handle.fd : null
    state.device = device
    state.config = { ...config, port: device, line: stty.label }
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
