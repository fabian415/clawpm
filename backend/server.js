import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { register, login, verifyToken, getUserById, completeSetup, resetSetup } from './src/managers/UserManager.js'
import { getHistory as getChatHistory, appendMessage, createMessage } from './src/managers/ChatManager.js'
import {
  getClientForUser, disconnectClientForUser,
  getDefaultSessionKey, makeScopedSessionKey,
  sendAndStream, getHistory as getGatewayHistory,
  normalizeHistory,
} from './src/managers/OpenClawClient.js'
import { allocatePorts, releasePorts, getPortsForUser } from './src/containers/PortManager.js'
import { initializeWorkspace } from './src/containers/WorkspaceManager.js'
import {
  createAndStartContainer,
  getContainerStatus,
  startContainer,
  stopContainer,
  destroyContainer,
  imageExists,
  pullImage,
} from './src/containers/ContainerManager.js'
import {
  pairDevice,
  saveContainerConfig,
  getContainerConfig,
  deleteContainerConfig,
} from './src/containers/DevicePairer.js'
import { getUserPaths } from './src/containers/WorkspaceManager.js'

dotenv.config()

const app = express()
const PORT = process.env.API_PORT || 3000
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'
const OPENCLAW_VERSION = OPENCLAW_IMAGE.split(':').pop() || '2026.4.22'

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true
}))
app.use(express.json())

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) {
    return res.status(400).json({ error: '請填寫電子郵件與密碼' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少需要 6 個字元' })
  }
  try {
    const result = await register(email, password)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) {
    return res.status(400).json({ error: '請填寫電子郵件與密碼' })
  }
  try {
    const result = await login(email, password)
    res.json(result)
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true })
})

function requireAuth(req, res, next) {
  const auth = req.headers.authorization ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: '未授權' })
  try {
    req.user = verifyToken(token)
    next()
  } catch {
    res.status(401).json({ error: 'Token 無效或已過期' })
  }
}

app.get('/api/user/me', requireAuth, (req, res) => {
  const user = getUserById(req.user.userId)
  if (!user) return res.status(404).json({ error: '用戶不存在' })
  res.json(user)
})

