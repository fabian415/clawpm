/**
 * OpenClaw Gateway client — adapted from reference/meeting-app/backend.
 *
 * Protocol: WebSocket JSON-RPC
 *   send  → { type:'req', id, method, params }
 *   recv  → { type:'res', id, ok, payload } | { type:'event', event, payload }
 *
 * Auth flow: this client connects through the per-container TCP relay
 * (relay.cjs, listening on the "relay" port) rather than the gateway's own
 * port directly. The relay runs inside the container and forwards bytes to
 * the gateway over its own loopback, so the gateway sees a genuine local
 * connection. Combined with client.id='gateway-client'/mode='backend' and the
 * shared gateway token, this satisfies the gateway's local-backend bypass
 * (shouldSkipLocalBackendSelfPairing) and grants the requested operator
 * scopes directly — no device pairing needed.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { getUserPaths } from '../containers/WorkspaceManager.js'
import { getContainerConfig } from '../containers/DevicePairer.js'

const PROTOCOL_VERSION = 4
const CONNECT_CHALLENGE_TIMEOUT_MS = 5000
const DEFAULT_HISTORY_LIMIT = 200
const POLL_INTERVAL_MS = 300
const POLL_STABLE_COUNT = 2          // consecutive unchanged polls before declaring done
const POLL_TIMEOUT_MS = 120_000      // chat.send RPC call timeout
const FILE_WATCH_TIMEOUT_MS = 30 * 60 * 1000  // 30-min hard ceiling for JSONL watching
const FIRST_CONTENT_TIMEOUT_MS = 90_000       // give up if no assistant content after 90s

const dbg = (...a) => { if (process.env.DEBUG_LOGS) console.log(...a) }
const dbgErr = (...a) => { if (process.env.DEBUG_LOGS) console.error(...a) }
const dbgWarn = (...a) => { if (process.env.DEBUG_LOGS) console.warn(...a) }

// LLM stop reasons that indicate the turn is complete (normalized to lowercase)
const FINAL_STOP_REASONS = new Set(['stop', 'end_turn', 'max_tokens', 'length', 'stop_sequence', 'content_filter'])

function resolveClientPlatform() {
  const configured = process.env.OPENCLAW_GATEWAY_CLIENT_PLATFORM?.trim()
  if (configured) return configured

  // The gateway container always runs linux, even when this backend runs on macOS/Windows.
  return 'linux'
}

// gateway-client/backend identifies this as a trusted local backend. Combined with
// connecting through the relay (genuine loopback from the gateway's point of view),
// this makes the gateway skip device pairing and grant the requested scopes directly.
function buildConnectParams({ gatewayToken }) {
  const scopes = ['operator.read', 'operator.write', 'operator.approvals']
  const client = { id: 'gateway-client', version: '1.0.0', platform: resolveClientPlatform(), mode: 'backend' }

  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role: 'operator',
    scopes,
    locale: 'zh-TW',
    userAgent: `clawpm-backend/1.0.0`,
    auth: { token: gatewayToken },
  }
}

// ── Gateway client class ──────────────────────────────────────────────────────

class OpenClawGatewayClient {
  constructor(userId) {
    this.userId = userId
    this.socket = null
    this.connectPromise = null
    this.pending = new Map()
    this.isReady = false
    this.grantedScopes = []
  }

  async getGatewayUrl() {
    const config = await getContainerConfig(this.userId)
    if (!config?.relayPort) throw new Error('容器尚未就緒，無法取得 gateway 位址')
    // Connect through the in-container relay (not the gateway port directly) so the
    // gateway sees a genuine loopback connection — see buildConnectParams above.
    const host = process.env.OPENCLAW_GATEWAY_HOST || 'localhost'
    return `ws://${host}:${config.relayPort}`
  }

  async ensureConnected() {
    if (this.isReady && this.socket?.readyState === WebSocket.OPEN) {
      // Reconnect if the current connection lacks operator scopes (e.g. was
      // established before the gateway granted full scopes)
      if (!this.grantedScopes.includes('operator.write')) {
        console.log(`[OpenClaw] Reconnecting for user ${this.userId}: operator.write not in granted scopes`)
        this.disconnect()
      } else {
        return
      }
    }
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this._connect()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  async _connect() {
    const url = await this.getGatewayUrl()
    const config = await getContainerConfig(this.userId)

    if (!config?.gatewayToken?.trim()) {
      throw new Error('OpenClaw gateway token 尚未建立，請確認容器是否已完成初始化')
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const connectId = randomUUID()
      let settled = false
      let challengeTimer = null

      const cleanup = () => {
        ws.removeEventListener('message', onMessage)
        ws.removeEventListener('close', onClose)
        ws.removeEventListener('error', onError)
        if (challengeTimer) clearTimeout(challengeTimer)
      }

      const fail = (err) => {
        if (settled) return
        settled = true
        cleanup()
        try { ws.close() } catch {}
        reject(err)
      }

      const succeed = () => {
        if (settled) return
        settled = true
        cleanup()
        this.socket = ws
        this.isReady = true
        this._bindSocket(ws)
        resolve()
      }

      const sendConnect = () => {
        ws.send(JSON.stringify({
          type: 'req',
          id: connectId,
          method: 'connect',
          params: buildConnectParams({ gatewayToken: config.gatewayToken.trim() }),
        }))
      }

      const onMessage = (event) => {
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }

        if (packet?.type === 'event' && packet?.event === 'connect.challenge') {
          sendConnect()
          return
        }

        if (packet?.type === 'res' && packet?.id === connectId) {
          if (packet.ok) {
            this.grantedScopes = Array.isArray(packet?.payload?.auth?.scopes)
              ? packet.payload.auth.scopes.filter(s => typeof s === 'string' && s.trim())
              : []
            console.log(`[OpenClaw] Connected for user ${this.userId}, scopes: ${this.grantedScopes.join(', ') || 'none'}`)
            succeed()
          } else {
            fail(new Error(packet?.error?.message || 'OpenClaw Gateway connect failed'))
          }
        }
      }

      const onClose = () => fail(new Error('OpenClaw Gateway 連線在握手期間中斷'))
      const onError = (e) => fail(new Error(`OpenClaw Gateway 連線錯誤: ${e.message || ''}`))

      ws.addEventListener('message', onMessage)
      ws.addEventListener('close', onClose)
      ws.addEventListener('error', onError)
      ws.addEventListener('open', () => {
        challengeTimer = setTimeout(() => {
          if (!settled) fail(new Error('OpenClaw Gateway connect challenge 逾時'))
        }, CONNECT_CHALLENGE_TIMEOUT_MS)
      }, { once: true })
    })
  }

  _bindSocket(ws) {
    ws.addEventListener('message', (event) => {
      let packet
      try { packet = JSON.parse(String(event.data)) } catch { return }

      if (packet?.type === 'res' && packet?.id) {
        const pending = this.pending.get(packet.id)
        if (!pending) return
        this.pending.delete(packet.id)
        clearTimeout(pending.timer)
        if (packet.ok) pending.resolve(packet.payload)
        else pending.reject(new Error(packet?.error?.message || `${pending.method} failed`))
      }
    })

    ws.addEventListener('close', () => {
      this.isReady = false
      this.socket = null
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('OpenClaw Gateway 連線中斷'))
      }
      this.pending.clear()
      this.grantedScopes = []
    })

    ws.addEventListener('error', () => { this.isReady = false })
  }

  async call(method, params = {}, timeoutMs = 30_000) {
    await this.ensureConnected()
    try {
      return await this._call(method, params, timeoutMs)
    } catch (err) {
      // If the gateway rejects due to missing scope, force reconnect once
      if (err.message?.includes('missing scope')) {
        console.log(`[OpenClaw] Scope error on ${method}, forcing reconnect…`)
        this.disconnect()
        await this.ensureConnected()
        return this._call(method, params, timeoutMs)
      }
      throw err
    }
  }

  async _call(method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 逾時`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.socket.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  disconnect() {
    this.isReady = false
    try { this.socket?.close() } catch {}
    this.socket = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('client disconnected'))
    }
    this.pending.clear()
  }
}

// ── Per-user client cache ─────────────────────────────────────────────────────

const clientCache = new Map()

export function getClientForUser(provisionUserId) {
  if (!clientCache.has(provisionUserId)) {
    clientCache.set(provisionUserId, new OpenClawGatewayClient(provisionUserId))
  }
  return clientCache.get(provisionUserId)
}

export function disconnectClientForUser(provisionUserId) {
  const client = clientCache.get(provisionUserId)
  if (client) {
    client.disconnect()
    clientCache.delete(provisionUserId)
  }
}

// ── Message normalization ─────────────────────────────────────────────────────

function pickText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item
      if (typeof item?.text === 'string') return item.text
      if (typeof item?.content === 'string') return item.content
      return ''
    }).filter(Boolean).join('\n')
  }
  if (value && typeof value === 'object') {
    return pickText(value.text || value.content || value.body || value.message || value.output || '')
  }
  return ''
}

function normalizeRole(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function isProcessRole(role) {
  return ['tool', 'toolresult', 'function', 'functionresult'].includes(role)
}

function isThoughtEntry(entry) {
  const hints = [
    entry?.kind, entry?.type, entry?.channel, entry?.category,
    entry?.message?.kind, entry?.message?.type,
  ].map(v => typeof v === 'string' ? v.trim().toLowerCase() : '').filter(Boolean)
  const thoughtTypes = new Set(['thinking', 'thought', 'reasoning', 'analysis', 'internal_reasoning'])
  return hints.some(h => thoughtTypes.has(h))
}

function isInternalNotice(content) {
  if (typeof content !== 'string') return false
  const v = content.trim()
  return /^System(?:\s*\([^)]*\))?:/i.test(v)
    || /^An async command you ran earlier/i.test(v)
    || v.includes('Do not relay it to the user unless explicitly requested.')
}

export function normalizeHistory(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.messages || payload?.entries || []

  return list
    .map((entry, i) => {
      const rawRole = entry?.role || entry?.kind || 'assistant'
      const role = normalizeRole(rawRole)
      const content = pickText(entry?.content || entry?.text || entry?.body || entry?.message || '')
      const isThought = isThoughtEntry(entry)
      const isProcess = isProcessRole(role) || isInternalNotice(content)

      return {
        id: entry?.id || entry?.messageId || `msg-${i}`,
        role,
        content,
        timestamp: entry?.createdAt || entry?.ts || entry?.timestamp || null,
        isThought,
        isProcess,
      }
    })
    .filter(m => m.content && !isInternalNotice(m.content))
}

// ── Session JSONL file helpers ────────────────────────────────────────────────

function getSessionsDir(userId) {
  return path.join(getUserPaths(userId).config, 'agents', 'main', 'sessions')
}

function findSessionJsonlFile(sessionsDir, sessionKey) {
  const indexPath = path.join(sessionsDir, 'sessions.json')
  if (!fs.existsSync(indexPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    let entries = Array.isArray(raw) ? raw
      : Array.isArray(raw?.sessions) ? raw.sessions
      : Object.entries(raw).map(([k, v]) => ({
          key: k,
          id: typeof v === 'string' ? v : (v?.id || v?.sessionId),
        }))
    const found = entries.find(s => s.key === sessionKey || s.sessionKey === sessionKey)
    const id = found?.id || found?.sessionId
    if (!id) return null
    const candidate = path.join(sessionsDir, `${id}.jsonl`)
    return fs.existsSync(candidate) ? candidate : null
  } catch { return null }
}

async function resolveSessionJsonlFile(sessionsDir, sessionKey) {
  let found = findSessionJsonlFile(sessionsDir, sessionKey)
  if (found) return found
  // For new sessions the file is created after chat.send — poll up to 5s
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500))
    found = findSessionJsonlFile(sessionsDir, sessionKey)
    if (found) return found
  }
  return null
}

// ── JSONL line parser ─────────────────────────────────────────────────────────

function parseJsonlMsgLine(line) {
  try {
    const obj = JSON.parse(line.trim())
    if (!obj) return null
    // Primary format: { message: { role, content, stopReason }, id, timestamp, ... }
    // Fallback format: { role, content, id, timestamp }
    const msg = (obj.message && typeof obj.message === 'object') ? obj.message : obj
    const rawRole = msg?.role || ''
    const role = normalizeRole(rawRole)
    if (!role) return null
    const content = pickText(msg?.content ?? msg?.text ?? '')
    const id = obj.id ?? msg?.id ?? null
    const name = msg?.toolName ?? msg?.name ?? msg?.function?.name ?? null
    const isError = msg?.isError ?? false
    const isThought = isThoughtEntry(obj) || isThoughtEntry(msg)
    const isProcess = isProcessRole(role) || isInternalNotice(content)
    // stopReason:"stop" = LLM finished naturally (no more tool calls)
    // stopReason:"toolUse"/"tool_calls" = still mid-task
    const stopReason = msg?.stopReason ?? obj?.stopReason ?? null
    return { id, role, name, content, isError, timestamp: obj.timestamp ?? null, isThought, isProcess, stopReason }
  } catch { return null }
}

// ── File-based streaming (primary) ───────────────────────────────────────────

async function _streamFromFile({ watchFile, fileBaseline, prevIdSet, onUpdate }) {
  // Wait up to 5s for file to appear on new sessions
  if (!fs.existsSync(watchFile)) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (fs.existsSync(watchFile)) break
    }
  }

  return new Promise((resolve) => {
    let filePos = fileBaseline
    let lastAssistantMsg = null
    let processEntries = []
    let finishTimer = null
    let pollTimer = null
    let watcher = null
    let finished = false
    let firstContentTimer = null

    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(finishTimer)
      clearTimeout(firstContentTimer)
      clearInterval(pollTimer)
      try { watcher?.close() } catch {}
      if (lastAssistantMsg) {
        onUpdate({ lastAssistantMsg, processEntries, done: true })
      } else {
        // Timed out with no content — signal done so callers can surface an error.
        onUpdate({ lastAssistantMsg: null, processEntries, done: true })
      }
      resolve()
    }

    // Schedule finish with a small flush delay so any last JSONL writes can land.
    const scheduleFinish = (delayMs = 300) => {
      if (finished) return
      clearTimeout(finishTimer)
      finishTimer = setTimeout(() => { readNewContent(); finish() }, delayMs)
    }

    // If no assistant content appears within FIRST_CONTENT_TIMEOUT_MS, give up.
    firstContentTimer = setTimeout(() => {
      if (!lastAssistantMsg && !finished) {
        dbgWarn(`[streamFromFile] no content after ${FIRST_CONTENT_TIMEOUT_MS/1000}s, giving up. watchFile=${watchFile}`)
        finish()
      }
    }, FIRST_CONTENT_TIMEOUT_MS)

    const readNewContent = () => {
      if (finished || !fs.existsSync(watchFile)) return
      let stat
      try { stat = fs.statSync(watchFile) } catch { return }
      if (stat.size <= filePos) return

      try {
        const len = stat.size - filePos
        const buf = Buffer.alloc(len)
        const fd = fs.openSync(watchFile, 'r')
        fs.readSync(fd, buf, 0, len, filePos)
        fs.closeSync(fd)

        const rawText = buf.toString('utf8')
        // Only parse up to the last complete newline — partial JSON line stays for next read.
        const lastNl = rawText.lastIndexOf('\n')
        if (lastNl < 0) return

        const completeText = rawText.slice(0, lastNl + 1)
        filePos += Buffer.byteLength(completeText, 'utf8')

        for (const line of completeText.split('\n')) {
          if (!line.trim()) continue
          const msg = parseJsonlMsgLine(line)
          if (!msg) continue
          if (msg.isThought || isInternalNotice(msg.content)) continue

          if (msg.role === 'assistant' && !prevIdSet.has(msg.id)) {
            if (msg.content) {
              // First content received — cancel the no-response timeout.
              clearTimeout(firstContentTimer)
              firstContentTimer = null
              dbg(`[streamFromFile] got assistant content (${msg.content.length} chars), stopReason=${msg.stopReason}`)
              lastAssistantMsg = msg
              onUpdate({ lastAssistantMsg: msg, processEntries, done: false })
            }
            // Finish when LLM signals natural end (covers OpenAI, Anthropic, Azure, Gemini).
            // stopReason:"toolUse"/"tool_calls" = mid-task, more turns coming — skip.
            if (msg.stopReason && FINAL_STOP_REASONS.has(msg.stopReason.toLowerCase())) {
              scheduleFinish(300)
            }
          } else if (msg.isProcess) {
            dbg(`[streamFromFile] process entry: role=${msg.role} name=${msg.name} contentLen=${msg.content?.length ?? 0}`)
            processEntries = [...processEntries, msg]
            onUpdate({ lastAssistantMsg, processEntries, done: false })
          }
        }
      } catch {}
    }

    // fs.watch for immediate events; 500ms poll as Docker-volume fallback
    try { watcher = fs.watch(watchFile, { persistent: false }, readNewContent) } catch {}
    pollTimer = setInterval(readNewContent, 500)

    // Hard overall timeout (separate from chat.send RPC timeout)
    setTimeout(finish, FILE_WATCH_TIMEOUT_MS)

    // Immediate read
    readNewContent()
  })
}

// ── Gateway-polling fallback (when JSONL file cannot be found) ────────────────

async function _streamFromPolling({ client, sessionKey, prevMessages, prevIdSet, onUpdate }) {
  const startedAt = Date.now()
  let prevContentSig = conversationSignature(prevMessages)
  let stableCount = 0

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    let current
    try { current = await getHistory(client, sessionKey) } catch { continue }

    const currentSig = conversationSignature(current)
    const newMessages = current.filter(m => !prevIdSet.has(m.id))
    const lastAssistantMsg = getLastNewAssistantEntry(current, prevIdSet)
    const processEntries = newMessages.filter(m => m.isProcess && !m.isThought)

    if (currentSig !== prevContentSig) {
      prevContentSig = currentSig
      stableCount = 0
      onUpdate({ lastAssistantMsg, processEntries, done: false })
    } else {
      stableCount++
      if (lastAssistantMsg && stableCount >= POLL_STABLE_COUNT) {
        onUpdate({ lastAssistantMsg, processEntries, done: true })
        break
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getDefaultSessionKey() {
  return 'agent:main:main'
}

export function makeScopedSessionKey(scope = 'chat') {
  const safe = String(scope).replace(/[^a-zA-Z0-9_-]/g, '-')
  return `agent:main:${safe}:${Date.now()}-${randomUUID().slice(0, 8)}`
}

export async function getHistory(client, sessionKey) {
  const payload = await client.call('chat.history', {
    sessionKey,
    limit: DEFAULT_HISTORY_LIMIT,
  })
  return normalizeHistory(payload)
}

function conversationSignature(messages) {
  return messages.map(m => `${m.role}:${m.content}`).join('|')
}

function getLastNewAssistantEntry(messages, prevIdSet) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!prevIdSet.has(m.id) && m.role === 'assistant' && !m.isThought && !m.isProcess && m.content) {
      return m
    }
  }
  return null
}

/**
 * Send a message and stream incremental updates via onUpdate callback.
 *
 * Primary path: directly reads the session JSONL file for correct, real-time content.
 * Fallback: gateway chat.history polling (when JSONL file cannot be resolved).
 *
 * onUpdate({ lastAssistantMsg, processEntries, done })
 */
