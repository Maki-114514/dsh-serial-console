/**
 * dsh-serial-console — host half.
 *
 * A Cordis plugin loaded as an out-of-tree bundle row (see cordis.patch.yml)
 * that lets the agent and the web GUI drive one serial (COM) port: list the
 * ports, open one, stream its output, and write bytes back.
 *
 * Responsibilities:
 *   1. Own the serial transport, on every desktop platform:
 *        - Windows: a dedicated PowerShell process (serial-host.ps1) that this
 *          module spawns once and talks to over a line protocol on
 *          stdin/stdout. Every payload is base64 so the pipe never depends on
 *          a console code page. That process uses System.IO.Ports, which also
 *          gives friendly device names and DTR/RTS control.
 *        - Linux and macOS: posix-serial.js opens the device node directly
 *          (stty for line settings, fs read/write on a non-blocking fd).
 *      The platform is detected once at load; both transports expose the same
 *      list/open/write/close/reset surface, so everything downstream is
 *      platform agnostic.
 *   2. Keep the received bytes in one bounded ring buffer addressed by opaque
 *      byte cursors, so a caller can ask for "everything after N" without
 *      racing the stream.
 *   3. Serve that state over same-origin loopback HTTP routes the browser half
 *      fetches directly, and expose the same operations as one model-visible
 *      tool (`serial`). Both callers go through the same functions, so the
 *      tool and the panel can never disagree about the port state.
 *
 * The port is a single global resource: one open port per host process, shared
 * by every session view and every tool call.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPosixSerial } from './posix-serial.js'

const API = '/serial-console/api'
const NS = 'serialConsole'
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, 'serial-host.ps1')

/** Received text kept per host process. Older bytes are dropped. */
const MAX_BUFFER_CHARS = 256 * 1024
/** Longest `read` wait a tool call may request. */
const MAX_WAIT_MS = 15000
const READY_TIMEOUT_MS = 20000
const WINDOWS = process.platform === 'win32'
/** Human-readable transport name, surfaced in status output. */
const TRANSPORT = WINDOWS ? 'powershell' : 'posix'

/** Services this plugin needs before `apply` runs. */
export const inject = ['webServer', 'tools']

const DEFAULT_OPEN = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'None',
  stopBits: 'One',
  dtrEnable: true,
  rtsEnable: true,
}

// ── received-byte ring buffer ────────────────────────────────────────────────
// Cursors are opaque byte counts over the decoded text, not device offsets.
const pump = { chunks: [], total: 0, generation: 0 }

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[@-Z\\-_]/g

function appendText(text) {
  if (!text) return
  const clean = text.replace(ANSI, '').replace(/\u0000/g, '')
  if (!clean) return
  const start = pump.total
  const end = start + Buffer.byteLength(clean, 'utf8')
  pump.chunks.push({ start, end, text: clean })
  pump.total = end
  let dropped = 0
  while (pump.chunks.length > 1 && pump.total - pump.chunks[0].start > MAX_BUFFER_CHARS) {
    pump.chunks.shift()
    dropped += 1
  }
  if (dropped > 0) pump.dropped = true
}

function readSince(since) {
  const first = pump.chunks[0]
  let from = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0
  let truncated = false
  if (first && from < first.start) {
    truncated = true
    from = first.start
  }
  if (from > pump.total) from = pump.total
  const picked = []
  for (let i = pump.chunks.length - 1; i >= 0; i -= 1) {
    const chunk = pump.chunks[i]
    if (chunk.end <= from) break
    if (chunk.start >= from) picked.push(chunk)
  }
  picked.reverse()
  const to = picked.length > 0 ? picked[picked.length - 1].end : from
  return { from, to, text: picked.map((chunk) => chunk.text).join(''), truncated }
}

function clearBuffer() {
  pump.chunks = []
  pump.generation += 1
}

// ── bridge process ───────────────────────────────────────────────────────────
/**
 * Last presence report sent by the browser half (piggybacked on the status
 * poll). `chat` counts probes that live inside Chat page rows, so it is only
 * positive while a Chat view is the one being displayed.
 */
