/**
 * dsh-serial-console — browser half.
 *
 * Two surfaces share one data source:
 *  1. a "Serial" tab in the session View row (`conversation.view`),
 *  2. a right-side drawer in the frame overlay (`shell.overlay`) that appears
 *     whenever the port is open, so the agent's serial traffic stays visible
 *     next to the chat.
 *
 * All device state lives in the host half; this file only polls
 * `/serial-console/api/status` and calls the same operations the agent tool uses.
 */

window.__ModuleLoader__.load({
  id: 'dsh-serial-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'serialConsole'
    const API = '/serial-console/api'
    const POLL_OPEN_MS = 120
    const POLL_IDLE_MS = 900
    const POLL_DRAIN_MS = 16
    const POLL_ERROR_MS = 900
    const MAX_LOG_CHARS = 200000
    const MAX_DRAWER_ENTRIES = 240
    const DRAWER_KEY = 'dsh-serial-console.drawer'
    const PRESENCE_MS = 400
    // Dock geometry: the drawer sits inside the message scroller and the
    // scroller reserves the same width on its right, so no Chat text can end up
    // underneath the panel and the right document column is never covered.
    const EDGE_GAP = 8
    const RESERVE_PAD = 12
    const DRAWER_PREFERRED = 360
    const DRAWER_MIN = 200
    const RESERVE_MIN = 176
    const RESERVE_ATTR = 'data-serial-reserve'

    const EN = {
      'tab': 'Serial',
      'title': 'Serial console',
      'disconnected': 'Not connected',
      'connected': 'Connected',
      'bridgeDown': 'Serial bridge not running',
      'connect': 'Connect',
      'disconnect': 'Disconnect',
      'ports': 'Port',
      'refresh': 'Refresh ports',
      'baud': 'Baud',
      'dataBits': 'Bits',
      'parity': 'Parity',
      'stopBits': 'Stop',
      'parityNone': 'none',
      'parityEven': 'even',
      'parityOdd': 'odd',
      'stopOne': '1 bit',
      'stopTwo': '2 bits',
      'ending': 'Ending',
      'send': 'Send',
      'clear': 'Clear',
      'reset': 'Reset',
      'follow': 'Follow',
      'placeholder': 'Type text to send to the device',
      'inputLabel': 'Text to send',
      'noPorts': 'No serial ports detected. Attach a device, then refresh.',
      'empty': 'No output yet. Connect a port, then reset the device to capture its boot log.',
      'unsupported': 'Serial transport is not available on this platform.',
      'truncated': 'Older output was dropped from the host buffer.',
      'waiting': 'Working…',
      'port': 'port',
      'notConnectedHint': 'The agent can also drive this port with the serial tool.',
      'choosePort': 'Choose a port',
      'drawerTitle': 'Serial',
      'drawerHint': 'Live serial data while the agent drives this port.',
      'drawerEmpty': 'Waiting for data from the device.',
      'drawerToggle': 'Right panel',
      'on': 'On',
      'off': 'Off',
      'close': 'Close',
      'noRoom': 'Widen the window to dock the serial panel',
    }

    const ZH = {
      'tab': '串口',
      'title': '串口控制台',
      'disconnected': '未连接',
      'connected': '已连接',
      'bridgeDown': '串口桥未运行',
      'connect': '连接',
      'disconnect': '断开',
      'ports': '端口',
      'refresh': '刷新端口',
      'baud': '波特率',
      'dataBits': '数据位',
      'parity': '校验',
      'stopBits': '停止位',
      'parityNone': '无',
      'parityEven': '偶',
      'parityOdd': '奇',
      'stopOne': '1 位',
      'stopTwo': '2 位',
      'ending': '结尾符',
      'send': '发送',
      'clear': '清空',
      'reset': '复位',
      'follow': '跟随',
      'placeholder': '输入要发送到设备的内容',
      'inputLabel': '待发送内容',
      'noPorts': '没有检测到串口。接上设备后点刷新。',
      'empty': '还没有输出。连上串口后复位设备即可捕获启动日志。',
      'unsupported': '当前平台无法使用串口传输。',
      'truncated': '更早的输出已从宿主缓冲中丢弃。',
      'waiting': '处理中…',
      'port': '端口',
      'notConnectedHint': 'agent 也可以用 serial 工具直接操作这个串口。',
      'choosePort': '选择端口',
      'drawerTitle': '串口',
      'drawerHint': 'agent 正在操作这个串口，实时数据显示在下方。',
      'drawerEmpty': '等待设备数据…',
      'drawerToggle': '右侧面板',
      'on': '开',
      'off': '关',
      'close': '关闭',
      'noRoom': '窗口太窄，放不下右侧串口面板',
    }

    const CSS = `
.sc-root { box-sizing: border-box; display: flex; flex-direction: column; height: auto; min-height: 0; max-height: 100%; overflow: hidden; gap: 8px; padding: 10px 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
.sc-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 26px; }
.sc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: 0 0 auto; }
.sc-dot.is-on { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
.sc-dot.is-err { background: var(--dsw-alias-state-error-primary); }
.sc-title { font-weight: 600; }
.sc-muted { color: var(--dsw-alias-label-secondary); }
.sc-spacer { flex: 1 1 auto; }
.sc-field { display: flex; align-items: center; gap: 6px; }
.sc-input, .sc-select { box-sizing: border-box; height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; outline: none; }
.sc-input:focus, .sc-select:focus { border-color: var(--dsw-alias-brand-primary); }
.sc-input[readonly] { opacity: .6; }
.sc-btn { box-sizing: border-box; height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; white-space: nowrap; }
.sc-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay); }
.sc-btn:disabled { opacity: .5; cursor: default; }
.sc-btn.is-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.sc-btn.is-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sc-log { flex: 0 0 auto; height: clamp(220px, 46vh, 560px); min-height: 0; overflow: auto; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.sc-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.sc-line.is-tx { color: var(--dsw-alias-state-success-primary); }
.sc-line.is-sys { color: var(--dsw-alias-label-secondary); font-style: italic; }
.sc-line.is-err { color: var(--dsw-alias-state-error-primary); }
.sc-empty { color: var(--dsw-alias-label-secondary); }
.sc-input-row { display: flex; align-items: center; gap: 6px; }
.sc-input-row .sc-input { flex: 1 1 auto; }
.sc-error { color: var(--dsw-alias-state-error-primary); }
.sc-hint { color: var(--dsw-alias-label-secondary); }
.sc-drawer-layer { position: fixed; inset: 0; z-index: 45; pointer-events: none; }
.sc-drawer { position: fixed; right: 10px; top: 72px; bottom: 104px; width: 360px; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 10px 30px rgba(0, 0, 0, .28); pointer-events: auto; overflow: hidden; font-size: 12px; }
.sc-drawer-head { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.sc-drawer-head .sc-title, .sc-drawer-head .sc-muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-drawer-log { flex: 1 1 auto; min-height: 0; overflow: auto; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.sc-drawer-foot { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sc-drawer-close { width: 26px; padding: 0; font-size: 15px; line-height: 1; }
.sc-presence { display: block; width: 0; height: 0; margin: 0; padding: 0; border: 0; overflow: hidden; }
`

    let translate = (key) => key
    let styleInjected = false

    function ensureStyle(doc) {
      if (styleInjected) return
      const marker = 'dsh-serial-console'
      if (doc.querySelector(`style[data-plugin-css="${marker}"]`)) {
        styleInjected = true
        return
      }
      const style = doc.createElement('style')
      style.setAttribute('data-plugin', 'dsh-serial-console')
      style.setAttribute('data-plugin-css', marker)
      style.textContent = CSS
      doc.head.appendChild(style)
      styleInjected = true
    }

    async function call(path, body) {
      const init =
        body === undefined
          ? { method: 'GET', cache: 'no-store' }
          : {
              method: 'POST',
              cache: 'no-store',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
      const response = await fetch(API + path, init)
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || !data || data.ok === false) {
        const reason = (data && (data.error || data.reason)) || `HTTP ${response.status}`
        throw new Error(reason)
      }
      return data
    }

    function trimEntries(list, added) {
      let total = typeof added === 'number' ? store.totalChars + added : countChars(list)
      let start = 0
      while (total > MAX_LOG_CHARS && start < list.length - 1) {
        total -= list[start].text.length
        start += 1
      }
      store.totalChars = total
      return start === 0 ? list : list.slice(start)
    }

    function countChars(list) {
      let total = 0
      for (const entry of list) total += entry.text.length
      return total
    }

    // ---------------------------------------------------------------- store
    // One poller and one log shared by the tab and the drawer.

    const store = {
      snap: null,
      entries: [],
      cursor: 0,
      generation: 0,
      error: '',
      entrySeq: 0,
      totalChars: 0,
      lastHadData: false,
      flushPending: false,
      listeners: new Set(),
      timer: null,
      polling: false,
      disposed: true,
      // sessionId -> visible probe instances. A `chat` probe lives inside a
      // Chat page row, so it only reports while the Chat view is the one being
      // displayed; a `dock` probe lives in the composer dock and only proves
      // the session itself is on screen. The drawer requires a `chat` probe.
      probes: { chat: new Map(), dock: new Map() },
      // 'auto' = show the right drawer; 'off' = the user hid it by hand.
      drawer: readDrawerPref(),
      // Dock geometry, measured from the message scroller (see findFlow).
      geometry: null,
      flowEl: null,
      reserve: null,
    }

    function readDrawerPref() {
      try {
        const value = window.localStorage.getItem(DRAWER_KEY)
        return value === 'off' ? 'off' : 'auto'
      } catch {
        return 'auto'
      }
    }

    function writeDrawerPref(value) {
      store.drawer = value === 'off' ? 'off' : 'auto'
      try {
        window.localStorage.setItem(DRAWER_KEY, store.drawer)
      } catch {
        /* private mode: the choice just does not survive a reload */
      }
      notify()
    }

    // Coalesce every append into at most one notification per animation frame:
    // a fast serial stream can produce several appends between two paints.
    function notify() {
      if (store.flushPending) return
      store.flushPending = true
      const flush = () => {
        store.flushPending = false
        for (const listener of Array.from(store.listeners)) {
          try {
            listener()
          } catch {
            /* a broken consumer must not stop the poller */
          }
        }
      }
      const canFrame =
        typeof requestAnimationFrame === 'function' &&
        !(typeof document !== 'undefined' && document.hidden)
      if (canFrame) requestAnimationFrame(flush)
      else setTimeout(flush, 16)
    }

    function isOpen(snap) {
      return Boolean(snap && snap.connection && snap.connection.state === 'open')
    }

    /**
     * Tag entries with a monotonic id so trimming the head never shifts React
     * keys (index keys used to remount the whole log on every trim), and keep
     * the character total incrementally instead of rescanning the list.
     */
    function pushEntries(items) {
      if (!items || items.length === 0) return 0
      const tagged = []
      let added = 0
      for (const item of items) {
        const text = item && item.text == null ? '' : String((item && item.text) || '')
        if (!text) continue
        added += text.length
        store.entrySeq += 1
        tagged.push({ id: store.entrySeq, kind: (item && item.kind) || 'rx', text })
      }
      if (tagged.length === 0) return 0
      store.entries = trimEntries(store.entries.concat(tagged), added)
      return tagged.length
    }

    function appendEntries(items) {
      if (pushEntries(items) > 0) notify()
    }

    function resetEntries() {
      store.entries = []
      store.totalChars = 0
      store.cursor = 0
      notify()
    }

    function probeCount(map) {
      let total = 0
      for (const set of map.values()) total += set.size
      return total
    }

    function probeSessions(map) {
      const ids = []
      for (const [sessionId, set] of map) {
        if (set.size > 0) ids.push(sessionId)
      }
      return ids
    }

    /**
     * Presence is piggybacked on the status poll (no extra route): the host
     * echoes it back on `status` so the agent can see which pages the drawer
     * considers visible.
     */
    function uiQuery() {
      const payload = {
        chat: probeCount(store.probes.chat),
        dock: probeCount(store.probes.dock),
        ids: probeSessions(store.probes.chat),
        // Dock geometry is reported for one reason only: `serial status` can then
        // show where the panel sits, which is how the placement is verified.
        geo: store.geometry
          ? Object.assign({}, store.geometry, { reserve: store.reserve ? store.reserve.width : 0 })
          : null,
      }
      return `&ui=${encodeURIComponent(JSON.stringify(payload))}`
    }

    function visibleChatSessions() {
      return probeSessions(store.probes.chat)
    }

    async function poll() {
      if (store.polling || store.disposed) return
      store.polling = true
      let received = 0
      try {
        const data = await call(`/status?since=${store.cursor}${uiQuery()}`)
        store.snap = data
        const buffer = data.buffer || {}
        if (typeof buffer.generation === 'number' && buffer.generation !== store.generation) {
          store.generation = buffer.generation
          store.cursor = Number(buffer.to) || 0
          store.entries = []
          store.totalChars = 0
        } else {
          const items = []
          if (typeof buffer.text === 'string' && buffer.text.length > 0) {
            items.push({ kind: 'rx', text: buffer.text })
            store.cursor = Number(buffer.to) || store.cursor
          }
          if (buffer.truncated) items.push({ kind: 'sys', text: `${translate('truncated')}\n` })
          received = pushEntries(items)
        }
        store.error = ''
      } catch (cause) {
        store.error = cause.message
      } finally {
        store.polling = false
        store.lastHadData = received > 0
        notify()
      }
    }

    function schedule() {
      if (store.disposed) return
      let delay = POLL_IDLE_MS
      if (store.error) delay = POLL_ERROR_MS
      else if (isOpen(store.snap)) delay = store.lastHadData ? POLL_DRAIN_MS : POLL_OPEN_MS
      store.timer = setTimeout(tick, delay)
    }

    async function tick() {
      if (store.disposed) return
      if (typeof document !== 'undefined' && document.hidden) {
        schedule()
        return
      }
      await poll()
      schedule()
    }

    function startPolling() {
      if (!store.disposed) return
      store.disposed = false
      store.cursor = 0
      store.generation = 0
      store.entries = []
      store.totalChars = 0
      tick()
    }

    function stopPolling() {
      store.disposed = true
      if (store.timer) {
        clearTimeout(store.timer)
        store.timer = null
      }
      releaseReserve()
      store.listeners.clear()
    }

    function useSerial() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        store.listeners.add(force)
        return () => {
          store.listeners.delete(force)
        }
      }, [])
      return { snap: store.snap, entries: store.entries, error: store.error }
    }

    /**
     * One memoized row per log entry: entry objects never change once created,
     * so a burst only renders the rows it actually added.
     */
    const LogLine = React.memo(function LogLine(props) {
      const entry = props.entry
      return h('div', { className: `sc-line is-${entry.kind}` }, entry.text)
    })

    function useFollow(ref, deps) {
      const followRef = React.useRef(true)
      React.useLayoutEffect(() => {
        const node = ref.current
        if (!node || !followRef.current) return
        node.scrollTop = node.scrollHeight
      }, deps)
      const onScroll = (event) => {
        const node = event.currentTarget
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
      }
      return onScroll
    }

    const ENDINGS = [
      ['crlf', 'CR LF'],
      ['lf', 'LF'],
      ['cr', 'CR'],
      ['none', '—'],
    ]

    const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600]

    // Frame format: data bits, parity, stop bits. Sent with every open() call so
    // a board that is not 8N1 (7E1 bootloader prompts, 8E1 controllers) reads
    // correctly instead of arriving as noise.
    const DATA_BITS = ['8', '7', '6', '5']
    const PARITIES = [
      ['None', 'N'],
      ['Even', 'E'],
      ['Odd', 'O'],
    ]
    const STOPBITS = [
      ['One', '1'],
      ['Two', '2'],
    ]

    function frameLabel(dataBits, parity, stopBits) {
      const parityLetter = paritiesLetter(parity)
      const stop = stopBits === 'Two' ? '2' : stopBits === 'OnePointFive' ? '1.5' : '1'
      return `${dataBits}${parityLetter}${stop}`
    }

    function paritiesLetter(parity) {
      if (parity === 'Even') return 'E'
      if (parity === 'Odd') return 'O'
      if (parity === 'Mark') return 'M'
      if (parity === 'Space') return 'S'
      return 'N'
    }

    // ------------------------------------------------------------- tab view

    function SerialView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const { snap, entries, error: pollError } = useSerial()
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [follow, setFollow] = React.useState(true)
      const [port, setPort] = React.useState('')
      const [baud, setBaud] = React.useState('115200')
      const [dataBits, setDataBits] = React.useState('8')
      const [parity, setParity] = React.useState('None')
      const [stopBits, setStopBits] = React.useState('One')
      const [ending, setEnding] = React.useState('crlf')
      const [draft, setDraft] = React.useState('')

      const mountedRef = React.useRef(true)
      const logRef = React.useRef(null)
      const portTouchedRef = React.useRef(false)

      const t = (key) => translate(key)

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      React.useLayoutEffect(() => {
        const node = logRef.current
        if (!node || !follow) return
        node.scrollTop = node.scrollHeight
      }, [entries, follow])

      const refreshPorts = React.useCallback(async () => {
        setBusy('ports')
        try {
          const data = await call('/ports')
          if (!mountedRef.current) return
          store.snap = store.snap ? { ...store.snap, ports: data.ports || [] } : store.snap
          notify()
          setError('')
        } catch (cause) {
          if (mountedRef.current) setError(cause.message)
        } finally {
          if (mountedRef.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        refreshPorts()
      }, [refreshPorts])

      const connected = isOpen(snap)
      const connection = (snap && snap.connection) || {}

      React.useEffect(() => {
        if (!connected || portTouchedRef.current) return
        if (connection.port) setPort(connection.port)
        if (connection.baudRate) setBaud(String(connection.baudRate))
        if (connection.dataBits) setDataBits(String(connection.dataBits))
        if (connection.parity) setParity(String(connection.parity))
        if (connection.stopBits) setStopBits(String(connection.stopBits))
      }, [connected, connection.port, connection.baudRate, connection.dataBits, connection.parity, connection.stopBits])

      const run = async (label, action) => {
        setBusy(label)
        try {
          await action()
          setError('')
        } catch (cause) {
          setError(cause.message)
        } finally {
          if (mountedRef.current) setBusy('')
        }
      }

      const connect = () =>
        run('connect', async () => {
          // Do NOT upper-case here: POSIX device paths are case-sensitive
          // ("/dev/cu.usbserial-110" -> "/DEV/CU.USBSERIAL-110" is not a path).
          // The server normalises Windows COM names itself (openPort()).
          const name = port.trim()
          if (!name) throw new Error(t('choosePort'))
          await call('/open', {
            port: name,
            baudRate: Number(baud) || 115200,
            dataBits: Number(dataBits) || 8,
            parity,
            stopBits,
            session: sessionId,
          })
          portTouchedRef.current = true
          appendEntries([
            { kind: 'sys', text: `${name} @ ${baud} ${frameLabel(dataBits, parity, stopBits)} — ${t('connected')}\n` },
          ])
          await poll()
        })

      const disconnect = () =>
        run('close', async () => {
          await call('/close', {})
          appendEntries([{ kind: 'sys', text: `${t('disconnected')}\n` }])
          await poll()
        })

      const resetTarget = () =>
        run('reset', async () => {
          await call('/reset', {})
          appendEntries([{ kind: 'sys', text: `${t('reset')}\n` }])
        })

      const clearLog = () =>
        run('clear', async () => {
          await call('/clear', {})
          resetEntries()
        })

      const send = () =>
        run('send', async () => {
          const text = draft
          if (!text) return
          await call('/write', { text, ending, session: sessionId })
          appendEntries([{ kind: 'tx', text: `${text.replace(/\n/g, '\\n')}\n` }])
          setDraft('')
          await poll()
        })

      const ports = (snap && snap.ports) || []
      const bridge = (snap && snap.bridge) || {}
      const supported = !snap || snap.supported !== false
      const statusText = connected
        ? `${connection.port} · ${connection.baudRate} ${frameLabel(
            String(connection.dataBits || 8),
            connection.parity || 'None',
            connection.stopBits || 'One',
          )}`
        : t('disconnected')
      const shown = error || pollError

      return h(
        'div',
        { className: 'sc-root' },
        h(
          'div',
          { className: 'sc-bar' },
          h('span', { className: `sc-dot${connected ? ' is-on' : ''}${shown ? ' is-err' : ''}` }),
          h('span', { className: 'sc-title' }, t('title')),
          h('span', { className: 'sc-muted' }, statusText),
          h('span', { className: 'sc-spacer' }),
          h(
            'label',
            { className: 'sc-field' },
            h('span', { className: 'sc-muted' }, t('follow')),
            h('input', {
              type: 'checkbox',
              checked: follow,
              onChange: (event) => setFollow(event.target.checked),
            }),
          ),
          h('button', { className: 'sc-btn', onClick: refreshPorts, disabled: Boolean(busy) }, t('refresh')),
          h('button', { className: 'sc-btn', onClick: clearLog, disabled: Boolean(busy) }, t('clear')),
          h(
            'button',
            {
              className: 'sc-btn',
              title: t('drawerToggle'),
              'aria-pressed': store.drawer !== 'off',
              onClick: () => writeDrawerPref(store.drawer === 'off' ? 'auto' : 'off'),
            },
            `${t('drawerToggle')}: ${store.drawer === 'off' ? t('off') : t('on')}`,
          ),
        ),

        h(
          'div',
          { className: 'sc-bar' },
          h(
            'label',
            { className: 'sc-field' },
            h('span', { className: 'sc-muted' }, t('ports')),
            h(
              'select',
              {
                className: 'sc-select',
                value: port,
                disabled: connected || Boolean(busy),
                onChange: (event) => {
                  portTouchedRef.current = true
                  setPort(event.target.value)
                },
              },
              [
                h('option', { key: '__none', value: '' }, t('choosePort')),
                ...ports.map((item) =>
                  h('option', { key: item.port, value: item.port }, item.label ? `${item.port} — ${item.label}` : item.port),
                ),
              ],
            ),
          ),
          h(
            'label',
            { className: 'sc-field' },
            h('span', { className: 'sc-muted' }, t('baud')),
            h(
              'select',
              {
                className: 'sc-select',
                value: baud,
                disabled: connected || Boolean(busy),
                onChange: (event) => setBaud(event.target.value),
              },
              BAUDS.map((value) => h('option', { key: value, value: String(value) }, String(value))),
            ),
          ),
          h(
            'label',
            { className: 'sc-field' },
            h('span', { className: 'sc-muted' }, t('dataBits')),
            h(
              'select',
              {
                className: 'sc-select',
                value: dataBits,
                disabled: connected || Boolean(busy),
                onChange: (event) => setDataBits(event.target.value),
              },
              DATA_BITS.map((value) => h('option', { key: value, value }, value)),
            ),
          ),
          h(
            'label',
            { className: 'sc-field' },
            h('span', { className: 'sc-muted' }, t('parity')),
            h(
              'select',
              {
                className: 'sc-select',
                value: parity,
                disabled: connected || Boolean(busy),
                onChange: (event) => setParity(event.target.value),
              },
              PARITIES.map(([value, short]) => h('option', { key: value, value }, `${short} (${t(`parity${value}`)})`)),
            ),
          ),
          h(
            'label',
            { className: 'sc-field' },
            h('span', { className: 'sc-muted' }, t('stopBits')),
            h(
              'select',
              {
                className: 'sc-select',
                value: stopBits,
                disabled: connected || Boolean(busy),
                onChange: (event) => setStopBits(event.target.value),
              },
              STOPBITS.map(([value, short]) => h('option', { key: value, value }, `${short} (${t(`stop${value}`)})`)),
            ),
          ),
          connected
            ? h('button', { className: 'sc-btn is-danger', onClick: disconnect, disabled: Boolean(busy) }, t('disconnect'))
            : h('button', { className: 'sc-btn is-primary', onClick: connect, disabled: Boolean(busy) || !supported }, t('connect')),
          connected ? h('button', { className: 'sc-btn', onClick: resetTarget, disabled: Boolean(busy) }, t('reset')) : null,
          h('span', { className: 'sc-spacer' }),
          !supported ? h('span', { className: 'sc-error' }, t('unsupported')) : null,
          supported && bridge.ready === false && !connected
            ? h('span', { className: 'sc-hint' }, t('bridgeDown'))
            : null,
          store.drawer !== 'off' && computeDock(store.geometry)?.ok === false
            ? h('span', { className: 'sc-hint' }, t('noRoom'))
            : null,
          busy ? h('span', { className: 'sc-hint' }, t('waiting')) : null,
        ),

        shown ? h('div', { className: 'sc-error' }, shown) : null,

        h(
          'div',
          { className: 'sc-log', ref: logRef },
          entries.length === 0
            ? h(
                'div',
                { className: 'sc-empty' },
                connected ? t('empty') : `${t('empty')}\n${t('notConnectedHint')}`,
              )
            : entries.map((entry) => h(LogLine, { key: entry.id, entry })),
        ),

        h(
          'div',
          { className: 'sc-input-row' },
          h('input', {
            className: 'sc-input',
            value: draft,
            placeholder: t('placeholder'),
            'aria-label': t('inputLabel'),
            disabled: !connected,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            },
          }),
          h(
            'select',
            {
              className: 'sc-select',
              value: ending,
              onChange: (event) => setEnding(event.target.value),
            },
            ENDINGS.map(([value, label]) => h('option', { key: value, value }, label)),
          ),
          h('button', { className: 'sc-btn is-primary', onClick: send, disabled: !connected || Boolean(busy) }, t('send')),
        ),
      )
    }

    // ---------------------------------------------------------- right drawer

    let probeSeq = 0

    /**
     * The message scroller is the box the drawer docks into: it is the only
     * element that (a) spans the conversation column and (b) shrinks when the
     * right document column opens, so measuring it keeps the panel clear of
     * both the Chat text and the document preview.
     */
    function findFlow(node) {
      let element = node && node.parentElement
      for (let depth = 0; element && depth < 14; depth += 1, element = element.parentElement) {
        if (element === document.body || element === document.documentElement) break
        const style = getComputedStyle(element)
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && element.clientHeight > 240) {
          return element
        }
      }
      return null
    }

    function measureFlow(flow) {
      const rect = flow.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        // Width of the scrollbar/border band: the panel must stay clear of it so
        // the scrollbar stays usable while the panel is docked.
        gutter: Math.max(0, flow.offsetWidth - flow.clientWidth),
        viewportW: document.documentElement.clientWidth || window.innerWidth,
        viewportH: document.documentElement.clientHeight || window.innerHeight,
      }
    }

    function geometryMoved(previous, next) {
      if (!previous || !next) return true
      for (const key of ['left', 'right', 'top', 'bottom', 'width', 'height', 'gutter', 'viewportW', 'viewportH']) {
        if (Math.abs((previous[key] || 0) - (next[key] || 0)) >= 2) return true
      }
      return false
    }

    function updateGeometry(flow) {
      if (!flow || !flow.isConnected) return
      store.flowEl = flow
      const next = measureFlow(flow)
      if (geometryMoved(store.geometry, next)) {
        store.geometry = next
        notify()
      }
    }

    /**
     * Zero-size visibility probe. Registering the same component in several
     * places is what lets the drawer tell "this session and its Chat page are
     * on screen" apart from "this session is on screen, but another view is
     * selected": only probes mounted inside the Chat view report as visible
     * when the Chat view is the displayed one.
     */
    function PresenceProbe(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const bucketName = props && props.bucket === 'dock' ? 'dock' : 'chat'
      const bucket = store.probes[bucketName]
      const ref = React.useRef(null)
      const instance = React.useRef('')
      if (!instance.current) instance.current = `p${(probeSeq += 1)}`

      React.useEffect(() => {
        if (!sessionId) return undefined
        const id = instance.current
        const node = ref.current
        let reported = false

        const apply = (visible) => {
          if (visible === reported) return
          reported = visible
          let set = bucket.get(sessionId)
          if (!set) {
            set = new Set()
            bucket.set(sessionId, set)
          }
          if (visible) set.add(id)
          else set.delete(id)
          if (set.size === 0) bucket.delete(sessionId)
          notify()
        }

        const evaluate = () => {
          let visible = false
          if (node && node.isConnected) {
            if (typeof node.checkVisibility === 'function') {
              visible = node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
            } else {
              visible = Boolean(node.getClientRects && node.getClientRects().length > 0)
            }
          }
          apply(visible)
          if (visible && bucketName === 'chat') updateGeometry(findFlow(node))
        }

        evaluate()
        const timer = setInterval(evaluate, PRESENCE_MS)
        window.addEventListener('resize', evaluate)
        return () => {
          clearInterval(timer)
          window.removeEventListener('resize', evaluate)
          apply(false)
        }
      }, [sessionId, bucketName])

      return h('span', { ref, className: 'sc-presence', 'aria-hidden': 'true' })
    }

    function sameSession(a, b) {
      if (!a || !b) return false
      const strip = (value) => String(value).replace(/^session-/, '')
      return strip(a) === strip(b)
    }

    function drawerAllowed(snap) {
      if (store.drawer === 'off') return false
      if (!isOpen(snap)) return false
      const owner = snap && snap.connection ? String(snap.connection.ownerSession || '') : ''
      if (owner === '') return false
      for (const sessionId of visibleChatSessions()) {
        if (sameSession(sessionId, owner)) return true
      }
      return false
    }

    /**
     * The scroller reserves the drawer's width on its right edge, so Chat text
     * flows beside the panel instead of underneath it. The previous inline
     * value is restored on release, and the element is marked while it is
     * borrowed so a reload can tell the padding was ours.
     */
    function applyReserve(element, width) {
      if (!element || !element.isConnected) return
      const value = `${Math.round(width) + RESERVE_PAD}px`
      if (store.reserve && store.reserve.el === element) {
        store.reserve.width = Math.round(width)
        if (element.style.paddingRight !== value) element.style.paddingRight = value
        return
      }
      releaseReserve()
      store.reserve = { el: element, prev: element.style.paddingRight, width: Math.round(width) }
      element.setAttribute(RESERVE_ATTR, '1')
      element.style.paddingRight = value
    }

    function releaseReserve() {
      const held = store.reserve
      store.reserve = null
      if (!held || !held.el) return
      try {
        held.el.style.paddingRight = held.prev || ''
        held.el.removeAttribute(RESERVE_ATTR)
      } catch {
        /* the element is gone: nothing to restore */
      }
    }

    /**
     * Dock rectangle inside the message scroller. `null` = no scroller has been
     * measured yet (fall back to the plain fixed panel); `ok: false` = the
     * column is too narrow to hold both the text and the panel.
     */
    function computeDock(geometry) {
      if (!geometry || !store.flowEl) return null
      const gutter = Math.max(0, geometry.gutter || 0)
      const available = Math.round(geometry.width - gutter - EDGE_GAP * 2)
      if (available < RESERVE_MIN) return { ok: false, width: 0 }
      const width = Math.max(DRAWER_MIN, Math.min(DRAWER_PREFERRED, available))
      return {
        ok: true,
        width,
        // Right edge lands on the content edge, left of the scrollbar band.
        right: Math.max(0, Math.round(geometry.viewportW - geometry.right + gutter + EDGE_GAP)),
        top: Math.max(0, Math.round(geometry.top + EDGE_GAP)),
        height: Math.max(140, Math.round(geometry.height - EDGE_GAP * 2)),
      }
    }

    function SerialDrawer() {
      const { snap, entries, error } = useSerial()
      const logRef = React.useRef(null)
      const onScroll = useFollow(logRef, [entries])
      const allowed = drawerAllowed(snap)
      const dock = computeDock(store.geometry)
      const reserveWidth = allowed && dock && dock.ok ? dock.width : 0

      React.useLayoutEffect(() => {
        if (!reserveWidth) {
          releaseReserve()
          return undefined
        }
        applyReserve(store.flowEl, reserveWidth)
        return () => releaseReserve()
      }, [reserveWidth])

      if (!allowed) return null
      if (dock && dock.ok === false) return null

      const style =
        dock && dock.ok
          ? {
              right: `${dock.right}px`,
              top: `${dock.top}px`,
              bottom: 'auto',
              height: `${dock.height}px`,
              width: `${dock.width}px`,
            }
          : null

      const connection = (snap && snap.connection) || {}
      const recent = entries.length > MAX_DRAWER_ENTRIES ? entries.slice(-MAX_DRAWER_ENTRIES) : entries

      return h(
        'div',
        { className: 'sc-drawer-layer' },
        h(
          'section',
          { className: 'sc-drawer', role: 'region', 'aria-label': translate('drawerTitle'), style },
          h(
            'div',
            { className: 'sc-drawer-head' },
            h('span', { className: `sc-dot${error ? ' is-err' : ' is-on'}` }),
            h('span', { className: 'sc-title' }, translate('drawerTitle')),
            h(
              'span',
              { className: 'sc-muted' },
              `${connection.port} · ${connection.baudRate} ${frameLabel(
                String(connection.dataBits || 8),
                connection.parity || 'None',
                connection.stopBits || 'One',
              )}`,
            ),
            h('span', { className: 'sc-spacer' }),
            h(
              'button',
              {
                className: 'sc-btn sc-drawer-close',
                title: translate('close'),
                'aria-label': translate('close'),
                onClick: () => writeDrawerPref('off'),
              },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'sc-drawer-log', ref: logRef, onScroll },
            recent.length === 0
              ? h('div', { className: 'sc-empty' }, translate('drawerEmpty'))
              : recent.map((entry) => h(LogLine, { key: entry.id, entry })),
          ),
          error ? h('div', { className: 'sc-error' }, error) : null,
          h('div', { className: 'sc-drawer-foot' }, translate('drawerHint')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyle(document)
        translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }))
        ctx.effect(() => {
          startPolling()
          return () => stopPolling()
        })
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'serial',
              order: 25,
              locale: NS,
              label: () => translate('tab'),
            },
            SerialView,
          ),
        )
        const probe = (bucket) => (props) => h(PresenceProbe, Object.assign({}, props, { bucket }))
        const mount = (slot, options, Component) => {
          ctx.slots.inject(slot, () => {
            try {
              return ctx.slots.register(options, Component)
            } catch (error) {
              // A slot that refuses this registration must not take the rest
              // of the plugin down with it.
              console.warn('[serial-console] cannot register into', slot, error)
              return () => {}
            }
          })
        }

        // Chat-view probes: these live inside Chat page rows, so they go away
        // (or turn invisible) as soon as another view is selected.
        mount(
          'conversation.chat.assistant-actions',
          { name: 'conversation.chat.assistant-actions', id: 'serial-presence', order: 90, locale: NS },
          probe('chat'),
        )
        mount(
          'conversation.chat.turnTail',
          { name: 'conversation.chat.turnTail', id: 'serial-presence', order: 90, locale: NS },
          probe('chat'),
        )
        mount(
          'conversation.chat.text-interaction',
          { name: 'conversation.chat.text-interaction', key: 'serial-presence', locale: NS },
          probe('chat'),
        )
        // Composer-dock probe: only proves the session is on screen.
        mount(
          'conversation.composer.dock',
          { name: 'conversation.composer.dock', id: 'serial-presence', order: 40, locale: NS },
          probe('dock'),
        )

        mount(
          'shell.overlay',
          { name: 'shell.overlay', id: 'serial-drawer', order: 50, locale: NS, label: () => translate('drawerTitle') },
          SerialDrawer,
        )
      },
    }
  },
})
