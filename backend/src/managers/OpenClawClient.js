/**
 * OpenClaw Gateway client — adapted from reference/meeting-app/backend.
 *
 * Protocol: WebSocket JSON-RPC
 *   send  → { type:'req', id, method, params }
 *   recv  → { type:'res', id, ok, payload } | { type:'event', event, payload }
 *
 * Auth flow: gateway sends connect.challenge → client replies with signed connect.
 */

import { createPrivateKey, createPublicKey, randomUUID, sign as signPayload } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { getUserPaths } from '../containers/WorkspaceManager.js'
import { getContainerConfig, pairDevice } from '../containers/DevicePairer.js'

const PROTOCOL_VERSION = 3
const CONNECT_CHALLENGE_TIMEOUT_MS = 5000
const DEFAULT_HISTORY_LIMIT = 200
const POLL_INTERVAL_MS = 800
const POLL_STABLE_COUNT = 2          // consecutive unchanged polls before declaring done
const POLL_TIMEOUT_MS = 120_000
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function resolveClientPlatform() {
  const configured = process.env.OPENCLAW_GATEWAY_CLIENT_PLATFORM?.trim()
  if (configured) return configured

  // The approved device identity is generated inside the OpenClaw container,
  // so its registered platform is linux even when this backend runs on macOS.
  return 'linux'
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function publicKeyRawBase64UrlFromPem(pem) {
  const key = createPublicKey(pem)
  const spki = key.export({ type: 'spki', format: 'der' })
  if (
    Buffer.isBuffer(spki)
    && spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return base64UrlEncode(spki.subarray(ED25519_SPKI_PREFIX.length))
  }
  return base64UrlEncode(Buffer.from(spki))
}

function signDevicePayload(privateKeyPem, payload) {
  const key = createPrivateKey(privateKeyPem)
  const signature = signPayload(null, Buffer.from(payload, 'utf8'), key)
  return base64UrlEncode(signature)
}

function buildDeviceAuthPayloadV3({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform }) {
  return [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token ?? '',
    nonce,
    (typeof platform === 'string' && platform.trim() ? platform.trim().toLowerCase() : ''),
    '',  // deviceFamily
  ].join('|')
}

// ── Identity / auth helpers ───────────────────────────────────────────────────

function loadDeviceIdentity(userId) {
  const paths = getUserPaths(userId)
  const identityFiles = [
    path.join(paths.identity, 'device.json'),
    path.join(paths.base, 'identity', 'device.json'), // legacy pre-mount-fix path
  ]

  for (const identityFile of identityFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(identityFile, 'utf8'))
      if (
        typeof parsed?.deviceId === 'string'
        && typeof parsed?.publicKeyPem === 'string'
        && typeof parsed?.privateKeyPem === 'string'
      ) {
        return parsed
      }
    }
    catch {}
  }
  return null
}

async function ensureOperatorCredentials(userId) {
  let config = getContainerConfig(userId)
  let identity = loadDeviceIdentity(userId)

  if (config?.operatorToken?.trim() && identity) {
    return { config, identity }
  }

  if (identity && config?.gatewayToken?.trim()) {
    console.log(`[OpenClaw] Pairing device for user ${userId}: operator token missing`)
    await pairDevice(userId, { healthTimeoutMs: 30_000 })
    config = getContainerConfig(userId)
    identity = loadDeviceIdentity(userId)
  }

  return { config, identity }
}

function buildConnectParams({ nonce, config, identity, userId }) {
  const operatorToken = config.operatorToken?.trim() || null
  const gatewayToken = config.gatewayToken?.trim() || null
  const scopes = ['operator.read', 'operator.write', 'operator.approvals']
  const client = { id: 'cli', version: '1.0.0', platform: resolveClientPlatform(), mode: 'cli' }

  const params = {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role: 'operator',
    scopes,
    locale: 'zh-TW',
    userAgent: `clawpm-backend/1.0.0`,
  }

  // operatorToken = device token (higher privilege), fallback to shared gateway token
  if (operatorToken) {
    params.auth = { deviceToken: operatorToken }
  } else if (gatewayToken) {
    params.auth = { token: gatewayToken }
  }

  // Keep signatureToken for device signing below
  const signatureToken = operatorToken || gatewayToken

  if (nonce && identity) {
    const signedAtMs = Date.now()
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role: 'operator',
      scopes,
      signedAtMs,
      token: signatureToken,
      nonce,
      platform: client.platform,
    })

    params.device = {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce,
    }
  }

  return params
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

  get gatewayUrl() {
    const config = getContainerConfig(this.userId)
    if (!config?.gatewayPort) throw new Error('容器尚未就緒，無法取得 gateway 位址')
    return `ws://localhost:${config.gatewayPort}`
  }

  async ensureConnected() {
    if (this.isReady && this.socket?.readyState === WebSocket.OPEN) {
      // Reconnect if the current connection lacks operator scopes (e.g. was
      // established before device pairing completed)
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
    const url = this.gatewayUrl
    const { config, identity } = await ensureOperatorCredentials(this.userId)

    if (!config?.operatorToken?.trim()) {
      throw new Error('OpenClaw operator token 尚未建立，請先完成 device pairing 或重新啟動容器配對流程')
    }
    if (!identity) {
      throw new Error('OpenClaw device identity 不存在，請確認 gateway 已產生 config/identity/device.json')
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const connectId = randomUUID()
      let settled = false
      let connectNonce = null
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
        if (!connectNonce) {
          fail(new Error('OpenClaw Gateway: connect challenge missing nonce'))
          return
        }
        ws.send(JSON.stringify({
          type: 'req',
          id: connectId,
          method: 'connect',
          params: buildConnectParams({ nonce: connectNonce, config, identity, userId: this.userId }),
        }))
      }

      const onMessage = (event) => {
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }

        if (packet?.type === 'event' && packet?.event === 'connect.challenge') {
          connectNonce = typeof packet?.payload?.nonce === 'string'
            ? packet.payload.nonce.trim() || null
            : null
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
      // If the gateway rejects due to missing scope, force reconnect once with
      // fresh credentials (operatorToken may have been added since last connect)
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
 * Resolves when the assistant has finished replying.
 *
 * onUpdate receives { lastAssistantMsg, processEntries, done }
 *   lastAssistantMsg — the most-recent new assistant message {id, content, …}, or null
 *   processEntries   — all new tool/process entries since the send
 *   done             — true on final stable call
 */
export async function sendAndStream(client, sessionKey, userMessage, onUpdate) {
  const prevMessages = await getHistory(client, sessionKey).catch(() => [])
  const prevSig = conversationSignature(prevMessages)
  const prevIdSet = new Set(prevMessages.map(m => m.id))

  await client.call('chat.send', {
    sessionKey,
    message: userMessage,
    idempotencyKey: randomUUID(),
  }, POLL_TIMEOUT_MS)

  const startedAt = Date.now()
  let prevContentSig = prevSig
  let stableCount = 0
  let latestMessages = prevMessages

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    let current
    try {
      current = await getHistory(client, sessionKey)
    } catch {
      continue
    }

    const currentSig = conversationSignature(current)
    const newMessages = current.filter(m => !prevIdSet.has(m.id))
    const lastAssistantMsg = getLastNewAssistantEntry(current, prevIdSet)
    const processEntries = newMessages.filter(m => m.isProcess && !m.isThought)

    if (currentSig !== prevContentSig) {
      prevContentSig = currentSig
      latestMessages = current
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

  return latestMessages
}