const ui = { at: 0, chat: 0, dock: 0, ids: [], signature: '', history: [], geo: null }

// Order of the system-prompt section that advertises this tool; 0 = not registered.
const promptHint = { order: 0 }

function readGeoReport(raw) {
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const geo = {}
  for (const key of ['left', 'right', 'top', 'bottom', 'width', 'height', 'viewportW', 'viewportH', 'reserve']) {
    const value = Number(parsed[key])
    if (Number.isFinite(value)) geo[key] = Math.round(value)
  }
  return Object.keys(geo).length > 0 ? geo : null
}

function readUiReport(raw) {
  if (!raw) return
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const chat = Number(parsed.chat) || 0
  const dock = Number(parsed.dock) || 0
  const ids = Array.isArray(parsed.ids) ? parsed.ids.map((value) => String(value)) : []
  const geo = readGeoReport(parsed.geo)
  const signature = `${chat}/${dock}/${ids.join(',')}`
  ui.at = Date.now()
  ui.chat = chat
  ui.dock = dock
  ui.ids = ids
  if (geo) ui.geo = geo
  if (signature === ui.signature) return
  ui.signature = signature
  ui.history.push({ at: ui.at, chat, dock, ids: ids.slice() })
  if (ui.history.length > 24) ui.history.splice(0, ui.history.length - 24)
}

const bridge = {
  child: null,
  ready: false,
  pid: 0,
  seq: 0,
  waiters: new Map(),
  out: '',
  lastError: '',
  starting: null,
  restarts: 0,
  decoder: new TextDecoder('utf-8', { fatal: false }),
  carryCR: false,
  disposed: false,
}

const connection = {
  state: 'closed',
  port: '',
  baudRate: DEFAULT_OPEN.baudRate,
  dataBits: DEFAULT_OPEN.dataBits,
  parity: DEFAULT_OPEN.parity,
  stopBits: DEFAULT_OPEN.stopBits,
  openedAt: 0,
  error: '',
  writes: 0,
  bytesOut: 0,
  // Session that most recently drove this port; the Chat page of that session
  // is the only place the live drawer is allowed to appear.
  ownerSession: '',
  ownerAt: 0,
}

const ports = { at: 0, list: [] }

function send(line) {
  const child = bridge.child
  if (!child || !child.stdin || child.stdin.destroyed) throw new Error('serial bridge is not running')
  child.stdin.write(line + '\n')
}

