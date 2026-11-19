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
    // While data is arriving, poll at ~30 Hz instead of once per frame: the
    // browser coalesces renders per frame anyway, so 16 ms doubled the request
    // and render load for output that scrolls at the same visual speed.
    const POLL_DRAIN_MS = 32
    const POLL_ERROR_MS = 900
    const MAX_LOG_CHARS = 200000
    const MAX_DRAWER_ENTRIES = 240
    const DRAWER_KEY = 'dsh-serial-console.drawer'
    // Log colouring is a pure view preference: entries keep their original
    // text, so a wrong rule can only mis-paint, never change what the device
    // said or what a copy of the log contains.
    const HIGHLIGHT_KEY = 'dsh-serial-console.highlight'
    // Editing a rule rewrites the whole visible log; typing must not repaint on
    // every keystroke, so words and hex fields commit on a short debounce.
    const HIGHLIGHT_DEBOUNCE_MS = 300
    const MAX_RULES = 20
    const MAX_RULE_WORDS = 50
    const MAX_WORD_CHARS = 64
    const RULE_PALETTE = ['#e5484d', '#f5a623', '#30a46c', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316']
    // ESP-IDF level letters. Token colours follow the active theme; a custom
    // rule paints a literal colour the user picked, so it does not.
    const LEVEL_COLORS = {
      E: 'var(--dsw-alias-state-error-primary)',
      W: 'var(--dsw-alias-state-warn-primary)',
      I: 'var(--dsw-alias-state-success-primary)',
      D: 'var(--dsw-alias-brand-primary)',
      V: 'var(--dsw-alias-label-secondary)',
    }
    // `I (397100) tag: message`. A leading ANSI run is tolerated because builds
    // with CONFIG_LOG_COLORS print one before the level letter.
    const LEVEL_LINE = /^[ \t]*(?:\x1b\[[0-9;]*m)*([EWIDV])\s*\(\d+\)/
    // Fallback cadence only: layout hints (transitions, resize, focus, tab
    // switches) nudge the probes immediately, so this tick only has to catch
    // visibility changes that fire no event at all. At 400 ms the periodic
    // checkVisibility/getBoundingClientRect pass was the steady-state layout
    // cost of a page that merely had a Chat view open.
    const PRESENCE_MS = 1000
    // The right document column animates open and closed. The drawer has to
    // follow it frame by frame: measuring once per PRESENCE_MS tick made the
    // panel catch up in visible jumps. Every layout hint keeps this follow loop
    // alive for a short tail of frames after the last change, then it stops.
    const GEOMETRY_TAIL_MS = 480
    // Last dock samples, summarised on the status poll so `serial status` can
    // show whether the panel followed a layout change or jumped.
    const GEOMETRY_TRACE = 12
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
      'badgeOpen': 'Serial connected',
      'badgeClosed': 'Serial not connected',
      'badgeError': 'Serial error',
      'highlightLevels': 'ESP level colors',
      'highlightCustom': 'Custom colors',
      'highlightNoRules': 'No rules yet. Add one to color matching lines.',
      'highlightAddRule': 'Add rule',
      'highlightWords': 'Match words',
      'highlightWordsHint': 'Separate words with commas or semicolons',
      'highlightRemoveRule': 'Remove rule',
      'highlightColor': 'Color',
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
      'badgeOpen': '串口已连接',
      'badgeClosed': '串口未连接',
      'badgeError': '串口异常',
      'highlightLevels': 'ESP 级别着色',
      'highlightCustom': '自定义颜色',
      'highlightNoRules': '还没有规则，点「新增规则」开始。',
      'highlightAddRule': '新增规则',
      'highlightWords': '识别词',
      'highlightWordsHint': '多个词用逗号或分号分隔',
      'highlightRemoveRule': '删除规则',
      'highlightColor': '颜色',
    }

    const CSS = `
.sc-root { box-sizing: border-box; display: flex; flex-direction: column; height: auto; min-height: 0; max-height: 100%; overflow: hidden; gap: 8px; padding: 10px 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
.sc-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 26px; }
.sc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: 0 0 auto; }
.sc-dot.is-on { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
.sc-dot.is-err { background: var(--dsw-alias-state-error-primary); }
/* View-tab dot: painted on the label of the Serial tab, which is the only
   surface still on screen while the right panel is closed. The tab button gets
   a data-serial-state attribute from syncTabIndicator; the label text itself is
   untouched, so the accessible name stays "Serial" and a host change degrades
   to no dot. */
[data-conversation-tabs] button[data-serial-state] > span::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; vertical-align: 1px; background: var(--dsw-alias-state-idle-primary); }
[data-conversation-tabs] button[data-serial-state="on"] > span::before { background: var(--dsw-alias-state-success-primary); }
[data-conversation-tabs] button[data-serial-state="err"] > span::before { background: var(--dsw-alias-state-error-primary); }
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
.sc-switch { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; height: 26px; padding: 0 10px 0 4px; border-radius: 13px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; white-space: nowrap; }
.sc-switch:hover { background: var(--dsw-alias-bg-overlay); }
.sc-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.sc-switch-knob { width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.sc-switch.is-on { border-color: var(--dsw-alias-brand-primary); }
.sc-switch.is-on .sc-switch-knob { background: var(--dsw-alias-brand-primary); }
.sc-rules { display: flex; flex-direction: column; gap: 6px; max-height: 168px; overflow: auto; box-sizing: border-box; padding: 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.sc-rule { display: flex; align-items: center; gap: 6px; }
.sc-swatch { box-sizing: border-box; width: 26px; height: 26px; flex: 0 0 auto; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; cursor: pointer; }
.sc-swatch::-webkit-color-swatch-wrapper { padding: 2px; }
.sc-swatch::-webkit-color-swatch { border: 0; border-radius: 4px; }
.sc-hex { width: 84px; flex: 0 0 auto; font-family: var(--ds-font-family-code, ui-monospace, monospace); }
.sc-rule-words { flex: 1 1 auto; min-width: 80px; }
.sc-rule-del { flex: 0 0 auto; width: 26px; padding: 0; }
.sc-log.is-compact { height: clamp(150px, 34vh, 420px); }
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

    let paintSerial = 0

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
      // Log colouring: the persisted choice plus the derived, immutable paint
      // object handed to each row. A new paint identity is what makes a settings
      // change repaint the visible log; unchanged text never does.
      highlight: readHighlightPref(),
      paint: null,
      paintTimer: null,
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
      // The mounted drawer node, so a geometry change can move it without a
      // React render, and the dock width bucket the last render was made for.
      drawerEl: null,
      dockSignature: '',
      observedFlow: null,
      measureFrame: 0,
      measureUntil: 0,
      geoSamples: [],
    }

    store.paint = buildPaint(store.highlight)

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

    // ------------------------------------------------------------ highlighting

    function defaultHighlight() {
      return { v: 1, levels: true, custom: false, rules: [] }
    }

    function escapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    /** `abc`, `#ABC`, `#aabbcc` and `AABBCC` all normalize to `#aabbcc`. */
    function normalizeHex(raw) {
      if (typeof raw !== 'string') return null
      const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim())
      if (!match) return null
      const digits = match[1].toLowerCase()
      return '#' + (digits.length === 3 ? digits.replace(/./g, (ch) => ch + ch) : digits)
    }

    /** Words are separated by ASCII or full-width commas and semicolons. */
    function parseRuleWords(raw) {
      if (typeof raw !== 'string') return []
      const seen = new Set()
      const words = []
      for (const part of raw.split(/[,，;；]/)) {
        const word = part.trim().slice(0, MAX_WORD_CHARS)
        if (!word) continue
        const key = word.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        words.push(word)
        if (words.length >= MAX_RULE_WORDS) break
      }
      return words
    }

    /** Immutable snapshot of the settings; a new identity means "repaint". */
    function buildPaint(prefs) {
      const rules = []
      for (const rule of prefs.rules) {
        const words = parseRuleWords(rule.words)
        if (words.length === 0) continue
        rules.push({ color: rule.color, re: new RegExp(words.map(escapeRegExp).join('|'), 'i') })
      }
      return {
        levels: prefs.levels,
        custom: prefs.custom,
        rules,
        active: prefs.levels || prefs.custom,
        version: ++paintSerial,
      }
    }

    function readHighlightPref() {
      const fallback = defaultHighlight()
      let parsed
      try {
        const raw = window.localStorage.getItem(HIGHLIGHT_KEY)
        if (!raw) return fallback
        parsed = JSON.parse(raw)
      } catch {
        return fallback
      }
      if (!parsed || typeof parsed !== 'object') return fallback
      const rules = []
      const source = Array.isArray(parsed.rules) ? parsed.rules.slice(0, MAX_RULES) : []
      for (const item of source) {
        if (!item || typeof item !== 'object') continue
        const color = normalizeHex(item.color) || RULE_PALETTE[rules.length % RULE_PALETTE.length]
        rules.push({
          id: typeof item.id === 'string' && item.id ? item.id : 'r' + (rules.length + 1) + '-' + Math.random().toString(36).slice(2, 8),
          color,
          words: typeof item.words === 'string' ? item.words.slice(0, MAX_WORD_CHARS * MAX_RULE_WORDS) : '',
        })
      }
      return { v: 1, levels: parsed.levels !== false, custom: parsed.custom === true, rules }
    }

    function writeHighlightPref() {
      try {
        window.localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify(store.highlight))
      } catch {
        /* private mode: the choice just does not survive a reload */
      }
    }

    /** Apply immediately: used by switches and by add/remove rule. */
    function commitHighlight() {
      if (store.paintTimer) {
        clearTimeout(store.paintTimer)
        store.paintTimer = null
      }
      store.paint = buildPaint(store.highlight)
      writeHighlightPref()
      notify()
    }

    /** Coalesce keystrokes in the words/hex fields into one repaint. */
    function scheduleHighlight() {
      if (store.paintTimer) clearTimeout(store.paintTimer)
      store.paintTimer = setTimeout(commitHighlight, HIGHLIGHT_DEBOUNCE_MS)
    }

    /**
     * Whole-line colour for one line: a custom rule wins over the level colour,
     * rules are tried in list order, and everything else stays default.
     */
    function colorOfLine(line, paint) {
      if (!paint.active) return ''
      if (paint.custom) {
        for (const rule of paint.rules) {
          if (rule.re.test(line)) return rule.color
        }
      }
      if (paint.levels) {
        const match = LEVEL_LINE.exec(line)
        if (match) return LEVEL_COLORS[match[1]] || ''
      }
      return ''
    }

    /**
     * Decorate one entry's text without altering it: line breaks stay outside
     * the coloured spans, so copying the log yields exactly the device bytes.
     */
    function paintText(text, paint) {
      if (typeof text !== 'string' || text === '') return text
      const lines = text.split('\n')
      if (lines.length === 1) {
        const color = colorOfLine(lines[0], paint)
        return color ? h('span', { style: { color } }, lines[0]) : text
      }
      const nodes = []
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const color = colorOfLine(line, paint)
        if (color) nodes.push(h('span', { key: 'l' + index, style: { color } }, line))
        else if (line) nodes.push(line)
        if (index < lines.length - 1) nodes.push('\n')
      }
      return nodes
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
      // Dock samples, summarised rather than listed: `serial status` can then
      // tell a smooth follow (many samples in a short window) from a jump (one
      // sample, or two far apart) without growing the poll payload.
      const samples = store.geoSamples
      if (samples.length > 1) {
        const first = samples[0]
        const last = samples[samples.length - 1]
        payload.dockTrace = {
          n: samples.length,
          span: Math.max(0, Math.round(last[0] - first[0])),
          from: [first[1], first[3]],
          to: [last[1], last[3]],
        }
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
        syncTabIndicator()
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
      syncTabIndicator(true)
      tick()
    }

    function stopPolling() {
      store.disposed = true
      if (store.timer) {
        clearTimeout(store.timer)
        store.timer = null
      }
      if (store.paintTimer) {
        clearTimeout(store.paintTimer)
        store.paintTimer = null
      }
      stopMeasure()
      releaseReserve()
      store.listeners.clear()
      // A re-enable starts from a clean slate: the old scroller is gone.
      store.drawerEl = null
      store.flowEl = null
      store.geometry = null
      store.dockSignature = ''
      store.geoSamples = []
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
     * so a burst only renders the rows it actually added. The paint object is
     * part of the comparison because a settings change must repaint the past.
     */
    const LogLine = React.memo(
      function LogLine(props) {
        const entry = props.entry
        const paint = props.paint
        const body = paint && paint.active && entry.kind === 'rx' ? paintText(entry.text, paint) : entry.text
        return h('div', { className: `sc-line is-${entry.kind}` }, body)
      },
      (prev, next) => prev.entry === next.entry && prev.paint === next.paint,
    )

    /** Real switch semantics, so keyboard and screen readers see on/off. */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'sc-switch' + (props.on ? ' is-on' : ''),
          role: 'switch',
          'aria-checked': props.on ? 'true' : 'false',
          title: props.label,
          onClick: props.onChange,
        },
        h('span', { className: 'sc-switch-knob' }),
        h('span', {}, props.label),
      )
    }

    /**
     * One custom colour rule. The hex field keeps its own draft so a half-typed
     * value such as `#1f` neither commits nor jumps back to the old colour;
     * blur reverts to the last committed value.
     */
    function RuleRow(props) {
      const rule = props.rule
      const t = props.t
      const [hex, setHex] = React.useState(rule.color)
      React.useEffect(() => {
        setHex(rule.color)
      }, [rule.color])
      return h(
        'div',
        { className: 'sc-rule' },
        h('input', {
          type: 'color',
          className: 'sc-swatch',
          value: rule.color,
          'aria-label': t('highlightColor'),
          title: t('highlightColor'),
          onChange: (event) => props.onColor(event.target.value),
        }),
        h('input', {
          className: 'sc-input sc-hex',
          value: hex,
          spellCheck: false,
          'aria-label': t('highlightColor'),
          onChange: (event) => {
            const raw = event.target.value
            setHex(raw)
            const color = normalizeHex(raw)
            if (color) props.onColor(color)
          },
          onBlur: () => setHex(rule.color),
        }),
        h('input', {
          className: 'sc-input sc-rule-words',
          value: rule.words,
          placeholder: t('highlightWordsHint'),
          spellCheck: false,
          'aria-label': t('highlightWords'),
          onChange: (event) => props.onWords(event.target.value),
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'sc-btn sc-rule-del',
            title: t('highlightRemoveRule'),
            'aria-label': t('highlightRemoveRule'),
            onClick: props.onRemove,
          },
          '×',
        ),
      )
    }

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

      const highlight = store.highlight
      const rules = highlight.rules

      const setLevels = (on) => {
        store.highlight = { ...store.highlight, levels: on }
        commitHighlight()
      }
      const setCustom = (on) => {
        store.highlight = { ...store.highlight, custom: on }
        commitHighlight()
      }
      // Words and hex edits repaint on the debounce; add/remove repaint at once.
      const updateRules = (next, immediate) => {
        store.highlight = { ...store.highlight, rules: next }
        notify()
        if (immediate) commitHighlight()
        else scheduleHighlight()
      }
      const addRule = () => {
        if (rules.length >= MAX_RULES) return
        updateRules(
          [
            ...rules,
            {
              id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              color: RULE_PALETTE[rules.length % RULE_PALETTE.length],
              words: '',
            },
          ],
          true,
        )
      }

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

        h(
          'div',
          { className: 'sc-bar' },
          h(Switch, {
            on: highlight.levels,
            label: t('highlightLevels'),
            onChange: () => setLevels(!highlight.levels),
          }),
          h(Switch, {
            on: highlight.custom,
            label: t('highlightCustom'),
            onChange: () => setCustom(!highlight.custom),
          }),
          h('span', { className: 'sc-spacer' }),
          highlight.custom
            ? h(
                'button',
                { className: 'sc-btn', onClick: addRule, disabled: rules.length >= MAX_RULES },
                t('highlightAddRule'),
              )
            : null,
        ),

        highlight.custom
          ? h(
              'div',
              { className: 'sc-rules' },
              rules.length === 0
                ? h('div', { className: 'sc-empty' }, t('highlightNoRules'))
                : rules.map((rule) =>
                    h(RuleRow, {
                      key: rule.id,
                      rule,
                      t,
                      onColor: (color) =>
                        updateRules(
                          rules.map((item) => (item.id === rule.id ? { ...item, color } : item)),
                          false,
                        ),
                      onWords: (words) =>
                        updateRules(
                          rules.map((item) => (item.id === rule.id ? { ...item, words } : item)),
                          false,
                        ),
                      onRemove: () => updateRules(rules.filter((item) => item.id !== rule.id), true),
                    }),
                  ),
            )
          : null,

        shown ? h('div', { className: 'sc-error' }, shown) : null,

        h(
          'div',
          { className: 'sc-log' + (highlight.custom ? ' is-compact' : ''), ref: logRef },
          entries.length === 0
            ? h(
                'div',
                { className: 'sc-empty' },
                connected ? t('empty') : `${t('empty')}\n${t('notConnectedHint')}`,
              )
            : entries.map((entry) => h(LogLine, { key: entry.id, entry, paint: store.paint })),
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

    let flowObserver = null

    const frameScheduler =
      typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16)

    /**
     * Mounted presence probes re-check their visibility when the layout moves
     * instead of on a fast timer. Nudges coalesce to a single animation frame
     * and run each probe's own evaluate, so a tab switch or a column resize is
     * noticed before the next paint.
     */
    const presenceNudges = new Set()
    let presenceNudgeFrame = 0

    function nudgePresence() {
      if (presenceNudges.size === 0 || presenceNudgeFrame) return
      presenceNudgeFrame = frameScheduler(() => {
        presenceNudgeFrame = 0
        for (const evaluate of Array.from(presenceNudges)) {
          try {
            evaluate()
          } catch {
            /* one probe must not break the others */
          }
        }
      })
    }

    function clockMs() {
      return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
    }

    function setPx(node, name, value) {
      const text = `${value}px`
      if (node.style[name] !== text) node.style[name] = text
    }

    /**
     * Move the mounted drawer to the current dock rectangle. Position is pure
     * style, so it is written straight to the node: geometry arrives once per
     * animation frame while the right column is moving, and routing that through
     * a React render would re-render the whole log 60 times a second — which is
     * what made the follow look choppy. React only re-renders when the dock
     * width changes, because the reserved padding has to follow that.
     */
    function applyDockGeometry() {
      const node = store.drawerEl
      if (!node || !node.isConnected) return
      const dock = computeDock(store.geometry)
      if (!dock || !dock.ok) return
      setPx(node, 'right', dock.right)
      setPx(node, 'top', dock.top)
      setPx(node, 'height', dock.height)
      setPx(node, 'width', dock.width)
      if (node.style.bottom !== 'auto') node.style.bottom = 'auto'
    }

    function dockSignature(geometry) {
      const dock = computeDock(geometry)
      if (!dock) return 'none'
      if (!dock.ok) return 'tight'
      return `ok:${dock.width}`
    }

    /**
     * Watch the scroller itself: the right document column changes its width, and
     * ResizeObserver fires on every frame of that CSS transition.
     */
    function observeFlow(flow) {
      if (!flow || typeof ResizeObserver !== 'function') return
      if (!flowObserver) flowObserver = new ResizeObserver(() => scheduleMeasure(store.flowEl))
      if (store.observedFlow === flow) return
      if (store.observedFlow) flowObserver.unobserve(store.observedFlow)
      store.observedFlow = flow
      // Border box: the reserve padding is written on this element, and padding
      // alone must not start another follow loop.
      flowObserver.observe(flow, { box: 'border-box' })
    }

    /**
     * Keep measuring for GEOMETRY_TAIL_MS after the last layout hint. The column
     * animates for a few hundred milliseconds and every intermediate width
     * matters, but the loop has to stop by itself once the layout settles — a
     * permanent frame loop would burn CPU on an idle page.
     */
    function scheduleMeasure(flow) {
      if (flow) store.flowEl = flow
      store.measureUntil = Math.max(store.measureUntil, clockMs() + GEOMETRY_TAIL_MS)
      if (store.measureFrame) return
      const step = () => {
        store.measureFrame = 0
        const target = store.flowEl
        if (target && target.isConnected) updateGeometry(target)
        if (clockMs() < store.measureUntil) store.measureFrame = frameScheduler(step)
      }
      store.measureFrame = frameScheduler(step)
    }

    function stopMeasure() {
      store.measureUntil = 0
      if (store.measureFrame) {
        if (typeof cancelAnimationFrame === 'function' && typeof requestAnimationFrame === 'function') {
          cancelAnimationFrame(store.measureFrame)
        } else {
          clearTimeout(store.measureFrame)
        }
        store.measureFrame = 0
      }
      if (flowObserver && store.observedFlow) {
        flowObserver.unobserve(store.observedFlow)
        store.observedFlow = null
      }
    }

    function updateGeometry(flow) {
      if (!flow || !flow.isConnected) return
      store.flowEl = flow
      observeFlow(flow)
      const next = measureFlow(flow)
      if (!geometryMoved(store.geometry, next)) return
      store.geometry = next
      store.geoSamples.push([
        Math.round(clockMs()),
        Math.round(next.left),
        Math.round(next.top),
        Math.round(next.width),
        Math.round(next.height),
      ])
      if (store.geoSamples.length > GEOMETRY_TRACE) {
        store.geoSamples.splice(0, store.geoSamples.length - GEOMETRY_TRACE)
      }
      applyDockGeometry()
      const signature = dockSignature(next)
      if (signature === store.dockSignature) return
      store.dockSignature = signature
      notify()
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
          if (visible && bucketName === 'chat') {
            const flow = findFlow(node)
            if (flow) updateGeometry(flow)
          }
        }

        evaluate()
        presenceNudges.add(evaluate)
        const timer = setInterval(evaluate, PRESENCE_MS)
        return () => {
          presenceNudges.delete(evaluate)
          clearInterval(timer)
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

    // ------------------------------------------------- tab-strip indicator
    // The View tab row renders each label as plain text and offers no per-view
    // icon (`conversation.view` takes id/order/label only), so the port state is
    // painted as a CSS pseudo-element on the tab button after marking it with
    // `data-serial-state`. The label's text node is never touched.

    /** How often the tab may be re-marked while serial data is flowing. */
    const INDICATOR_MIN_MS = 250
    let indicatorStamp = 0

    /**
     * The single source of the dot's colour and its tooltip text: a poll error
     * means the host is unreachable and the snapshot it left behind is stale, so
     * it must not keep the dot green; a failed open leaves `connection.error` on
     * the snapshot, which is the only place the failure survives while the right
     * panel is closed.
     */
    function serialIndicator() {
      const connection = (store.snap && store.snap.connection) || {}
      const pollError = store.error ? String(store.error) : ''
      const connected = !pollError && isOpen(store.snap)
      const failure = pollError ? pollError : connected ? '' : String(connection.error || '')
      const state = failure ? 'err' : connected ? 'on' : 'off'
      const detail = connected
        ? `${translate('badgeOpen')} · ${connection.port || translate('port')} @ ${connection.baudRate || ''}`.trim()
        : failure
          ? `${translate('badgeError')}: ${failure.slice(0, 160)}`
          : translate('badgeClosed')
      return { state, detail }
    }

    /**
     * Mark the Serial tab. The tab button carries no view id, so it is found by
     * its label text inside the tab strip's `data-conversation-tabs` anchor: a
     * host that renames the anchor or the label just gets no dot, never a wrong
     * one. Called from the poll loop, so it also repairs the marking after React
     * remounts a tab.
     */
    function syncTabIndicator(force) {
      if (typeof document === 'undefined') return
      const now = Date.now()
      if (!force && now - indicatorStamp < INDICATOR_MIN_MS) return
      let matched = false
      try {
        const label = translate('tab')
        const { state, detail } = serialIndicator()
        for (const strip of document.querySelectorAll('[data-conversation-tabs]')) {
          for (const tab of strip.querySelectorAll('button[role="tab"]')) {
            if ((tab.textContent || '').trim() !== label) continue
            matched = true
            if (tab.dataset.serialState !== state) tab.dataset.serialState = state
            if (tab.title !== detail) tab.title = detail
          }
        }
      } catch {
        // A host that renders a different tab row must still keep the poller:
        // losing the dot is acceptable, losing the console is not.
      }
      // While the row is not mounted yet, retry on the next poll: the query is
      // cheap and the throttle would otherwise freeze a stale colour in place.
      if (matched) indicatorStamp = now
    }

    function SerialDrawer() {
      const { snap, entries, error } = useSerial()
      const logRef = React.useRef(null)
      const drawerRef = React.useRef(null)
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

      // The follow loop exists only for the drawer: while it is hidden there is
      // nothing to move, so nothing is measured.
      React.useEffect(() => {
        if (!allowed) return undefined
        scheduleMeasure(store.flowEl)
        return () => stopMeasure()
      }, [allowed])

      // Register the node so geometry frames can move it without a re-render.
      React.useLayoutEffect(() => {
        store.drawerEl = drawerRef.current
        applyDockGeometry()
        return () => {
          if (store.drawerEl === drawerRef.current) store.drawerEl = null
        }
      })

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
          { className: 'sc-drawer', ref: drawerRef, role: 'region', 'aria-label': translate('drawerTitle'), style },
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
              : recent.map((entry) => h(LogLine, { key: entry.id, entry, paint: store.paint })),
          ),
          error ? h('div', { className: 'sc-error' }, error) : null,
          h('div', { className: 'sc-drawer-foot' }, translate('drawerHint')),
        ),
      )
    }

    const moduleApi = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyle(document)
        translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }))
        ctx.effect(() => {
          startPolling()
          return () => stopPolling()
        })
        // Layout hints. The right document column animates with a CSS transition,
        // so `resize` alone is not enough: transition run/end marks the start and
        // the stop of the movement, and the follow loop covers the frames between.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          // Any of these hints means "the layout may have moved": the drawer
          // follows the column frame by frame, and the probes re-check whether
          // their view is still the one on screen.
          const kick = () => {
            scheduleMeasure(store.flowEl)
            nudgePresence()
          }
          window.addEventListener('resize', kick)
          window.addEventListener('focus', kick)
          document.addEventListener('visibilitychange', kick)
          document.addEventListener('transitionrun', kick, true)
          document.addEventListener('transitionend', kick, true)
          document.addEventListener('transitioncancel', kick, true)
          return () => {
            window.removeEventListener('resize', kick)
            window.removeEventListener('focus', kick)
            document.removeEventListener('visibilitychange', kick)
            document.removeEventListener('transitionrun', kick, true)
            document.removeEventListener('transitionend', kick, true)
            document.removeEventListener('transitioncancel', kick, true)
            stopMeasure()
          }
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

        // The right panel only exists while it can dock, so the Serial tab in
        // the View row carries the same dot at all times (see syncTabIndicator).

        mount(
          'shell.overlay',
          { name: 'shell.overlay', id: 'serial-drawer', order: 50, locale: NS, label: () => translate('drawerTitle') },
          SerialDrawer,
        )
      },
    }

    // Test hook: pure helpers only, exposed when a headless harness asks for
    // them. A browser never sets the flag, so the loader still sees exactly the
    // two fields it expects.
    if (globalThis.__DSH_SERIAL_TEST__) {
      moduleApi.__serialTest = {
        parseRuleWords,
        normalizeHex,
        buildPaint,
        paintText,
        colorOfLine,
        LEVEL_LINE,
        LEVEL_COLORS,
      }
    }

    return moduleApi
  },
})