app.patch('/api/user/setup', requireAuth, (req, res) => {
  const { provider, apiKey, baseUrl, model, workspaceFolder } = req.body ?? {}
  if (!provider || !apiKey || !model || !workspaceFolder) {
    return res.status(400).json({ error: '缺少必要的設定欄位' })
  }
  try {
    const user = completeSetup(req.user.userId, { provider, apiKey, baseUrl, model, workspaceFolder })
    res.json(user)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── Chat history REST endpoint ────────────────────────────────────────────────

app.get('/api/chat/history', requireAuth, (req, res) => {
  const history = getChatHistory(req.user.userId)
  res.json({ messages: history })
})

// ── Provision helpers ─────────────────────────────────────────────────────────

function buildOpenClawConfig(gatewayToken, llmConfig, { hostPort } = {}) {
  const allowedOrigins = [
    'http://localhost:18789',
    'http://127.0.0.1:18789',
  ]
  if (hostPort && hostPort !== 18789) {
    allowedOrigins.push(`http://localhost:${hostPort}`)
    allowedOrigins.push(`http://127.0.0.1:${hostPort}`)
  }

  const gateway = {
    mode: 'local',
    auth: { mode: 'token', token: gatewayToken },
    port: 18789,
    bind: 'lan',
    tailscale: { mode: 'off', resetOnExit: false },
    controlUi: { allowInsecureAuth: true, allowedOrigins },
    nodes: {
      denyCommands: [
        'camera.snap', 'camera.clip', 'screen.record',
        'contacts.add', 'calendar.add', 'reminders.add',
        'sms.send', 'sms.search',
      ],
    },
  }

  if (llmConfig.provider === 'gemini') {
    return {
      agents: {
        defaults: {
          workspace: '/home/node/.openclaw/workspace',
          sandbox: { mode: 'off' },
          models: { 'google/gemini-2.5-flash': {} },
          model: { primary: 'google/gemini-2.5-flash' },
        },
      },
      gateway,
      session: { dmScope: 'per-channel-peer' },
      tools: { profile: 'coding' },
      plugins: {
        entries: {
          google: { enabled: true },
        },
      },
      meta: {
        lastTouchedVersion: OPENCLAW_VERSION,
        lastTouchedAt: new Date().toISOString(),
      },
    }
  }

  const { baseUrl, apiKey, modelId } = llmConfig
  const modelRef = `custom/${modelId}`
  return {
    agents: {
      defaults: {
        workspace: '/home/node/.openclaw/workspace',
        model: { primary: modelRef },
        models: { [modelRef]: {} },
      },
    },
    models: {
      mode: 'merge',
      providers: {
        custom: {
          baseUrl,
          apiKey,
          api: 'openai-completions',
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    gateway,
    session: { dmScope: 'per-channel-peer' },
    tools: { profile: 'coding' },
    meta: {
      lastTouchedVersion: OPENCLAW_VERSION,
      lastTouchedAt: new Date().toISOString(),
    },
  }
}

function applyEnvKey(envPath, key, value) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const line = `${key}=${value}`
  const regex = new RegExp(`^${key}=.*$`, 'm')
  content = regex.test(content) ? content.replace(regex, line) : content + `\n${line}`
  fs.writeFileSync(envPath, content, 'utf8')
}

function getProvisionUserId(authUserId) {
  const user = getUserById(authUserId)
  return user?.setupConfig?.workspaceFolder || authUserId
}

function readGatewayToken(paths) {
  try {
    const raw = fs.readFileSync(paths.openclawJson, 'utf8')
    return JSON.parse(raw)?.gateway?.auth?.token || null
  } catch {
    return null
  }
}

// ── Provision routes ──────────────────────────────────────────────────────────

app.get('/api/provision/check-userid/:userId', requireAuth, (req, res) => {
  const { userId } = req.params
  if (!/^[\w-]+$/.test(userId)) {
    return res.json({ available: false, reason: '格式不正確，只允許英文字母、數字、連字號與底線' })
  }
  const taken = !!(getContainerConfig(userId) || getPortsForUser(userId))
  res.json({ available: !taken, reason: taken ? '此 ID 已被使用' : null })
})

app.post('/api/provision', requireAuth, async (req, res) => {
  const { userId, provider, geminiApiKey, baseUrl, apiKey, modelId } = req.body ?? {}

  if (!userId || !/^[\w-]+$/.test(userId)) {
    return res.status(400).json({ error: '無效的 userId' })
  }
  if (!provider || !['gemini', 'custom'].includes(provider)) {
    return res.status(400).json({ error: '無效的 provider' })
  }
  if (provider === 'gemini' && !geminiApiKey) {
    return res.status(400).json({ error: '缺少 Gemini API Key' })
  }
  if (provider === 'custom' && (!baseUrl || !apiKey || !modelId)) {
    return res.status(400).json({ error: '缺少 Custom provider 設定' })
  }
  if (getContainerConfig(userId) || getPortsForUser(userId)) {
    return res.status(409).json({ error: `userId "${userId}" 已被使用` })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const send = (type, text) => res.write(`data: ${JSON.stringify({ type, text })}\n\n`)

  const llmConfig = provider === 'gemini'
    ? { provider: 'gemini', geminiApiKey }
    : { provider: 'custom', baseUrl, apiKey, modelId }

  try {
    // 1. Allocate ports
    send('info', 'Allocating ports...')
    const ports = allocatePorts(userId)
    send('success', `Ports allocated — gateway: ${ports.gatewayPort}, bridge: ${ports.bridgePort}`)

    // 2. Initialize workspace
    send('info', 'Initializing workspace...')
    const { paths, gatewayToken, skillsCopied, warnings } = initializeWorkspace(userId, { hostPort: ports.gatewayPort })
    send('success', `Workspace ready: ${paths.base}`)
    send('success', `Gateway token: ${gatewayToken.slice(0, 8)}...`)
    if (skillsCopied.length > 0) send('success', `Skills copied: ${skillsCopied.join(', ')}`)
    for (const w of warnings) send('warn', w)

    // 3. Write openclaw.json
    const cfg = buildOpenClawConfig(gatewayToken, llmConfig, { hostPort: ports.gatewayPort })
    fs.writeFileSync(paths.openclawJson, JSON.stringify(cfg, null, 2), 'utf8')
    if (provider === 'gemini') {
      send('success', 'LLM provider: Gemini (google/gemini-2.5-flash)')
      applyEnvKey(path.join(paths.config, '.env'), 'GEMINI_API_KEY', geminiApiKey)
      send('success', 'GEMINI_API_KEY written to config/.env')
    } else {
      send('success', `LLM provider: Custom (custom/${modelId}) → ${baseUrl}`)
    }

    // 4. Check if container already exists
    const existing = await getContainerStatus(userId)
    if (existing.exists) {
      send('warn', `Container already exists (${existing.status}). Skipping create.`)
      if (!existing.running) {
        send('info', 'Starting existing container...')
        await startContainer(userId)
        send('success', 'Container started.')
      }
    } else {
      // 5. Check image
      const image = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'
      send('info', `Checking for image: ${image}`)
      const hasImage = await imageExists()
      if (!hasImage) {
        send('warn', 'Image not found locally. Pulling from registry...')
        await pullImage((event) => {
          if (event.status && event.id) send('normal', `  ${event.status}: ${event.id}`)
          else if (event.status) send('normal', `  ${event.status}`)
        })
        send('success', 'Image pulled.')
      } else {
        send('success', 'Image found locally.')
      }

      // 6. Create and start container
      send('info', 'Creating and starting container...')
      const containerId = await createAndStartContainer(userId, {
        gatewayPort: ports.gatewayPort,
        bridgePort: ports.bridgePort,
        workspaceDir: paths.workspace,
        configDir: paths.config,
        gatewayToken,
      })
      send('success', `Container started: ${containerId.slice(0, 12)}`)

      saveContainerConfig(userId, {
        containerId,
        gatewayPort: ports.gatewayPort,
        bridgePort: ports.bridgePort,
        gatewayToken,
        workspacePath: paths.workspace,
        provisionedAt: new Date().toISOString(),
      })
    }

    // 7. Device pairing
    send('info', 'Starting device pairing (waiting for healthy gateway)...')
    try {
      const { deviceId, operatorToken } = await pairDevice(userId, { healthTimeoutMs: 90_000 })
      send('success', `Device paired — ID: ${deviceId.slice(0, 16)}...`)
      send('success', `Operator token: ${operatorToken.slice(0, 8)}...`)
    } catch (err) {
      send('warn', `Device pairing failed (可稍後重試)`)
      send('warn', `  Reason: ${err.message}`)
    }

    // 8. Link auth user → workspace so getProvisionUserId resolves correctly
    try {
      completeSetup(req.user.userId, {
        provider,
        apiKey: provider === 'gemini' ? geminiApiKey : (apiKey ?? ''),
        baseUrl: baseUrl ?? null,
        model: provider === 'gemini' ? 'google/gemini-2.5-flash' : (modelId ?? ''),
        workspaceFolder: userId,
      })
    } catch (e) {
      console.warn('[provision] Could not link user to workspace:', e.message)
    }

    // Done
    const finalStatus = await getContainerStatus(userId)
    const savedConfig = getContainerConfig(userId)
    const gatewayPort = finalStatus.gatewayPort || savedConfig?.gatewayPort
    const gatewayToken_ = savedConfig?.gatewayToken

    send('success', `─── Provision complete ───`)
    send('success', `  Dashboard : http://localhost:${gatewayPort}`)
    send('success', `  Token     : ${gatewayToken_ ? gatewayToken_.slice(0, 8) + '...' : '(see config)'}`)

    res.write(`data: ${JSON.stringify({
      type: 'done',
      text: 'Provision complete.',
      gatewayPort,
      gatewayToken: gatewayToken_,
    })}\n\n`)
    res.end()

  } catch (err) {
    try { releasePorts(userId) } catch {}
    res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`)
    res.end()
  }
})

// ── Container management routes ───────────────────────────────────────────────

app.get('/api/container/config', requireAuth, async (req, res) => {
  const userId = getProvisionUserId(req.user.userId)
  const config = getContainerConfig(userId)
  const paths = getUserPaths(userId)
  let status = { exists: false }
  try {
    status = await getContainerStatus(userId)
  } catch {}

  if (!config && !status.exists) return res.status(404).json({ error: '尚未建立容器' })

  res.json({
    userId,
    workspacePath: config?.workspacePath || paths.workspace,
    gatewayConfigPath: paths.config,
    gatewayWorkspacePath: paths.base,
    gatewayToken: config?.gatewayToken || readGatewayToken(paths),
    operatorToken: config?.operatorToken,
    deviceId: config?.deviceId,
    gatewayPort: config?.gatewayPort || status.gatewayPort,
    bridgePort: config?.bridgePort || status.bridgePort,
    containerId: config?.containerId || status.id,
    containerStatus: status.status,
    containerHealth: status.health,
    provisionedAt: config?.provisionedAt,
  })
})

app.post('/api/container/restart', requireAuth, async (req, res) => {
  const userId = getProvisionUserId(req.user.userId)
  try {
    const status = await getContainerStatus(userId)
    if (!status.exists) return res.status(404).json({ error: '容器不存在，請先建立容器' })
    if (status.running) await stopContainer(userId)
    await startContainer(userId)
    res.json({ success: true, userId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/container', requireAuth, async (req, res) => {
  const userId = getProvisionUserId(req.user.userId)
  try {
    const status = await getContainerStatus(userId)
    if (status.exists) await destroyContainer(userId)
    releasePorts(userId)
    deleteContainerConfig(userId)
    const user = resetSetup(req.user.userId)
    res.json({ success: true, userId, user })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── WebSocket chat ────────────────────────────────────────────────────────────

/**
 * Send a user message to OpenClaw via the gateway WebSocket protocol
 * and stream incremental history updates back to the frontend WebSocket.
 *
 * Protocol: WebSocket JSON-RPC (not REST/SSE).
 * We call chat.send, then poll chat.history until the reply stabilises.
 */
async function handleChatMessage(ws, authUserId, sessionKey, content) {
  const provisionUserId = getProvisionUserId(authUserId)

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }
  let client
  try {
    client = getClientForUser(provisionUserId)
    await client.ensureConnected()
  } catch (err) {
    send({ type: 'error', message: `無法連線至 OpenClaw Gateway：${err.message}` })
    return
  }

  // Send an early placeholder so the UI shows the typing indicator immediately.
  const initialFrontendMsgId = randomUUID()
  send({ type: 'message_start', messageId: initialFrontendMsgId, sessionKey })

  // Per-turn state: track the current gateway message being streamed.
  let currentGatewayMsgId = null   // id of the gateway assistant message we're currently streaming
  let frontendMsgId = initialFrontendMsgId
  let lastSentText = ''
  let latestProcessEntries = []

  try {
    await sendAndStream(client, sessionKey, content, ({ lastAssistantMsg, processEntries, done }) => {
      latestProcessEntries = processEntries

      // Detect a new (or first) assistant message from the gateway.
      if (lastAssistantMsg && lastAssistantMsg.id !== currentGatewayMsgId) {
        if (currentGatewayMsgId !== null) {
          // A second (or later) assistant message appeared — complete the previous one.
          const prevMsg = createMessage('assistant', lastSentText, {
            messageId: frontendMsgId, sessionKey, events: processEntries,
          })
          appendMessage(authUserId, prevMsg)
          send({ type: 'message_complete', messageId: frontendMsgId, message: prevMsg })

          frontendMsgId = randomUUID()
          lastSentText = ''
          send({ type: 'message_start', messageId: frontendMsgId, sessionKey })
        }
        currentGatewayMsgId = lastAssistantMsg.id
      }

      // Stream new characters of the current assistant message.
      if (lastAssistantMsg && lastAssistantMsg.content.length > lastSentText.length) {
        const delta = lastAssistantMsg.content.slice(lastSentText.length)
        send({ type: 'chunk', messageId: frontendMsgId, text: delta })
        lastSentText = lastAssistantMsg.content
      }

      if (processEntries.length > 0) {
        send({ type: 'process_entries', entries: processEntries })
      }

      if (done) {
        if (lastSentText) {
          const assistantMsg = createMessage('assistant', lastSentText, {
            messageId: frontendMsgId,
            sessionKey,
            events: latestProcessEntries,
          })
          appendMessage(authUserId, assistantMsg)
          send({ type: 'message_complete', messageId: frontendMsgId, message: assistantMsg })
        } else {
          // Gateway returned nothing — cancel the placeholder bubble.
          send({ type: 'message_complete', messageId: frontendMsgId, message: null })
        }
      }
    })

  } catch (err) {
    console.error('[chat] OpenClaw error:', err.message)
    send({ type: 'message_complete', messageId: frontendMsgId, message: null })
    send({ type: 'error', message: err.message })
  }
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws/chat' })

wss.on('connection', (ws) => {
  let authUserId = null
  let sessionKey = getDefaultSessionKey()

  // Per-connection message queue: allows the user to send multiple messages
  // without waiting for each response. Messages are forwarded to OpenClaw in
  // order so the conversation context is preserved.
  const msgQueue = []
  let queueRunning = false

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }

  async function drainQueue() {
    if (queueRunning) return
    queueRunning = true
    while (msgQueue.length > 0) {
      const { content, sk } = msgQueue.shift()
      try {
        await handleChatMessage(ws, authUserId, sk, content)
      } catch (err) {
        console.error('[ws queue] error:', err.message)
        send({ type: 'error', message: err.message })
      }
    }
    queueRunning = false
  }

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'auth') {
      try {
        const decoded = verifyToken(msg.token)
        authUserId = decoded.userId
        const history = getChatHistory(authUserId)
        send({ type: 'auth_ok', history, sessionKey })
      } catch {
        send({ type: 'auth_error', message: 'Token 無效' })
        ws.close()
      }
      return
    }

    if (!authUserId) {
      send({ type: 'auth_error', message: '請先驗證身份' })
      return
    }

    if (msg.type === 'message' && typeof msg.content === 'string' && msg.content.trim()) {
      const userMsg = createMessage('user', msg.content.trim(), { sessionKey })
      appendMessage(authUserId, userMsg)
      send({ type: 'user_message', message: userMsg })
      // Enqueue and process in background — caller returns immediately.
      msgQueue.push({ content: msg.content.trim(), sk: sessionKey })
      drainQueue()
    }

    if (msg.type === 'new_session') {
      // Discard any queued messages for the old session.
      msgQueue.length = 0
      sessionKey = makeScopedSessionKey('chat')
      send({ type: 'session_changed', sessionKey })
    }
  })

  ws.on('close', () => {
    msgQueue.length = 0
  })

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message)
  })
})

server.listen(PORT, () => {
  console.log(`ClawPM API server running on http://localhost:${PORT}`)
})