function settleAll(error) {
  for (const waiter of bridge.waiters.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
  bridge.waiters.clear()
}

function request(command, { need = 1, timeoutMs = 5000 } = {}) {
  const id = String(++bridge.seq)
  return new Promise((resolve, reject) => {
    const waiter = { id, need, values: [], resolve, reject, timer: null, done: false }
    waiter.timer = setTimeout(() => {
      if (waiter.done) return
      waiter.done = true
      bridge.waiters.delete(id)
      if (waiter.values.length >= 1) resolve(waiter.values[waiter.values.length - 1])
      else reject(new Error(`${command.split(' ')[0].toLowerCase()} timed out`))
    }, timeoutMs)
    bridge.waiters.set(id, waiter)
    try {
      send(command.replace('{id}', id))
    } catch (error) {
      clearTimeout(waiter.timer)
      waiter.done = true
      bridge.waiters.delete(id)
      reject(error)
    }
  })
}

function finishWaiter(waiter, value) {
  waiter.values.push(value)
  if (waiter.values.length < waiter.need) return
  if (waiter.done) return
  waiter.done = true
  clearTimeout(waiter.timer)
  bridge.waiters.delete(waiter.id)
  waiter.resolve(waiter.values[waiter.values.length - 1])
}

function decodeB64(value) {
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function note(text) {
  appendText(`\n[session] ${text}\n`)
}

/**
 * Decode one chunk of device output. Streaming UTF-8 so a multi-byte character
 * is never split, and a trailing CR is held back so "\r\n" split across two
 * chunks still normalizes to one newline.
 */
function pushBytes(bytes) {
  let text = bridge.decoder.decode(bytes, { stream: true })
  if (bridge.carryCR) {
    text = '\r' + text
    bridge.carryCR = false
  }
  if (text.endsWith('\r')) {
    bridge.carryCR = true
    text = text.slice(0, -1)
  }
  appendText(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
}

/** POSIX transport (Linux/macOS); null on Windows, where the bridge is used. */
const posix = WINDOWS ? null : createPosixSerial({ onBytes: pushBytes, onNote: note })

function handleLine(raw) {
  const line = raw.replace(/\r$/, '')
  if (!line) return
  const firstSpace = line.indexOf(' ')
  const kind = firstSpace < 0 ? line : line.slice(0, firstSpace)
  const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1)

  if (kind === 'READY') {
    bridge.ready = true
    return
  }

  if (kind === 'DATA') {
    pushBytes(Buffer.from(rest.trim(), 'base64'))
    return
  }

  if (kind === 'NOTE') {
    note(decodeB64(rest.trim()))
    return
  }

  if (kind === 'CLOSED') {
    const id = rest.trim()
    connection.state = 'closed'
    connection.port = ''
    if (id && id !== '-') {
      const waiter = bridge.waiters.get(id)
      if (waiter) finishWaiter(waiter, { ok: true })
    } else {
      note('port closed')
    }
    return
  }

  if (kind === 'ERR') {
    const space = rest.indexOf(' ')
    const id = space < 0 ? rest.trim() : rest.slice(0, space).trim()
    const message = decodeB64(space < 0 ? '' : rest.slice(space + 1).trim()) || 'serial bridge error'
    let delivered = false
    if (id && id !== '-') {
      const waiter = bridge.waiters.get(id)
      if (waiter && !waiter.done) {
        waiter.done = true
        clearTimeout(waiter.timer)
        bridge.waiters.delete(id)
        waiter.reject(new Error(message))
        delivered = true
      }
    }
    connection.error = message
    if (!delivered) note(message)
    return
  }

  // Remaining replies are "<id> [payload]".
  const space = rest.indexOf(' ')
  const id = space < 0 ? rest.trim() : rest.slice(0, space).trim()
  const payload = space < 0 ? '' : rest.slice(space + 1).trim()
  const waiter = bridge.waiters.get(id)
  if (!waiter || waiter.done) return

  if (kind === 'PORTS') {
    const list = JSON.parse(decodeB64(payload) || '[]')
    if (Array.isArray(list)) {
      ports.list = list
      ports.at = Date.now()
    }
    finishWaiter(waiter, { ports: ports.list })
    return
  }

  if (kind === 'OPENED') {
    finishWaiter(waiter, { ok: true })
    return
  }

  finishWaiter(waiter, { ok: true })
}

function onStdout(chunk) {
  bridge.out += chunk
  let index = bridge.out.indexOf('\n')
  while (index >= 0) {
    const line = bridge.out.slice(0, index)
    bridge.out = bridge.out.slice(index + 1)
    try {
      handleLine(line)
    } catch {
      /* a malformed line must never kill the pipe */
    }
    index = bridge.out.indexOf('\n')
  }
  if (bridge.out.length > 65536) bridge.out = ''
}

function stopBridge() {
  const child = bridge.child
  bridge.child = null
  bridge.ready = false
  bridge.pid = 0
  bridge.out = ''
  settleAll(new Error('serial bridge stopped'))
  if (!child) return
  try {
    child.stdin.write('EXIT\n')
  } catch {
    /* already gone */
  }
  try {
    child.stdin.end()
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }, 1000)
  if (typeof timer.unref === 'function') timer.unref()
}

function startBridge() {
  if (bridge.disposed) return Promise.reject(new Error('serial bridge is disposed'))
  if (!WINDOWS) {
    // Linux/macOS drive the device node in-process instead of a bridge.
    bridge.ready = true
    return Promise.resolve()
  }
  if (!existsSync(SCRIPT_PATH)) {
    return Promise.reject(new Error(`serial bridge script is missing: ${SCRIPT_PATH}`))
  }

  const powershell = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const file = existsSync(powershell) ? powershell : 'powershell.exe'

  let child
  try {
    child = spawn(file, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    return Promise.reject(error)
  }

  bridge.child = child
  bridge.ready = false
  bridge.pid = child.pid || 0
  bridge.out = ''
  bridge.decoder = new TextDecoder('utf-8', { fatal: false })
  bridge.carryCR = false

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', onStdout)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    bridge.lastError = String(chunk).trim().slice(0, 400)
  })
  child.on('error', (error) => {
    bridge.lastError = error.message
    bridge.ready = false
    settleAll(error)
  })
  child.on('exit', (code) => {
    const wasReady = bridge.ready
    bridge.ready = false
    if (bridge.child === child) bridge.child = null
    settleAll(new Error(`serial bridge exited (code ${code})`))
    if (connection.state === 'open') {
      connection.state = 'closed'
      connection.error = 'serial bridge exited'
      note('serial bridge exited, port closed')
    }
    if (wasReady) bridge.restarts += 1
  })

  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (bridge.ready) {
        clearInterval(timer)
        resolve()
        return
      }
      if (!bridge.child) {
        clearInterval(timer)
        reject(new Error(bridge.lastError || 'serial bridge failed to start'))
        return
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        clearInterval(timer)
        reject(new Error('serial bridge did not become ready in time'))
      }
    }, 50)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function ensureBridge() {
  if (!WINDOWS) return Promise.resolve()
  if (bridge.ready && bridge.child) return Promise.resolve()
  if (bridge.starting) return bridge.starting
  bridge.starting = startBridge().finally(() => {
    bridge.starting = null
  })
  return bridge.starting
}