export async function sendAndStream(client, sessionKey, userMessage, onUpdate) {
  const sessionsDir = getSessionsDir(client.userId)
  const prevMessages = await getHistory(client, sessionKey).catch(() => [])
  const prevIdSet = new Set(prevMessages.map(m => m.id))
  dbg(`[sendAndStream] user=${client.userId} session=${sessionKey} prevMsgs=${prevMessages.length}`)

  // Snapshot file offset before sending so we only read NEW content
  let watchFile = findSessionJsonlFile(sessionsDir, sessionKey)
  let fileBaseline = 0
  if (watchFile && fs.existsSync(watchFile)) {
    fileBaseline = fs.statSync(watchFile).size
    dbg(`[sendAndStream] watchFile=${watchFile} baseline=${fileBaseline}`)
  } else {
    dbg(`[sendAndStream] no existing JSONL yet, sessionsDir=${sessionsDir}`)
  }

  dbg(`[sendAndStream] calling chat.send ...`)
  try {
    await client.call('chat.send', {
      sessionKey,
      message: userMessage,
      idempotencyKey: randomUUID(),
    }, POLL_TIMEOUT_MS)
    dbg(`[sendAndStream] chat.send returned OK`)
  } catch (err) {
    dbgErr(`[sendAndStream] chat.send FAILED: ${err.message}`)
    throw err
  }

  // For new sessions the file didn't exist yet — try to resolve it now
  if (!watchFile) {
    watchFile = await resolveSessionJsonlFile(sessionsDir, sessionKey)
    dbg(`[sendAndStream] resolved watchFile=${watchFile}`)
  }

  if (watchFile) {
    dbg(`[sendAndStream] streaming from file: ${watchFile}`)
    return _streamFromFile({ watchFile, fileBaseline, prevIdSet, onUpdate })
  }

  dbgWarn(`[sendAndStream] JSONL file not found for session ${sessionKey}, falling back to polling`)
  return _streamFromPolling({ client, sessionKey, prevMessages, prevIdSet, onUpdate })
}

/**
 * Passively watch a session's JSONL file for new entries written by an external
 * process (e.g. another OpenClaw client). Calls onUpdate() with the same
 * { lastAssistantMsg, processEntries, done } shape as sendAndStream.
 *
 * Returns a stop() function. The watcher runs until stop() is called.
 */
export function startPassiveSessionWatcher(userId, sessionKey, onUpdate) {
  const sessionsDir = getSessionsDir(userId)
  let watchFile = findSessionJsonlFile(sessionsDir, sessionKey)

  let filePos = 0
  if (watchFile && fs.existsSync(watchFile)) {
    filePos = fs.statSync(watchFile).size
  }

  let stopped = false
  let watcher = null
  let pollTimer = null
  let processEntries = []
  let lastAssistantMsg = null
  const prevIdSet = new Set()

  const readNewContent = () => {
    if (stopped) return

    if (!watchFile) {
      watchFile = findSessionJsonlFile(sessionsDir, sessionKey)
      if (!watchFile) return
      filePos = 0
    }

    if (!fs.existsSync(watchFile)) return
    let stat
    try { stat = fs.statSync(watchFile) } catch { return }
    if (stat.size <= filePos) return

    try {
      const len = stat.size - filePos
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(watchFile, 'r')
      fs.readSync(fd, buf, 0, len, filePos)
      fs.closeSync(fd)

      const rawText = buf.toString('utf8')
      const lastNl = rawText.lastIndexOf('\n')
      if (lastNl < 0) return

      const completeText = rawText.slice(0, lastNl + 1)
      filePos += Buffer.byteLength(completeText, 'utf8')

      for (const line of completeText.split('\n')) {
        if (!line.trim()) continue
        const msg = parseJsonlMsgLine(line)
        if (!msg) continue
        if (msg.isThought || isInternalNotice(msg.content)) continue

        if (msg.role === 'assistant' && !prevIdSet.has(msg.id)) {
          prevIdSet.add(msg.id)
          if (msg.content) {
            lastAssistantMsg = msg
            onUpdate({ lastAssistantMsg: msg, processEntries, done: false })
          }
          if (msg.stopReason && FINAL_STOP_REASONS.has(msg.stopReason.toLowerCase())) {
            setTimeout(() => {
              if (!stopped) {
                onUpdate({ lastAssistantMsg, processEntries, done: true })
                lastAssistantMsg = null
                processEntries = []
              }
            }, 300)
          }
        } else if (msg.isProcess) {
          processEntries = [...processEntries, msg]
          onUpdate({ lastAssistantMsg, processEntries, done: false })
        }
      }
    } catch {}
  }

  try { watcher = fs.watch(watchFile || sessionsDir, { persistent: false }, readNewContent) } catch {}
  pollTimer = setInterval(readNewContent, 500)

  return function stop() {
    stopped = true
    try { watcher?.close() } catch {}
    clearInterval(pollTimer)
  }
}