// ── operations shared by the tool and the HTTP routes ────────────────────────
async function listPorts() {
  if (!WINDOWS) {
    const list = await posix.list()
    ports.list = list
    ports.at = Date.now()
    return list
  }
  await ensureBridge()
  const reply = await request('PORTS {id}', { need: 2, timeoutMs: 20000 })
  return reply.ports || ports.list
}

/**
 * Repair the harmless shapes a port arrives in before it is validated.
 *
 * The panel lists an option as `<port> — <label>`, so a copied option or a tool
 * argument that echoes it carries the label too; Windows also accepts the
 * `\\.\COM3` device form, and a bare device name (`cu.usbserial-110`,
 * `ttyUSB0`) is unambiguous on POSIX.
 */
function normalizePort(raw) {
  // Zero-width characters survive a copy/paste and make a correct path unusable.
  let value = String(raw || '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .trim()
  const labelled = value.indexOf(' — ')
  if (labelled > 0) value = value.slice(0, labelled).trim()
  if (value.startsWith('\\\\.\\')) value = value.slice(4).trim()
  if (!WINDOWS && !value.startsWith('/dev/') && /^(?:cu\.[\w.-]+|tty(?:USB|ACM|AMA|XRUSB)\d+|rfcomm\d+)$/.test(value)) {
    value = `/dev/${value}`
  }
  return value
}

async function openPort(options = {}) {
  const raw = normalizePort(options.port)
  if (WINDOWS) {
    if (!/^COM\d+$/i.test(raw)) throw new Error(`port must look like COM3 (got ${JSON.stringify(raw)})`)
  } else if (!raw.startsWith('/dev/')) {
    // Show the received string verbatim: a case-mangled or truncated path is a
    // common cause and is invisible when the value is only implied.
    throw new Error(
      `port must be a device path such as /dev/ttyUSB0 or /dev/cu.usbserial-1420 (got ${JSON.stringify(raw)})`,
    )
  }
  const baudRate = Number(options.baudRate) > 0 ? Math.floor(Number(options.baudRate)) : DEFAULT_OPEN.baudRate
  if (baudRate < 50 || baudRate > 4000000) throw new Error('baudRate is out of range')
  const parity = String(options.parity || DEFAULT_OPEN.parity)
  const stopBits = String(options.stopBits || DEFAULT_OPEN.stopBits)
  const dataBits = Number(options.dataBits) > 0 ? Math.floor(Number(options.dataBits)) : DEFAULT_OPEN.dataBits
  const config = {
    // Windows device names are case-insensitive upper-case COMx; POSIX paths are literal.
    port: WINDOWS ? raw.toUpperCase() : raw,
    baudRate,
    dataBits,
    parity,
    stopBits,
    dtrEnable: options.dtrEnable === undefined ? DEFAULT_OPEN.dtrEnable : Boolean(options.dtrEnable),
    rtsEnable: options.rtsEnable === undefined ? DEFAULT_OPEN.rtsEnable : Boolean(options.rtsEnable),
  }

  await ensureBridge()
  connection.error = ''
  try {
    if (WINDOWS) {
      await request(`OPEN {id} ${Buffer.from(JSON.stringify(config), 'utf8').toString('base64')}`, {
        timeoutMs: 15000,
      })
    } else {
      await posix.open(config)
    }
  } catch (error) {
    connection.state = 'closed'
    connection.port = ''
    const friendly = describePortFailure(config.port, error && error.message)
    connection.error = friendly
    throw new Error(friendly)
  }
  Object.assign(connection, config, {
    state: 'open',
    openedAt: Date.now(),
    ownerSession: String(options.session || ''),
    ownerAt: Date.now(),
  })
  note(`${config.port} open at ${config.baudRate} baud`)
  return { ...connection }
}

async function closePort() {
  if (connection.state !== 'open') {
    connection.state = 'closed'
    connection.port = ''
    return { ok: true, state: 'closed' }
  }
  const port = connection.port
  if (WINDOWS) {
    await ensureBridge().catch(() => {})
    if (bridge.ready) {
      try {
        await request('CLOSE {id}', { timeoutMs: 5000 })
      } catch {
        /* the port is closed locally either way */
      }
    }
  } else {
    await posix.close().catch(() => {})
  }
  connection.state = 'closed'
  connection.port = ''
  connection.error = ''
  note(`${port} closed`)
  return { ok: true, state: 'closed' }
}

const ENDINGS = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' }

async function writeText(text, ending = 'none', session = '') {
  const body = String(text ?? '')
  if (connection.state !== 'open') throw new Error('no serial port is open')
  if (session) {
    connection.ownerSession = String(session)
    connection.ownerAt = Date.now()
  }
  const suffix = ENDINGS[String(ending)] ?? ''
  const payload = Buffer.from(body + suffix, 'utf8')
  if (payload.length === 0) return { ok: true, bytes: 0 }
  if (WINDOWS) {
    await ensureBridge()
    await request(`WRITE {id} ${payload.toString('base64')}`, { timeoutMs: 5000 })
  } else {
    try {
      await posix.write(payload)
    } catch (error) {
      connection.error = String(error && error.message)
      throw error
    }
  }
  connection.writes += 1
  connection.bytesOut += payload.length
  return { ok: true, bytes: payload.length }
}

async function resetTarget() {
  if (connection.state !== 'open') throw new Error('no serial port is open')
  if (WINDOWS) {
    await ensureBridge()
    await request('RESET {id}', { timeoutMs: 5000 })
  } else {
    await posix.reset()
  }
  note('reset pulse sent')
  return { ok: true }
}

function snapshot({ since = 0, includeText = true } = {}) {
  const slice = includeText ? readSince(since) : { from: since, to: pump.total, text: '', truncated: false }
  return {
    ok: true,
    platform: process.platform,
    supported: true,
    transport: TRANSPORT,
    bridge: {
      ready: WINDOWS ? bridge.ready : true,
      pid: WINDOWS ? bridge.pid : 0,
      restarts: WINDOWS ? bridge.restarts : 0,
      lastError: WINDOWS ? bridge.lastError : '',
    },
    connection: { ...connection },
    ui: {
      at: ui.at,
      chat: ui.chat,
      dock: ui.dock,
      ids: ui.ids.slice(),
      history: ui.history.slice(-6),
      geo: ui.geo,
    },
    promptSection: promptHint.order,
    ports: ports.list,
    portsAt: ports.at,
    buffer: {
      total: pump.total,
      generation: pump.generation,
      from: slice.from,
      to: slice.to,
      truncated: slice.truncated,
      text: slice.text,
    },
  }
}

function waitForData(since, waitMs) {
  const deadline = Date.now() + Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0))
  return new Promise((resolve) => {
    const tick = () => {
      if (pump.total > since || Date.now() >= deadline) {
        resolve(snapshot({ since }))
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

// ── HTTP routes ──────────────────────────────────────────────────────────────
function isSameOrigin(req, webServer) {
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (!origin) return true
  let from
  try {
    from = new URL(origin)
  } catch {
    return false
  }
  if (from.protocol !== 'http:') return false
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(from.hostname)) return false
  let expected = Number(webServer.port) || 0
  if (!expected) {
    try {
      expected = Number(new URL(webServer.getOrigin()).port) || 0
    } catch {
      expected = 0
    }
  }
  // Fall back to loopback-only when the server port cannot be resolved.
  return expected === 0 || Number(from.port || 80) === expected
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Register everything this plugin contributes.
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  const disposers = []

  ctx.effect(() => {
    const webServer = ctx.webServer
    // A disable/enable cycle reuses this module instance: drop whatever the
    // previous mount left behind so the bridge starts clean.
    bridge.disposed = false
    bridge.ready = false
    connection.state = 'closed'
    connection.port = ''
    connection.error = ''

    const route = (kind, path, handler) => {
      disposers.push(
        webServer.register({
          kind,
          path: `${API}${path}`,
          handler: (req, res) => {
            if (!isSameOrigin(req, webServer)) {
              sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
              return
            }
            Promise.resolve(handler(req, res)).catch((error) => {
              if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message })
            })
          },
        }),
      )
    }

    route('exact', '/status', async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      const since = Number(url.searchParams.get('since') || 0)
      readUiReport(url.searchParams.get('ui'))
      sendJson(res, 200, snapshot({ since }))
    })

    route('exact', '/ports', async (req, res) => {
      const list = await listPorts()
      sendJson(res, 200, { ok: true, ports: list, at: ports.at })
    })

    route('exact', '/open', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readBody(req)
      const result = await openPort(body)
      sendJson(res, 200, { ok: true, connection: result })
    })

    route('exact', '/close', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, await closePort())
    })

    route('exact', '/write', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readBody(req)
      sendJson(res, 200, await writeText(body.text, body.ending, body.session))
    })

    route('exact', '/reset', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, await resetTarget())
    })

    route('exact', '/clear', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      clearBuffer()
      sendJson(res, 200, { ok: true, generation: pump.generation, total: pump.total })
    })

    // Make every conversation on this Host aware the tool exists, so agents reach
    // for it instead of spawning idf.py monitor or a separate capture script.
    const systemPrompt = ctx.get('systemPrompt')
    promptHint.order = 0
    if (systemPrompt) {
      ctx.effect(() => {
        const text = [
          '## Serial console',
          'A `serial` tool drives a serial port on this machine (Windows, Linux and macOS). When a task',
          'involves program or firmware output on a serial port, use it instead of an external monitor',
          'or a separate capture script: action="list_ports" lists ports, action="open" takes port ("COM6"',
          'on Windows, "/dev/ttyUSB0" or "/dev/cu.usbserial-1420" on Linux/macOS) and baudRate (default',
          '115200), action="read" takes waitMs (max 15000) to block for output and the returned cursor',
          'goes back in as "since" to follow it, action="reset" reboots an ESP32-class board so the next',
          'read captures the boot log, action="write" sends text, action="close" frees the port for other',
          'tools. The same stream shows up live in the Serial view and in the session panel on the right.',
        ].join(' ')
        for (const order of [880, 881, 882, 883, 884]) {
          try {
            const dispose = systemPrompt.section({ name: 'serial-console', order, text })
            promptHint.order = order
            return dispose
          } catch {
            // Order already owned by another section: try the next free slot.
          }
        }
        return () => {}
      })
    }

    disposers.push(
      ctx.tools.register({
        name: 'serial',
        description: [
          'Read and drive a serial port on the user machine — the console the firmware or program',
          'under development writes to. Use it to watch program output live and to send input back.',
          'Works on Windows (COM ports), Linux and macOS (/dev device paths). One port at a time,',
          'shared with the Serial view in the DSH GUI.',
          '',
          'Workflow: action=list_ports to see what is attached, action=open with a port ("COM6" on',
          'Windows, "/dev/ttyUSB0" or "/dev/cu.usbserial-1420" on Linux/macOS; baudRate defaults to',
          '115200), then action=read — pass waitMs so the call blocks until the device says something',
          'instead of returning an empty result — and action=write to send text. action=reset pulses the',
          'reset line to reboot an ESP32-class board so the next read sees the boot log. Call',
          'action=close when finished so the port is free for other tools.',
        ].join(' '),
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['list_ports', 'open', 'close', 'read', 'write', 'status', 'reset', 'clear'],
            description: 'Operation to perform.',
          },
          port: {
            type: 'string',
            description:
              'Port for action=open: "COM6" on Windows, "/dev/ttyUSB0" (Linux) or "/dev/cu.usbserial-1420" (macOS). Pass the device path only, not the label shown next to it in the Serial view.',
          },
          baudRate: { type: 'number', description: 'Baud rate for action=open. Default 115200.' },
          parity: { type: 'string', description: 'None, Odd, Even, Mark or Space. Default None.' },
          dataBits: { type: 'number', description: 'Data bits for action=open. Default 8.' },
          stopBits: { type: 'string', description: 'One, Two, OnePointFive. Default One.' },
          text: { type: 'string', description: 'Text for action=write. Use "\\r\\n" yourself or pass ending.' },
          ending: {
            type: 'string',
            enum: ['none', 'cr', 'lf', 'crlf'],
            description: 'Line ending appended by action=write. Default none.',
          },
          since: {
            type: 'number',
            description: 'Cursor from a previous read; only newer output is returned. Omit for everything buffered.',
          },
          waitMs: {
            type: 'number',
            description: 'For action=read: block up to this many milliseconds (max 15000) waiting for new output.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              ok: { type: 'boolean' },
              error: { type: 'string' },
              text: { type: 'string' },
              cursor: { type: 'number' },
              truncated: { type: 'boolean' },
            },
          },
          render: (_args, value) => {
            const result = value && typeof value === 'object' ? value : {}
            const lines = []
            if (result.error) lines.push(`serial error: ${result.error}`)
            if (result.state) lines.push(`port ${result.port || '(none)'} is ${result.state}`)
            if (Array.isArray(result.ports)) {
              lines.push(
                result.ports.length === 0
                  ? 'no serial ports found'
                  : result.ports.map((item) => `${item.port}${item.label ? ` — ${item.label}` : ''}`).join('\n'),
              )
            }
            if (typeof result.text === 'string') {
              lines.push(result.text.length > 0 ? result.text : '(no new output)')
              if (result.truncated) lines.push('(older output was dropped from the buffer)')
              if (typeof result.cursor === 'number') lines.push(`cursor: ${result.cursor}`)
            }
            if (typeof result.bytes === 'number') lines.push(`buffer: ${result.bytes} byte(s)`)
            if (result.transport) lines.push(`transport: ${result.transport} (${result.platform || process.platform})`)
            if (result.owner !== undefined) lines.push(`drawer session: ${result.owner || '(none)'}`)
            if (result.promptSection !== undefined) {
              lines.push(
                result.promptSection > 0
                  ? `prompt hint: registered (order ${result.promptSection})`
                  : 'prompt hint: not registered',
              )
            }
            if (result.ui) {
              const seen = Array.isArray(result.ui.ids) && result.ui.ids.length > 0 ? result.ui.ids.join(', ') : '(none)'
              lines.push(`chat pages on screen: ${seen} (probes: chat ${result.ui.chat}, dock ${result.ui.dock})`)
              const history = Array.isArray(result.ui.history) ? result.ui.history.slice(-4) : []
              if (history.length > 0) {
                const trail = history.map((entry) => {
                  const clock = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false })
                  return `${clock} chat=${entry.chat} dock=${entry.dock}`
                })
                lines.push(`presence trail: ${trail.join(' | ')}`)
              }
              const geo = result.ui.geo
              if (geo && typeof geo === 'object') {
                lines.push(
                  `drawer dock: column=${geo.width}px from x=${geo.left} gap=${Math.max(0, Math.round((geo.viewportW || 0) - geo.right))}px reserve=${geo.reserve || 0}px`,
                )
              } else {
                lines.push('drawer dock: not measured yet')
              }
            }
            if (result.note) lines.push(result.note)
            return [{ type: 'text', text: lines.join('\n') || 'ok' }]
          },
        },
        async execute(args = {}, exec) {
          const action = String(args.action || '')
          const session = sessionOf(exec)
          try {
            switch (action) {
              case 'list_ports': {
                const list = await listPorts()
                return { ok: true, ports: list }
              }
              case 'open': {
                const result = await openPort({ ...args, session })
                return {
                  ok: true,
                  state: result.state,
                  port: result.port,
                  baudRate: result.baudRate,
                  note: `${result.port} is open at ${result.baudRate} baud — read with action=read.`,
                }
              }
              case 'close': {
                const result = await closePort()
                return { ok: true, state: result.state, note: 'serial port closed' }
              }
              case 'write': {
                const result = await writeText(args.text, args.ending || 'none', session)
                return { ok: true, note: `wrote ${result.bytes} byte(s)` }
              }
              case 'reset': {
                await resetTarget()
                return { ok: true, note: 'reset pulse sent; read the boot log with action=read and waitMs.' }
              }
              case 'clear': {
                clearBuffer()
                return { ok: true, note: 'buffer cleared' }
              }
              case 'status': {
                const state = snapshot({ includeText: false })
                return {
                  ok: true,
                  state: state.connection.state,
                  port: state.connection.port,
                  baudRate: state.connection.baudRate,
                  transport: state.transport,
                  platform: state.platform,
                  bytes: state.buffer.total,
                  owner: state.connection.ownerSession || '',
                  ui: state.ui,
                  promptSection: state.promptSection,
                  note: WINDOWS
                    ? state.bridge.ready
                      ? 'bridge ready'
                      : 'bridge not running'
                    : `posix transport (${process.platform})`,
                }
              }
              case 'read': {
                const since = Number.isFinite(args.since) ? Number(args.since) : pump.total
                const waitMs = Number.isFinite(args.waitMs) ? Number(args.waitMs) : 0
                if (session && connection.state === 'open') {
                  connection.ownerSession = session
                  connection.ownerAt = Date.now()
                }
                const state = waitMs > 0 ? await waitForData(since, waitMs) : snapshot({ since })
                return {
                  ok: true,
                  text: state.buffer.text,
                  cursor: state.buffer.to,
                  truncated: state.buffer.truncated,
                  state: state.connection.state,
                  port: state.connection.port,
                }
              }
              default:
                return { ok: false, error: `unknown action: ${action || '(none)'}` }
            }
          } catch (error) {
            return { ok: false, error: error.message }
          }
        },
      }),
    )

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
      bridge.disposed = true
      stopBridge()
      if (posix) posix.close().catch(() => {})
    }
  })
}

function sessionOf(exec) {
  const agent = exec && exec.agent
  const id = agent && agent.id
  return id ? String(id) : ''
}

function describePortFailure(port, message) {
  const text = String(message || '').trim()
  if (/denied|busy|拒绝访问|EBUSY|EACCES/i.test(text)) {
    return (
      port +
      ' is busy: another program is using it (close the serial monitor holding ' +
      port +
      ', then connect again)'
    )
  }
  if (/not exist|does not exist|no such file|ENOENT|找不到/i.test(text)) {
    return port + ' does not exist any more (refresh the port list)'
  }
  return text || 'could not open ' + port
}