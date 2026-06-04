import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import multer from 'multer'
import { Client as FtpClient } from 'basic-ftp'
import nodemailer from 'nodemailer'
import { runMigrations } from './src/migrate.js'
import { registerTeam, login, verifyToken, getUserById, createMember, listMembers, deleteMember, setMemberRole, migrateUsers, deleteAllTeamMembers } from './src/managers/UserManager.js'
import { listTeams, getTeam, completeTeamSetup, resetTeamSetup, getWorkspaceFolder, deleteTeam } from './src/managers/TeamManager.js'
import {
  getClientForUser, disconnectClientForUser,
  getDefaultSessionKey, makeScopedSessionKey,
  sendAndStream, getHistory as getGatewayHistory,
  startPassiveSessionWatcher,
} from './src/managers/OpenClawClient.js'
import { allocatePorts, releasePorts, getPortsForUser } from './src/containers/PortManager.js'
import { createTask, getTask, listTasksForTeam, updateTask, deleteTask, retryTask } from './src/managers/TaskManager.js'
import { initializeWorkspace } from './src/containers/WorkspaceManager.js'
import {
  createAndStartContainer,
  getContainerStatus,
  getContainerResourceStats,
  startContainer,
  stopContainer,
  destroyContainer,
  imageExists,
  pullImage,
  getContainerLogStream,
  execStreamInContainer,
} from './src/containers/ContainerManager.js'
import {
  pairDevice,
  saveContainerConfig,
  getContainerConfig,
  deleteContainerConfig,
} from './src/containers/DevicePairer.js'
import { getUserPaths } from './src/containers/WorkspaceManager.js'

dotenv.config()

const dbg = (...a) => { if (process.env.DEBUG_LOGS) console.log(...a) }
const dbgErr = (...a) => { if (process.env.DEBUG_LOGS) console.error(...a) }

const app = express()
const DEFAULT_PORT = 3000
const INITIAL_PORT = Number.parseInt(process.env.API_PORT || `${DEFAULT_PORT}`, 10)
const PORT_RETRY_LIMIT = Number.parseInt(process.env.API_PORT_RETRY_LIMIT || '20', 10)
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'
const MAX_TERMS = parseInt(process.env.MAX_TERMS || '30', 10)
const WHISPERX_BASE = `http://${process.env.LOCAL_SERVER_IP || '172.22.12.162'}:${process.env.LOCAL_SERVER_PORT || '8787'}`
const WHISPERX_API_KEY = process.env.LOCAL_API_KEY || ''

// Azure proxy — host reachable from inside the Docker container.
// host.docker.internal is the Docker Desktop magic hostname (always resolves to the Windows/Mac host).
// Override with CLAWPM_PROXY_HOST if your Docker setup uses a different bridge IP.
const CLAWPM_PROXY_HOST = process.env.CLAWPM_PROXY_HOST || 'host.docker.internal'
const AZURE_API_VERSION = process.env.AZURE_API_VERSION || '2025-04-01-preview'
const AZURE_CONFIGS_DIR = path.resolve('./data/azure_configs')
let RUNNING_PORT = INITIAL_PORT  // updated once the server binds

// In-memory store for active transcription jobs
// jobId → { status, content, error }
const transcriptionJobs = new Map()

async function pollWhisperXJob(jobId, outputHostPath, taskId) {
  const headers = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}

  const poll = async () => {
    try {
      const res = await fetch(`${WHISPERX_BASE}/jobs/${jobId}`, { headers })
      if (!res.ok) {
        transcriptionJobs.set(jobId, { status: 'failed', content: null, error: `WhisperX HTTP ${res.status}` })
        return
      }
      const job = await res.json()
      const prev = transcriptionJobs.get(jobId) ?? {}
      transcriptionJobs.set(jobId, { ...prev, status: job.status })

      if (job.status === 'done') {
        const resultRes = await fetch(`${WHISPERX_BASE}/jobs/${jobId}/result`, { headers })
        if (resultRes.ok) {
          const content = await resultRes.text()
          fs.mkdirSync(path.dirname(outputHostPath), { recursive: true })
          fs.writeFileSync(outputHostPath, content, 'utf8')
          transcriptionJobs.set(jobId, { status: 'done', content, error: null })

          // Update task DB so the task list reflects completion without requiring WorkflowView to be open
          if (taskId) {
            try {
              const task = await getTask(taskId)
              if (task && task.status !== 'completed' && task.status !== 'error') {
                await updateTask(taskId, {
                  stepStatuses: { ...task.stepStatuses, 3: 'done' },
                })
              }
            } catch (e) {
              console.error('[whisperx-poll] task DB update failed:', e.message)
            }
          }
        } else {
          transcriptionJobs.set(jobId, { status: 'failed', content: null, error: '無法下載轉錄結果' })
        }
        fetch(`${WHISPERX_BASE}/jobs/${jobId}`, { method: 'DELETE', headers }).catch(() => {})
        return
      }

      if (job.status === 'failed') {
        transcriptionJobs.set(jobId, { status: 'failed', content: null, error: job.error || '轉錄失敗' })
        return
      }

      // pending / running → keep polling
      setTimeout(poll, 15000)
    } catch (err) {
      console.error('[whisperx-poll] error:', err.message)
      setTimeout(poll, 15000)
    }
  }

  setTimeout(poll, 15000)
}

async function monitorInsightsCompletion(taskId, projectsJsonHostPath, beforeMtime) {
  const MAX_CHECKS = 72  // 72 × 10s = 12 minutes max
  let checks = 0

  const check = async () => {
    checks++
    if (checks > MAX_CHECKS) return

    try {
      if (fs.existsSync(projectsJsonHostPath)) {
        const mtime = fs.statSync(projectsJsonHostPath).mtimeMs
        if (mtime > beforeMtime) {
          const task = await getTask(taskId)
          if (task && task.status !== 'completed' && task.status !== 'error') {
            await updateTask(taskId, {
              status: 'completed',
              currentStep: 5,
              stepStatuses: { ...task.stepStatuses, 5: 'done' },
              autoAdvanceAt: null,
            })
          }
          return
        }
      }
    } catch (e) {
      console.error('[insights-monitor] error:', e.message)
    }

    setTimeout(check, 10000)
  }

  setTimeout(check, 10000)
}
const OPENCLAW_VERSION = OPENCLAW_IMAGE.split(':').pop() || '2026.4.22'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FRONTEND_DIST = path.resolve(__dirname, '../frontend/dist')

const defaultCorsOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173']
const extraCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : []
app.use(cors({
  origin: [...defaultCorsOrigins, ...extraCorsOrigins],
  credentials: true
}))
app.use(express.json({ limit: '50mb' }))
app.use(express.static(FRONTEND_DIST))

// ── Auth routes ───────────────────────────────────────────────────────────────

// Public: list teams for login page
app.get('/api/teams', async (_req, res) => {
  res.json(await listTeams())
})

// Public: register a new team + first admin
app.post('/api/auth/register-team', async (req, res) => {
  const { teamName, email, password } = req.body ?? {}
  if (!teamName || !email || !password) {
    return res.status(400).json({ error: '請填寫 Team 名稱、電子郵件與密碼' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少需要 6 個字元' })
  }
  try {
    const result = await registerTeam(teamName, email, password)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const { email, password, teamId } = req.body ?? {}
  if (!email || !password) {
    return res.status(400).json({ error: '請填寫電子郵件與密碼' })
  }
  try {
    const result = await login(email, password, teamId)
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

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '此操作需要 Admin 權限' })
  }
  next()
}

app.get('/api/user/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.user.userId)
  if (!user) return res.status(404).json({ error: '用戶不存在' })
  const team = user.team_id ? await getTeam(user.team_id) : null
  res.json({ ...user, team })
})

// Team setup (replaces /api/user/setup)
app.patch('/api/team/setup', requireAuth, requireAdmin, async (req, res) => {
  const { provider, apiKey, baseUrl, model, workspaceFolder } = req.body ?? {}
  if (!provider || !apiKey || !model || !workspaceFolder) {
    return res.status(400).json({ error: '缺少必要的設定欄位' })
  }
  try {
    const team = await completeTeamSetup(req.user.teamId, { provider, apiKey, baseUrl, model, workspaceFolder })
    res.json(team)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Keep old route for backward compat
app.patch('/api/user/setup', requireAuth, async (req, res) => {
  const { provider, apiKey, baseUrl, model, workspaceFolder } = req.body ?? {}
  if (!provider || !apiKey || !model || !workspaceFolder) {
    return res.status(400).json({ error: '缺少必要的設定欄位' })
  }
  try {
    const team = await completeTeamSetup(req.user.teamId, { provider, apiKey, baseUrl, model, workspaceFolder })
    res.json(team)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── Team member management routes (admin only) ────────────────────────────────

app.get('/api/team/members', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await listMembers(req.user.userId))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/team/members', requireAuth, requireAdmin, async (req, res) => {
  const { email, password, name } = req.body ?? {}
  if (!email || !password) {
    return res.status(400).json({ error: '請填寫電子郵件與密碼' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少需要 6 個字元' })
  }
  try {
    const member = await createMember(req.user.userId, email, password, name)
    res.json(member)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/team/members/:memberId', requireAuth, requireAdmin, async (req, res) => {
  try {
    await deleteMember(req.user.userId, req.params.memberId)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Delete entire team: destroy container, release ports, delete all members, then delete team
app.delete('/api/team', requireAuth, requireAdmin, async (req, res) => {
  const teamId = req.user.teamId
  if (!teamId) return res.status(400).json({ error: '找不到所屬 Team' })
  try {
    const provisionUserId = await getProvisionUserId(req.user.userId)
    try {
      const status = await getContainerStatus(provisionUserId)
      if (status.exists) await destroyContainer(provisionUserId)
      await releasePorts(provisionUserId)
      await deleteContainerConfig(provisionUserId)
    } catch (e) {
      console.error('[delete-team] container cleanup error:', e.message)
    }
    await deleteAllTeamMembers(teamId)
    await deleteTeam(teamId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.patch('/api/team/members/:memberId/role', requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body ?? {}
  if (!role) return res.status(400).json({ error: '請指定角色' })
  try {
    const member = await setMemberRole(req.user.userId, req.params.memberId, role)
    res.json(member)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── Media upload via FTP ──────────────────────────────────────────────────────

const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.webm'])

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `clawpm-media-${Date.now()}${ext}`)
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ALLOWED_AUDIO_EXTS.has(ext)) return cb(null, true)
    cb(new Error('不支援的檔案格式，請上傳 MP3、WAV、M4A 或 WebM'))
  },
})

app.post('/api/workflow/upload-media', requireAuth, (req, res, next) => {
  mediaUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    next()
  })
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到檔案' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const ftpUser = process.env.FTP_USER || 'advantech'
  const ftpPass = process.env.FTP_PASS || 'changeme'
  const rawDate = req.body?.meetingDate
  const dateFolder = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : new Date().toISOString().slice(0, 10)
  const remoteDir = `/${provisionUserId}/workspace/ftp_data/media/${dateFolder}`
  const originalName = req.file.originalname

  const client = new FtpClient()
  try {
    const ftpHost = process.env.FTP_HOST || '127.0.0.1'
    const ftpPort = parseInt(process.env.FTP_PORT || '21')
    await client.access({ host: ftpHost, port: ftpPort, user: ftpUser, password: ftpPass, secure: false })
    client.ftp.pasvIpReplace = ftpHost
    await client.ensureDir(remoteDir)
    await client.uploadFrom(req.file.path, originalName)
    res.json({ success: true, fileName: originalName, remotePath: `${remoteDir}/${originalName}` })
  } catch (err) {
    console.error('[upload-media] FTP error:', err.message)
    res.status(500).json({ error: `FTP 上傳失敗：${err.message}` })
  } finally {
    client.close()
    fs.unlink(req.file.path, () => {})
  }
})

// ── Document upload via FTP ───────────────────────────────────────────────────

const ALLOWED_DOC_EXTS = new Set(['.pdf', '.docx', '.txt', '.csv', '.xls', '.xlsx', '.pptx'])

const docUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `clawpm-doc-${Date.now()}${ext}`)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ALLOWED_DOC_EXTS.has(ext)) return cb(null, true)
    cb(new Error('不支援的檔案格式，請上傳 PDF、Docx、TXT、CSV、XLS、XLSX 或 PPTX'))
  },
})

app.post('/api/workflow/upload-doc', requireAuth, (req, res, next) => {
  docUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    next()
  })
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到檔案' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const ftpUser = process.env.FTP_USER || 'advantech'
  const ftpPass = process.env.FTP_PASS || 'changeme'
  const dateFolder = new Date().toISOString().slice(0, 10)
  const remoteDir = `/${provisionUserId}/workspace/ftp_data/doc/${dateFolder}`
  const originalName = req.file.originalname

  const client = new FtpClient()
  try {
    const ftpHost = process.env.FTP_HOST || '127.0.0.1'
    const ftpPort = parseInt(process.env.FTP_PORT || '21')
    await client.access({ host: ftpHost, port: ftpPort, user: ftpUser, password: ftpPass, secure: false })
    client.ftp.pasvIpReplace = ftpHost
    await client.ensureDir(remoteDir)
    await client.uploadFrom(req.file.path, originalName)
    res.json({ success: true, fileName: originalName, remotePath: `${remoteDir}/${originalName}` })
  } catch (err) {
    console.error('[upload-doc] FTP error:', err.message)
    res.status(500).json({ error: `FTP 上傳失敗：${err.message}` })
  } finally {
    client.close()
    fs.unlink(req.file.path, () => {})
  }
})

app.delete('/api/workflow/delete-doc', requireAuth, async (req, res) => {
  const { remotePath } = req.body ?? {}
  if (!remotePath || typeof remotePath !== 'string') {
    return res.status(400).json({ error: '缺少 remotePath' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const allowedPrefix = `/${provisionUserId}/workspace/ftp_data/doc/`
  if (!remotePath.startsWith(allowedPrefix)) {
    return res.status(403).json({ error: '無權限刪除此檔案' })
  }

  const ftpUser = process.env.FTP_USER || 'advantech'
  const ftpPass = process.env.FTP_PASS || 'changeme'

  const client = new FtpClient()
  try {
    const ftpHost = process.env.FTP_HOST || '127.0.0.1'
    const ftpPort = parseInt(process.env.FTP_PORT || '21')
    await client.access({ host: ftpHost, port: ftpPort, user: ftpUser, password: ftpPass, secure: false })
    client.ftp.pasvIpReplace = ftpHost
    await client.remove(remotePath)
    res.json({ success: true })
  } catch (err) {
    console.error('[delete-doc] FTP error:', err.message)
    res.status(500).json({ error: `FTP 刪除失敗：${err.message}` })
  } finally {
    client.close()
  }
})

// ── Extraction preparation ────────────────────────────────────────────────────

const CONTAINER_WORKSPACE = '/home/node/.openclaw/workspace'

function sanitizeBaseName(value) {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9一-龥._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

app.post('/api/workflow/prepare-extraction', requireAuth, async (req, res) => {
  const { sourcePath, originalName } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const allowedPrefix = `/${provisionUserId}/workspace/`

  if (!sourcePath || typeof sourcePath !== 'string' || !sourcePath.startsWith(allowedPrefix)) {
    return res.status(400).json({ error: '無效的檔案路徑' })
  }

  const relativePath = sourcePath.slice(`/${provisionUserId}/workspace`.length)
  const workspaceFilePath = `${CONTAINER_WORKSPACE}${relativePath}`

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const baseName = sanitizeBaseName(originalName) || `media_${Date.now()}`
  const outputFileName = `${baseName}_${timestamp}_proper_nouns.csv`
  const outputPath = `${CONTAINER_WORKSPACE}/ftp_data/proper-noun-imports/output/${outputFileName}`

  const sessionKey = makeScopedSessionKey('extraction')
  const prompt = [
    '請透過 meeting-proper-noun-extractor skill，處理我剛上傳的檔案。',
    `來源檔案路徑：${workspaceFilePath}`,
    `來源檔案名稱：${originalName || ''}`,
    `輸出檔案路徑：${outputPath}`,
    '請產出 UTF-8 CSV 檔案。',
    '欄位格式固定為：term,count,contexts',
    '完成後請明確回覆輸出檔案已建立。',
    'term 裡面不可包含特殊字元，如/或,等。',
  ].join('\n')

  res.json({ success: true, sessionKey, prompt, outputPath })
})

app.get('/api/workflow/extraction-tags', requireAuth, async (req, res) => {
  const { outputPath } = req.query
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!outputPath || !outputPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的路徑' })
  }

  const relPath = outputPath.slice(CONTAINER_WORKSPACE.length)
  const hostPath = path.join(paths.workspace, relPath)

  if (!hostPath.startsWith(paths.workspace)) {
    return res.status(403).json({ error: '無權限' })
  }

  if (!fs.existsSync(hostPath)) {
    return res.json({ ready: false, tags: [] })
  }

  try {
    const lines = fs.readFileSync(hostPath, 'utf8').split('\n').filter(Boolean)
    const tags = lines.slice(1)
      .map(line => line.split(',')[0]?.trim())
      .filter(Boolean)
      .slice(0, MAX_TERMS)
    res.json({ ready: true, tags })
  } catch {
    res.status(500).json({ error: '讀取結果失敗' })
  }
})

// ── Transcription preparation ─────────────────────────────────────────────────

app.post('/api/workflow/prepare-transcription', requireAuth, async (req, res) => {
  const { mediaPath, tags, team, taskId } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const allowedPrefix = `/${provisionUserId}/workspace/`

  if (!mediaPath || typeof mediaPath !== 'string' || !mediaPath.startsWith(allowedPrefix)) {
    return res.status(400).json({ error: '無效的媒體檔案路徑' })
  }

  const relativePath = mediaPath.slice(`/${provisionUserId}/workspace`.length)
  const paths = getUserPaths(provisionUserId)
  const hostAudioPath = path.join(paths.workspace, relativePath)

  if (!hostAudioPath.startsWith(paths.workspace)) {
    return res.status(403).json({ error: '無權限' })
  }

  if (!fs.existsSync(hostAudioPath)) {
    return res.status(404).json({ error: '找不到音訊檔案' })
  }

  const audioExt = path.extname(hostAudioPath)
  const baseName = path.basename(hostAudioPath, audioExt).replace(/---[0-9a-f-]{36}$/i, '')
  const outputHostPath = path.join(path.dirname(hostAudioPath), baseName, `${baseName}_逐字稿.md`)

  // Container-side path (returned for compatibility)
  const containerAudioPath = `${CONTAINER_WORKSPACE}${relativePath}`
  const containerAudioDir = path.dirname(containerAudioPath)
  const transcriptOutputPath = `${containerAudioDir}/${baseName}/${baseName}_逐字稿.md`

  const appSettings = readAppSettings()
  const whisperModel = appSettings.whisperModel || 'large-v3'

  const whisperxHeaders = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}

  try {
    const formData = new FormData()
    const audioBuffer = fs.readFileSync(hostAudioPath)
    formData.append('audio', new Blob([audioBuffer]), path.basename(hostAudioPath))
    formData.append('lang', 'zh')
    formData.append('model', whisperModel)
    if (Array.isArray(tags) && tags.length > 0) {
      formData.append('terms', tags.join(', '))
    }
    if (team && typeof team === 'string' && /^[A-Za-z0-9_-]+$/.test(team)) {
      formData.append('team', team)
    }

    const uploadRes = await fetch(`${WHISPERX_BASE}/transcribe`, {
      method: 'POST',
      body: formData,
      headers: whisperxHeaders,
    })

    if (!uploadRes.ok) {
      const errBody = await uploadRes.json().catch(() => ({}))
      return res.status(502).json({ error: errBody.detail || `WhisperX 回傳 HTTP ${uploadRes.status}` })
    }

    let parsedResponse
    try {
      parsedResponse = await uploadRes.json()
    } catch {
      return res.status(502).json({ error: 'WhisperX 伺服器回傳了無效的回應，請確認服務是否正常運作' })
    }
    const { job_id } = parsedResponse
    if (!job_id) {
      return res.status(502).json({ error: 'WhisperX 未回傳 job_id，請確認服務是否正常運作' })
    }
    transcriptionJobs.set(job_id, { status: 'pending', content: null, error: null })
    pollWhisperXJob(job_id, outputHostPath, taskId || null)

    res.json({ success: true, jobId: job_id, transcriptOutputPath })
  } catch (err) {
    console.error('[prepare-transcription] WhisperX error:', err.message)
    res.status(502).json({ error: `無法連接轉錄伺服器：${err.message}` })
  }
})

app.get('/api/workflow/transcription-result', requireAuth, async (req, res) => {
  const { jobId, outputPath } = req.query
  const provisionUserId = await getProvisionUserId(req.user.userId)

  if (!jobId) return res.status(400).json({ error: '缺少 jobId 參數' })

  const job = transcriptionJobs.get(jobId)

  if (job) {
    if (job.status === 'failed') {
      return res.status(500).json({ error: job.error || '轉錄失敗' })
    }
    if (job.status === 'done') {
      if (job.content) return res.json({ ready: true, content: job.content })
      // done but content missing — fall through to disk check
    } else {
      return res.json({ ready: false, content: null, status: job.status })
    }
  }

  // Job not in memory (restart) or done-without-content — try reading from disk
  if (outputPath) {
    const containerPrefix = `${CONTAINER_WORKSPACE}/`
    if (outputPath.startsWith(containerPrefix)) {
      const relPath = outputPath.slice(CONTAINER_WORKSPACE.length)
      const paths = getUserPaths(provisionUserId)
      const hostPath = path.join(paths.workspace, relPath)
      if (hostPath.startsWith(paths.workspace) && fs.existsSync(hostPath)) {
        const content = fs.readFileSync(hostPath, 'utf8')
        return res.json({ ready: true, content })
      }
    }
  }

  res.json({ ready: false, content: null, status: job?.status ?? 'unknown' })
})

app.delete('/api/workflow/transcription/:jobId', requireAuth, async (req, res) => {
  const { jobId } = req.params
  if (!jobId || typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) {
    return res.status(400).json({ error: '無效的 jobId' })
  }
  const headers = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}
  try {
    const deleteRes = await fetch(`${WHISPERX_BASE}/jobs/${jobId}`, { method: 'DELETE', headers })
    if (!deleteRes.ok && deleteRes.status !== 404) {
      return res.status(deleteRes.status).json({ error: `WhisperX 回傳 HTTP ${deleteRes.status}` })
    }
    transcriptionJobs.delete(jobId)
    res.json({ success: true })
  } catch (err) {
    console.error('[cancel-transcription] error:', err.message)
    res.status(502).json({ error: `無法連接轉錄伺服器：${err.message}` })
  }
})

// ── Meeting notes (Step 4) ────────────────────────────────────────────────────

app.post('/api/workflow/prepare-meeting-notes', requireAuth, async (req, res) => {
  const { transcriptContainerPath, meetingDate } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!transcriptContainerPath || !transcriptContainerPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的逐字稿路徑' })
  }

  const transcriptDir = path.dirname(transcriptContainerPath)
  const transcriptBase = path.basename(transcriptContainerPath, '_逐字稿.md')
  const notesOutputContainerPath = `${transcriptDir}/${transcriptBase}_notes.md`

  const sessionKey = makeScopedSessionKey('meeting-notes')

  const resolvedDate = meetingDate && /^\d{4}-\d{2}-\d{2}$/.test(meetingDate)
    ? meetingDate
    : new Date().toISOString().slice(0, 10)

  const prompt = [
    '請執行 meeting-transcription skill 的步驟 2：讀取逐字稿並生成會議記錄。',
    '',
    `本次會議日期：${resolvedDate}`,
    `逐字稿路徑：${transcriptContainerPath}`,
    '',
    '請依序完成：',
    '1. 讀取逐字稿全文',
    '2. 判斷錄音類型（商務會議 / 訪談與使用者研究 / 知識學習與演講 / 其他）',
    '3. 依對應格式生成完整會議記錄',
    `4. 將完整結果**寫入以下固定路徑**（無論類型皆統一輸出此路徑）：\n   ${notesOutputContainerPath}`,
    '',
    '請直接執行，無需確認。',
  ].join('\n')

  res.json({ success: true, sessionKey, prompt, notesOutputContainerPath })
})

app.get('/api/workflow/meeting-notes-result', requireAuth, async (req, res) => {
  const { outputPath } = req.query
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!outputPath || !outputPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的路徑' })
  }

  const relPath = outputPath.slice(CONTAINER_WORKSPACE.length)
  const hostPath = path.join(paths.workspace, relPath)

  if (!hostPath.startsWith(paths.workspace)) {
    return res.status(403).json({ error: '無權限' })
  }

  if (!fs.existsSync(hostPath)) {
    return res.json({ ready: false, content: null })
  }

  try {
    const content = fs.readFileSync(hostPath, 'utf8')
    res.json({ ready: true, content })
  } catch {
    res.status(500).json({ error: '讀取會議記錄失敗' })
  }
})

app.post('/api/workflow/send-meeting-email', requireAuth, async (req, res) => {
  const { recipients, subject, content, transcriptContent } = req.body ?? {}

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: '請填寫至少一位收件者' })
  }

  const smtpHost = process.env.SMTP_HOST
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10)
  const smtpUser = process.env.SMTP_USER
  const smtpPass = process.env.SMTP_PASS
  const fromName = process.env.EMAIL_FROM_NAME || 'ClawPM 會議助理'

  if (!smtpHost || !smtpUser || !smtpPass) {
    return res.status(500).json({ error: 'SMTP 尚未設定，請聯絡管理員填寫 .env 的 SMTP_* 參數' })
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    })

    const attachments = []
    if (transcriptContent) {
      attachments.push({
        filename: '逐字稿.md',
        content: transcriptContent,
        contentType: 'text/markdown; charset=utf-8',
      })
    }

    await transporter.sendMail({
      from: `"${fromName}" <${smtpUser}>`,
      to: recipients.join(', '),
      subject: subject || '會議記錄',
      html: content || '',
      attachments,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('[send-meeting-email] error:', err.message)
    res.status(500).json({ error: `郵件發送失敗：${err.message}` })
  }
})

// ── App Settings ──────────────────────────────────────────────────────────────

const APP_SETTINGS_PATH = path.resolve('./data/app_settings.json')

function readAppSettings() {
  if (!fs.existsSync(APP_SETTINGS_PATH)) return {}
  try { return JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, 'utf-8')) } catch { return {} }
}

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(readAppSettings())
})

app.put('/api/settings', requireAuth, (req, res) => {
  const current = readAppSettings()
  const updated = { ...current, ...req.body }
  fs.mkdirSync(path.dirname(APP_SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(APP_SETTINGS_PATH, JSON.stringify(updated, null, 2))
  res.json(updated)
})

// ── Project Insights (Step 5) ─────────────────────────────────────────────────

const CONTAINER_INSIGHTS_DIR = `${CONTAINER_WORKSPACE}/project-insights`

app.post('/api/workflow/prepare-insights', requireAuth, async (req, res) => {
  const { transcriptContainerPath, notesContainerPath, meetingDate, taskId } = req.body ?? {}
  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)

  if (transcriptContainerPath && (typeof transcriptContainerPath !== 'string' || !transcriptContainerPath.startsWith(containerPrefix))) {
    return res.status(400).json({ error: '無效的逐字稿路徑' })
  }
  if (notesContainerPath && (typeof notesContainerPath !== 'string' || !notesContainerPath.startsWith(containerPrefix))) {
    return res.status(400).json({ error: '無效的會議記錄路徑' })
  }

  // Snapshot current projects.json state so polling can detect when this run's update lands
  const projectsJsonHostPath = path.join(paths.workspace, 'project-insights', 'reviewer', 'projects.json')
  let beforeMtime = 0
  let existingProjectIds = []
  let knownProjects = []
  try {
    beforeMtime = fs.statSync(projectsJsonHostPath).mtimeMs
    const existing = JSON.parse(fs.readFileSync(projectsJsonHostPath, 'utf8'))
    existingProjectIds = (existing.projects || []).map(p => p.id || p.slug || p.name).filter(Boolean)
    knownProjects = (existing.projects || []).filter(p => p.name && (p.slug || p.id))
      .map(p => ({ name: p.name, slug: p.slug || p.id }))
  } catch {}

  const today = meetingDate && /^\d{4}-\d{2}-\d{2}$/.test(meetingDate)
    ? meetingDate
    : new Date().toISOString().slice(0, 10)
  const sessionKey = makeScopedSessionKey('insights')

  const parts = [
    '請使用 project-insight-synthesizer skill，將本次會議資料增量更新至專案知識庫。',
    '',
    `本次會議日期：${today}`,
  ]
  // if (transcriptContainerPath) parts.push(`本次會議逐字稿路徑：${transcriptContainerPath}`)
  if (notesContainerPath) parts.push(`本次會議記錄路徑：${notesContainerPath}`)
  parts.push('', `專案知識庫目錄：${CONTAINER_INSIGHTS_DIR}/`, '')

  if (knownProjects.length > 0) {
    parts.push(
      '知識庫中已有以下專案（Markdown 文件已就緒），請優先將本次會議內容對應至這些專案進行增量整併：',
      ...knownProjects.map(p => `- ${p.name}（${p.slug}.md）`),
      '',
      '請依照 skill 工作流程完整執行：',
      '1. 讀取上方所列專案的 Markdown 文件，以增量合併方式更新各專案內容',
      '2. 若本次會議出現上述清單以外的新主題，可自動新增對應 Markdown',
      '3. 同步更新 index.md、reviewer/projects.json 與相關 HTML 檔',
      '4. 完成後回報各專案更新情況、目前進度、對外發表成熟度與主要缺口',
      '',
      '請直接執行，無需確認。',
      '最後檢查所有的Markdown檔案寫入時，\n 要取代成斷行。',
    )
  } else {
    parts.push(
      '請依照 skill 工作流程完整執行：',
      '1. 讀取現有 project-insights/ 目錄中的所有專案 Markdown（若存在）',
      '2. 偵測本次會議涉及哪些專案',
      '3. 以增量合併方式更新每個涉及的專案 Markdown',
      '4. 若出現新專案主題，自動建立對應新 Markdown 檔',
      '5. 同步更新 index.md、reviewer/projects.json 與相關 HTML 檔',
      '6. 完成後回報已更新哪些專案、目前進度、對外發表成熟度與主要缺口',
      '',
      '請直接執行，無需確認。',
      '最後檢查所有的Markdown檔案寫入時，\n 要取代成斷行。',
    )
  }

  res.json({
    success: true,
    sessionKey,
    prompt: parts.join('\n'),
    insightsContainerDir: CONTAINER_INSIGHTS_DIR,
    beforeMtime,
    existingProjectIds,
  })

  // Spawn backend monitor so the task DB is updated even when WorkflowView is not open
  if (taskId) {
    monitorInsightsCompletion(taskId, projectsJsonHostPath, beforeMtime)
  }
})

app.get('/api/workflow/insights-result', requireAuth, async (req, res) => {
  const { insightsDir, beforeMtime } = req.query
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)

  if (!insightsDir || typeof insightsDir !== 'string' || !insightsDir.startsWith(`${CONTAINER_WORKSPACE}/`)) {
    return res.status(400).json({ error: '無效的路徑' })
  }

  const relPath = insightsDir.slice(CONTAINER_WORKSPACE.length)
  const hostInsightsDir = path.join(paths.workspace, relPath)

  if (!hostInsightsDir.startsWith(paths.workspace)) {
    return res.status(403).json({ error: '無權限' })
  }

  const projectsJsonPath = path.join(hostInsightsDir, 'reviewer', 'projects.json')

  if (!fs.existsSync(projectsJsonPath)) {
    return res.json({ ready: false, projects: [] })
  }

  // Only return ready when the file is newer than when this run started,
  // so stale data from a previous run doesn't prematurely end polling.
  if (beforeMtime && parseFloat(beforeMtime) > 0) {
    const fileMtime = fs.statSync(projectsJsonPath).mtimeMs
    if (fileMtime <= parseFloat(beforeMtime)) {
      return res.json({ ready: false, projects: [] })
    }
  }

  try {
    const data = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'))
    res.json({ ready: true, projects: data.projects || [] })
  } catch {
    res.status(500).json({ error: '讀取專案清單失敗' })
  }
})

app.get('/api/project-insights/list', requireAuth, async (req, res) => {
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')

  if (!fs.existsSync(hostInsightsDir)) {
    return res.json({ files: [], projects: [], hostPath: hostInsightsDir })
  }

  let projectsMeta = []
  const projectsJsonPath = path.join(hostInsightsDir, 'reviewer', 'projects.json')
  if (fs.existsSync(projectsJsonPath)) {
    try {
      projectsMeta = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8')).projects || []
    } catch {}
  }

  function metaMatchesSlug(p, slug) {
    return p.id === slug || p.slug === slug ||
      (p.name && p.name.toLowerCase().replace(/[\s/]/g, '-') === slug)
  }

  const files = fs.readdirSync(hostInsightsDir)
    .filter(f => f.endsWith('.md') && f !== 'index.md')
    .map(f => {
      const slug = f.replace('.md', '')
      const meta = projectsMeta.find(p => metaMatchesSlug(p, slug)) || {}
      return {
        name: f,
        slug,
        title: meta.name || slug,
        status: meta.status || null,
        maturity: meta.maturity || null,
        lastUpdated: meta.lastUpdated || null,
      }
    })
    .sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''))

  // Ensure each project's slug matches the actual filename so the frontend
  // can load it correctly even if projects.json has a stale/derived slug.
  const projects = projectsMeta.map(p => {
    const matchedFile = files.find(f => metaMatchesSlug(p, f.slug))
    if (matchedFile && matchedFile.slug !== p.slug) {
      return { ...p, slug: matchedFile.slug }
    }
    return p
  })

  res.json({ files, projects, hostPath: hostInsightsDir })
})

app.get('/api/project-insights/file', requireAuth, async (req, res) => {
  const { name } = req.query
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')

  if (!name || typeof name !== 'string' || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return res.status(400).json({ error: '無效的檔案名稱' })
  }

  const safeFileName = name.endsWith('.md') ? name : `${name}.md`
  const hostPath = path.join(hostInsightsDir, safeFileName)

  if (!hostPath.startsWith(hostInsightsDir)) {
    return res.status(403).json({ error: '無權限' })
  }

  if (!fs.existsSync(hostPath)) {
    return res.status(404).json({ error: '檔案不存在' })
  }

  try {
    const content = fs.readFileSync(hostPath, 'utf8')
    res.json({ content, name: safeFileName, hostPath })
  } catch {
    res.status(500).json({ error: '讀取檔案失敗' })
  }
})

app.post('/api/project-insights/create', requireAuth, async (req, res) => {
  const { name } = req.body ?? {}
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '專案名稱不可為空' })
  }

  const displayName = name.trim()
  const slug = displayName
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[*?"<>|:]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  if (!slug) return res.status(400).json({ error: '無法從名稱產生有效的檔案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  fs.mkdirSync(hostInsightsDir, { recursive: true })

  // 1. Create empty Markdown (skip if exists — preserve existing content)
  const mdPath = path.join(hostInsightsDir, `${slug}.md`)
  const isNew = !fs.existsSync(mdPath)
  if (isNew) {
    fs.writeFileSync(mdPath, `# ${displayName}\n\n`, 'utf8')
  }

  // 2. Upsert entry in projects.json
  const reviewerDir = path.join(hostInsightsDir, 'reviewer')
  fs.mkdirSync(reviewerDir, { recursive: true })
  const projectsJsonPath = path.join(reviewerDir, 'projects.json')
  let projectsData = { projects: [] }
  try {
    if (fs.existsSync(projectsJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'))
      if (Array.isArray(parsed.projects)) projectsData = parsed
    }
  } catch {}

  const alreadyInJson = projectsData.projects.some(p => p.slug === slug || p.id === slug)
  if (!alreadyInJson) {
    projectsData.projects.push({
      id: slug,
      slug,
      name: displayName,
      maturity: 'not ready',
      lastUpdated: new Date().toISOString().slice(0, 10),
    })
    fs.writeFileSync(projectsJsonPath, JSON.stringify(projectsData, null, 2), 'utf8')
  }

  // 3. Add link to index.md
  const indexMdPath = path.join(hostInsightsDir, 'index.md')
  let indexContent = '# 專案知識庫\n\n'
  try {
    if (fs.existsSync(indexMdPath)) indexContent = fs.readFileSync(indexMdPath, 'utf8')
  } catch {}
  const projectLink = `- [${displayName}](./${slug}.md)`
  if (!indexContent.includes(projectLink)) {
    indexContent = indexContent.trimEnd() + '\n' + projectLink + '\n'
    fs.writeFileSync(indexMdPath, indexContent, 'utf8')
  }

  res.json({ success: true, slug, name: displayName, isNew })
})

app.patch('/api/project-insights/file', requireAuth, async (req, res) => {
  const { name, content } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')

  if (!name || typeof name !== 'string' || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return res.status(400).json({ error: '無效的檔案名稱' })
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: '缺少 content' })
  }

  const safeFileName = name.endsWith('.md') ? name : `${name}.md`
  const hostPath = path.join(hostInsightsDir, safeFileName)

  if (!hostPath.startsWith(hostInsightsDir)) {
    return res.status(403).json({ error: '無權限' })
  }

  try {
    fs.mkdirSync(hostInsightsDir, { recursive: true })
    fs.writeFileSync(hostPath, content, 'utf8')
    res.json({ success: true, name: safeFileName })
  } catch {
    res.status(500).json({ error: '儲存檔案失敗' })
  }
})

app.delete('/api/project-insights/delete', requireAuth, async (req, res) => {
  const { slug } = req.query
  if (!slug || typeof slug !== 'string' || slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return res.status(400).json({ error: '無效的專案識別碼' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')

  const mdPath = path.join(hostInsightsDir, `${slug}.md`)
  if (!mdPath.startsWith(hostInsightsDir + path.sep)) {
    return res.status(403).json({ error: '無權限' })
  }

  // 1. Delete the .md file
  if (fs.existsSync(mdPath)) {
    fs.unlinkSync(mdPath)
  } else {
    return res.status(404).json({ error: '專案不存在' })
  }

  // 2. Remove from projects.json
  const projectsJsonPath = path.join(hostInsightsDir, 'reviewer', 'projects.json')
  if (fs.existsSync(projectsJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'))
      if (Array.isArray(raw.projects)) {
        raw.projects = raw.projects.filter(p => p.slug !== slug && p.id !== slug)
        fs.writeFileSync(projectsJsonPath, JSON.stringify(raw, null, 2), 'utf8')
      }
    } catch {}
  }

  // 3. Remove link from index.md
  const indexMdPath = path.join(hostInsightsDir, 'index.md')
  if (fs.existsSync(indexMdPath)) {
    try {
      const lines = fs.readFileSync(indexMdPath, 'utf8').split('\n')
      const filtered = lines.filter(line => !line.includes(`(./${slug}.md)`))
      fs.writeFileSync(indexMdPath, filtered.join('\n'), 'utf8')
    } catch {}
  }

  res.json({ success: true, slug })
})

// ── Project Insights HTML Viewer (iframe) ─────────────────────────────────────
// Serves reviewer/index.html with projects.json inlined via a fetch-intercept
// script, so the iframe needs zero further authenticated sub-requests.

app.get('/api/project-insights/viewer', async (req, res) => {
  const token = req.query.token
  let user
  try {
    if (!token) throw new Error('no token')
    user = verifyToken(token)
  } catch {
    return res.status(401).setHeader('Content-Type', 'text/html').send(
      '<p style="font-family:sans-serif;padding:2rem">Unauthorized — please open from the ClawPM app.</p>'
    )
  }

  const provisionUserId = await getProvisionUserId(user.userId)
  const paths = getUserPaths(provisionUserId)
  const reviewerDir = path.join(paths.workspace, 'project-insights', 'reviewer')
  const htmlPath = path.join(reviewerDir, 'index.html')
  const jsonPath = path.join(reviewerDir, 'projects.json')

  // Always read projects.json to inject inline
  let projectsData = { projects: [] }
  if (fs.existsSync(jsonPath)) {
    try { projectsData = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) } catch {}
  }

  // Escape for inline script
  const inlineJson = JSON.stringify(projectsData)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

  // Script that intercepts both fetch() and XMLHttpRequest for projects.json
  const intercept = `<script>
(function(){
  var _d=${inlineJson};
  var _f=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'&&u.replace(/[?#].*$/,'').endsWith('projects.json'))
      return Promise.resolve(new Response(JSON.stringify(_d),{status:200,headers:{'Content-Type':'application/json'}}));
    return _f.call(this,u,o);
  };
  var _X=window.XMLHttpRequest;
  function X2(){this._x=new _X();}
  ['onreadystatechange','onload','onerror','onabort','ontimeout'].forEach(function(e){
    Object.defineProperty(X2.prototype,e,{get:function(){return this._x[e];},set:function(v){this._x[e]=v;}});
  });
  X2.prototype.open=function(m,u){
    this._u=u;
    if(typeof u==='string'&&u.replace(/[?#].*$/,'').endsWith('projects.json'))
      this._hit=true;
    else this._x.open(m,u);
  };
  X2.prototype.send=function(){
    if(this._hit){var s=this;setTimeout(function(){
      Object.defineProperty(s,'readyState',{get:function(){return 4;}});
      Object.defineProperty(s,'status',{get:function(){return 200;}});
      Object.defineProperty(s,'responseText',{get:function(){return JSON.stringify(_d);}});
      if(s.onreadystatechange)s.onreadystatechange();
      if(s.onload)s.onload();
    },0);}else{this._x.send();}
  };
  ['setRequestHeader','abort','getAllResponseHeaders','getResponseHeader'].forEach(function(m){
    X2.prototype[m]=function(){return this._x[m].apply(this._x,arguments);};
  });
  window.XMLHttpRequest=X2;
})();
</script>`

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8')
    html = html.replace(/<head([^>]*)>/i, (m) => m + intercept)
    return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html)
  }

  // Fallback: render built-in summary page when reviewer/index.html hasn't been generated yet
  const matColors = { 'not ready': '#6b7280', 'internal only': '#d97706', 'soft launch ready': '#2563eb', 'public launch candidate': '#16a34a' }
  const cards = (projectsData.projects || []).map(p => {
    const m = String(p.maturity || '').toLowerCase()
    const c = Object.entries(matColors).find(([k]) => m.includes(k))?.[1] || '#6b7280'
    return `<div class="card"><div class="row"><span class="name">${p.name || p.id || '—'}</span><span class="badge" style="background:${c}22;color:${c}">${p.maturity || '—'}</span></div>${p.lastUpdated ? `<div class="date">${p.lastUpdated}</div>` : ''}</div>`
  }).join('')

  res.setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html><html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;padding:20px;background:#f8fafc;color:#1e293b}
h1{font-size:18px;font-weight:700;margin:0 0 16px;color:#0f172a}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.name{font-weight:600;font-size:14px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;flex-shrink:0}
.date{font-size:11px;color:#94a3b8;margin-top:6px}
.empty{text-align:center;padding:48px;color:#94a3b8;font-size:14px}
</style></head><body>
<h1>專案知識庫總覽</h1>
${cards ? `<div class="grid">${cards}</div>` : '<div class="empty">尚未建立任何專案。<br><small>請先完成工作流程 Step 5。</small></div>'}
</body></html>`)
})

// ── Session management helpers ────────────────────────────────────────────────

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getSessionsDir(provisionUserId) {
  return path.join(getUserPaths(provisionUserId).config, 'agents', 'main', 'sessions')
}

function parseSessionsIndex(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.sessions)) return raw.sessions
  // Object format: { "sessionKey": "uuid" } or { "sessionKey": { id, ... } }
  return Object.entries(raw || {}).map(([key, val]) => ({
    key,
    id: typeof val === 'string' ? val : (val?.id || val?.sessionId || null),
    ...(typeof val === 'object' && val !== null ? val : {}),
  }))
}

// ── Session list / delete routes ──────────────────────────────────────────────

app.get('/api/chat/sessions', requireAuth, async (req, res) => {
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const sessionsDir = getSessionsDir(provisionUserId)

  if (!fs.existsSync(sessionsDir)) return res.json({ sessions: [] })

  let indexEntries = []
  try {
    const indexPath = path.join(sessionsDir, 'sessions.json')
    if (fs.existsSync(indexPath)) {
      indexEntries = parseSessionsIndex(JSON.parse(fs.readFileSync(indexPath, 'utf8')))
    }
  } catch {}

  // Build a map: sessionId → sessionKey
  const idToKey = {}
  for (const entry of indexEntries) {
    const id = entry?.id || entry?.sessionId
    const key = entry?.key || entry?.sessionKey
    if (id && key) idToKey[id] = key
  }

  const sessions = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.trajectory'))
    .map(f => {
      const sessionId = f.replace('.jsonl', '')
      const stat = fs.statSync(path.join(sessionsDir, f))
      return {
        sessionId,
        sessionKey: idToKey[sessionId] || null,
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
      }
    })
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified))

  res.json({ sessions })
})

app.delete('/api/chat/sessions/:sessionId', requireAuth, async (req, res) => {
  const { sessionId } = req.params
  if (!SESSION_UUID_RE.test(sessionId)) {
    return res.status(400).json({ error: '無效的 session ID' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const sessionsDir = getSessionsDir(provisionUserId)

  // Security: ensure resolved paths stay inside sessionsDir
  const filesToDelete = [
    `${sessionId}.jsonl`,
    `${sessionId}.trajectory.jsonl`,
    `${sessionId}.trajectory-path.json`,
  ]

  let deleted = false
  for (const fname of filesToDelete) {
    const fpath = path.join(sessionsDir, fname)
    if (!fpath.startsWith(sessionsDir + path.sep) && fpath !== sessionsDir) {
      return res.status(403).json({ error: '無權限' })
    }
    if (fs.existsSync(fpath)) {
      fs.unlinkSync(fpath)
      deleted = true
    }
  }

  if (!deleted) return res.status(404).json({ error: '找不到 session' })

  // Remove from sessions.json index
  const indexPath = path.join(sessionsDir, 'sessions.json')
  if (fs.existsSync(indexPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      if (Array.isArray(raw)) {
        const filtered = raw.filter(s => (s?.id || s?.sessionId) !== sessionId)
        fs.writeFileSync(indexPath, JSON.stringify(filtered, null, 2), 'utf8')
      } else if (Array.isArray(raw?.sessions)) {
        raw.sessions = raw.sessions.filter(s => (s?.id || s?.sessionId) !== sessionId)
        fs.writeFileSync(indexPath, JSON.stringify(raw, null, 2), 'utf8')
      } else if (typeof raw === 'object') {
        // Object format: find key whose value references this id
        for (const [key, val] of Object.entries(raw)) {
          const id = typeof val === 'string' ? val : (val?.id || val?.sessionId)
          if (id === sessionId) { delete raw[key]; break }
        }
        fs.writeFileSync(indexPath, JSON.stringify(raw, null, 2), 'utf8')
      }
    } catch {}
  }

  res.json({ success: true, sessionId })
})

app.get('/api/chat/sessions/:sessionId/history', requireAuth, async (req, res) => {
  const { sessionId } = req.params
  if (!SESSION_UUID_RE.test(sessionId)) {
    return res.status(400).json({ error: '無效的 session ID' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const sessionsDir = getSessionsDir(provisionUserId)
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`)

  if (!fs.existsSync(filePath)) return res.json({ messages: [] })

  const messages = []
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj
      try { obj = JSON.parse(trimmed) } catch { continue }

      const msgObj = (obj.message && typeof obj.message === 'object') ? obj.message : obj
      const rawRole = (msgObj?.role ?? '').toLowerCase()

      if (rawRole === 'user' || rawRole === 'assistant') {
        let textContent = ''
        const contentArr = Array.isArray(msgObj.content) ? msgObj.content : []
        for (const block of contentArr) {
          if (block?.type === 'text') textContent += block.text || ''
        }
        if (!textContent && typeof msgObj.content === 'string') textContent = msgObj.content
        if (!textContent) continue

        messages.push({
          id: obj.id ?? msgObj.id ?? `${sessionId}-${messages.length}`,
          role: rawRole,
          content: rawRole === 'user' ? stripSenderMetadata(textContent) : textContent,
          events: [],
          timestamp: obj.timestamp ?? msgObj.timestamp ?? null,
          isStreaming: false,
        })
      } else if (rawRole === 'toolresult' || rawRole === 'tool_result') {
        const contentArr = Array.isArray(msgObj.content) ? msgObj.content : []
        let textContent = ''
        for (const block of contentArr) {
          if (block?.type === 'text') textContent += block.text || ''
        }
        if (!textContent && typeof msgObj.content === 'string') textContent = msgObj.content

        const toolName = msgObj.toolName ?? msgObj.name ?? null
        const isError = msgObj.isError ?? false

        // Attach to the most recent assistant message
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        if (lastAssistant) {
          lastAssistant.events.push({ role: 'toolresult', name: toolName, content: textContent, isError })
        }
      }
    }
  } catch (err) {
    console.error('[session-history] parse error:', err.message)
    return res.status(500).json({ error: '讀取歷史記錄失敗' })
  }

  res.json({ messages })
})

app.get('/api/chat/sessions/:sessionId/raw', requireAuth, async (req, res) => {
  const { sessionId } = req.params
  if (!SESSION_UUID_RE.test(sessionId)) {
    return res.status(400).json({ error: '無效的 session ID' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const sessionsDir = getSessionsDir(provisionUserId)
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`)

  if (!filePath.startsWith(sessionsDir + path.sep)) {
    return res.status(403).json({ error: '無權限' })
  }

  if (!fs.existsSync(filePath)) {
    return res.json({ lines: [], exists: false })
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim()).map(line => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
    res.json({ lines, exists: true })
  } catch {
    res.status(500).json({ error: '讀取 JSONL 失敗' })
  }
})

app.get('/api/chat/sessions/:sessionId/trajectory', requireAuth, async (req, res) => {
  const { sessionId } = req.params
  if (!SESSION_UUID_RE.test(sessionId)) {
    return res.status(400).json({ error: '無效的 session ID' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const sessionsDir = getSessionsDir(provisionUserId)
  const filePath = path.join(sessionsDir, `${sessionId}.trajectory.jsonl`)

  if (!filePath.startsWith(sessionsDir + path.sep)) {
    return res.status(403).json({ error: '無權限' })
  }

  if (!fs.existsSync(filePath)) {
    return res.json({ lines: [], exists: false })
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim()).map(line => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
    res.json({ lines, exists: true })
  } catch {
    res.status(500).json({ error: '讀取 trajectory 失敗' })
  }
})

app.delete('/api/chat/sessions', requireAuth, async (req, res) => {
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const sessionsDir = getSessionsDir(provisionUserId)

  if (!fs.existsSync(sessionsDir)) return res.json({ success: true, deleted: 0 })

  const files = fs.readdirSync(sessionsDir).filter(f =>
    (f.endsWith('.jsonl') || f.endsWith('.trajectory-path.json')) && f !== 'sessions.json'
  )
  let deleted = 0
  for (const fname of files) {
    const fpath = path.join(sessionsDir, fname)
    if (fpath.startsWith(sessionsDir + path.sep)) {
      fs.unlinkSync(fpath)
      deleted++
    }
  }

  const indexPath = path.join(sessionsDir, 'sessions.json')
  if (fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, JSON.stringify([]), 'utf8')
  }

  res.json({ success: true, deleted })
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
          llm: { idleTimeoutSeconds: 0 },
        },
      },
      gateway,
      session: { dmScope: 'per-channel-peer' },
      tools: { profile: 'coding' },
      plugins: {
        entries: {
          google: { enabled: true },
          tokenjuice: { enabled: true },
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
        sandbox: { mode: 'off' },
        model: { primary: modelRef },
        models: { [modelRef]: {} },
        llm: { idleTimeoutSeconds: 0 },
      },
    },
    models: {
      mode: 'merge',
      providers: {
        custom: {
          baseUrl,
          apiKey: apiKey || 'dummy-key',
          api: 'openai-completions',
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
    gateway,
    session: { dmScope: 'per-channel-peer' },
    tools: { profile: 'coding' },
    plugins: {
      entries: {
        tokenjuice: { enabled: true },
      },
    },
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
  fs.chmodSync(envPath, 0o666)
}

async function getProvisionUserId(authUserId) {
  const user = await getUserById(authUserId)
  if (user?.team_id) {
    const folder = await getWorkspaceFolder(user.team_id)
    if (folder) return folder
  }
  return authUserId
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

app.get('/api/provision/check-userid/:userId', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.params
  if (!/^[\w-]+$/.test(userId)) {
    return res.json({ available: false, reason: '格式不正確，只允許英文字母、數字、連字號與底線' })
  }
  const [cfg, ports] = await Promise.all([getContainerConfig(userId), getPortsForUser(userId)])
  const taken = !!(cfg || ports)
  res.json({ available: !taken, reason: taken ? '此 ID 已被使用' : null })
})

app.post('/api/provision', requireAuth, requireAdmin, async (req, res) => {
  const { userId, provider, geminiApiKey, baseUrl, apiKey, modelId, azureEndpoint, azureApiKey, azureDeploymentName, azureReasoningEffort } = req.body ?? {}

  if (!userId || !/^[\w-]+$/.test(userId)) {
    return res.status(400).json({ error: '無效的 userId' })
  }
  if (!provider || !['gemini', 'custom', 'azure'].includes(provider)) {
    return res.status(400).json({ error: '無效的 provider' })
  }
  if (provider === 'gemini' && !geminiApiKey) {
    return res.status(400).json({ error: '缺少 Gemini API Key' })
  }
  if (provider === 'custom' && (!baseUrl || !modelId)) {
    return res.status(400).json({ error: '缺少 Custom provider 設定' })
  }
  if (provider === 'azure' && (!azureEndpoint || !azureDeploymentName)) {
    return res.status(400).json({ error: '缺少 Azure OpenAI 設定' })
  }
  const [existingCfg, existingPorts] = await Promise.all([getContainerConfig(userId), getPortsForUser(userId)])
  if (existingCfg || existingPorts) {
    return res.status(409).json({ error: `userId "${userId}" 已被使用` })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const send = (type, text) => res.write(`data: ${JSON.stringify({ type, text })}\n\n`)

  // For azure, save credentials for the local proxy; OpenClaw points to proxy URL.
  if (provider === 'azure') {
    saveAzureProxyConfig(userId, {
      endpoint: azureEndpoint,
      apiKey: azureApiKey,
      deploymentName: azureDeploymentName,
      reasoningEffort: ['low', 'medium', 'high'].includes(azureReasoningEffort) ? azureReasoningEffort : 'high',
    })
  }

  const llmConfig = provider === 'gemini'
    ? { provider: 'gemini', geminiApiKey }
    : provider === 'azure'
      ? {
          provider: 'custom',
          baseUrl: `http://${CLAWPM_PROXY_HOST}:${RUNNING_PORT}/api/azure-proxy/${userId}/v1`,
          apiKey: 'dummy-key',
          modelId: azureDeploymentName,
        }
      : { provider: 'custom', baseUrl, apiKey, modelId }

  try {
    // 1. Allocate ports
    send('info', 'Allocating ports...')
    const ports = await allocatePorts(userId)
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
    fs.chmodSync(paths.openclawJson, 0o666)
    if (provider === 'gemini') {
      send('success', 'LLM provider: Gemini (google/gemini-2.5-flash)')
      applyEnvKey(path.join(paths.config, '.env'), 'GEMINI_API_KEY', geminiApiKey)
      send('success', 'GEMINI_API_KEY written to config/.env')
    } else if (provider === 'azure') {
      send('success', `LLM provider: Azure OpenAI (${llmConfig.modelId}) → ${llmConfig.baseUrl}`)
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
      {
        let waitSec = 0
        const heartbeat = setInterval(() => {
          waitSec += 15
          send('normal', `  ...建立中 (${waitSec}s)，請稍候`)
        }, 15_000)
        let containerId
        try {
          containerId = await Promise.race([
            createAndStartContainer(userId, {
              gatewayPort: ports.gatewayPort,
              bridgePort: ports.bridgePort,
              workspaceDir: paths.workspace,
              configDir: paths.config,
              gatewayToken,
            }),
            new Promise((_, reject) => setTimeout(
              () => reject(new Error('Container 建立逾時（3 分鐘），請確認 Docker Desktop 正常運作後再試')),
              180_000
            )),
          ])
        } finally {
          clearInterval(heartbeat)
        }
        send('success', `Container started: ${containerId.slice(0, 12)}`)

        await saveContainerConfig(userId, {
          containerId,
          gatewayPort: ports.gatewayPort,
          bridgePort: ports.bridgePort,
          gatewayToken,
          workspacePath: paths.workspace,
          provisionedAt: new Date().toISOString(),
        })
      }
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

    // 8. Link team → workspace so getProvisionUserId resolves correctly
    try {
      await completeTeamSetup(req.user.teamId, {
        provider,
        apiKey: provider === 'gemini' ? geminiApiKey : (llmConfig.apiKey ?? ''),
        baseUrl: provider === 'gemini' ? null : (llmConfig.baseUrl ?? null),
        model: provider === 'gemini' ? 'google/gemini-2.5-flash' : (llmConfig.modelId ?? ''),
        workspaceFolder: userId,
      })
    } catch (e) {
      console.warn('[provision] Could not link team to workspace:', e.message)
    }

    // Done
    const finalStatus = await getContainerStatus(userId)
    const savedConfig = await getContainerConfig(userId)
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
    try { await releasePorts(userId) } catch {}
    res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`)
    res.end()
  }
})

// ── Container management routes ───────────────────────────────────────────────

app.get('/api/container/stats', requireAuth, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
  const stats = await getContainerResourceStats(userId)
  res.json(stats ?? {})
})

app.get('/api/container/config', requireAuth, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
  const config = await getContainerConfig(userId)
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

// Update LLM config in openclaw.json and restart the container to apply it.
app.post('/api/container/update-llm', requireAuth, requireAdmin, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
  const { provider, geminiApiKey, baseUrl, apiKey, modelId, azureEndpoint, azureApiKey, azureDeploymentName, azureReasoningEffort } = req.body ?? {}

  if (!provider || !['gemini', 'custom', 'azure'].includes(provider)) {
    return res.status(400).json({ error: '無效的 provider' })
  }
  if (provider === 'gemini' && !geminiApiKey) {
    return res.status(400).json({ error: '缺少 Gemini API Key' })
  }
  if (provider === 'custom' && (!baseUrl || !modelId)) {
    return res.status(400).json({ error: '缺少 Custom provider 設定' })
  }
  if (provider === 'azure' && (!azureEndpoint || !azureDeploymentName)) {
    return res.status(400).json({ error: '缺少 Azure OpenAI 設定' })
  }

  const paths = getUserPaths(userId)
  const gatewayToken = readGatewayToken(paths)
  if (!gatewayToken) {
    return res.status(400).json({ error: '找不到 gateway token，請確認容器已完成初始化' })
  }

  const savedConfig = await getContainerConfig(userId).catch(() => null)
  const hostPort = savedConfig?.gatewayPort

  if (provider === 'azure') {
    saveAzureProxyConfig(userId, {
      endpoint: azureEndpoint,
      apiKey: azureApiKey,
      deploymentName: azureDeploymentName,
      reasoningEffort: ['low', 'medium', 'high'].includes(azureReasoningEffort) ? azureReasoningEffort : 'high',
    })
  }

  const llmConfig = provider === 'gemini'
    ? { provider: 'gemini', geminiApiKey }
    : provider === 'azure'
      ? {
          provider: 'custom',
          baseUrl: `http://${CLAWPM_PROXY_HOST}:${RUNNING_PORT}/api/azure-proxy/${userId}/v1`,
          apiKey: 'dummy-key',
          modelId: azureDeploymentName,
        }
      : { provider: 'custom', baseUrl, apiKey, modelId }

  try {
    const cfg = buildOpenClawConfig(gatewayToken, llmConfig, { hostPort })
    fs.writeFileSync(paths.openclawJson, JSON.stringify(cfg, null, 2), 'utf8')
    fs.chmodSync(paths.openclawJson, 0o666)

    if (provider === 'gemini') {
      applyEnvKey(path.join(paths.config, '.env'), 'GEMINI_API_KEY', geminiApiKey)
    }

    // Restart container to pick up the new config
    const status = await getContainerStatus(userId)
    if (status.exists) {
      if (status.running) await stopContainer(userId)
      await startContainer(userId)
    }

    // Sync team setup
    await completeTeamSetup(req.user.teamId, {
      provider,
      apiKey: provider === 'gemini' ? geminiApiKey : (llmConfig.apiKey ?? ''),
      baseUrl: provider === 'gemini' ? null : (llmConfig.baseUrl ?? null),
      model: provider === 'gemini' ? 'google/gemini-2.5-flash' : (llmConfig.modelId ?? ''),
      workspaceFolder: userId,
    }).catch(() => {})

    // Drop cached gateway client so next chat picks up fresh credentials
    disconnectClientForUser(userId)

    res.json({ success: true, provider, modelId: llmConfig.modelId ?? null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/container/restart', requireAuth, requireAdmin, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
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

app.delete('/api/container', requireAuth, requireAdmin, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
  try {
    const status = await getContainerStatus(userId)
    if (status.exists) await destroyContainer(userId)
    await releasePorts(userId)
    await deleteContainerConfig(userId)
    const team = req.user.teamId ? await resetTeamSetup(req.user.teamId) : null
    res.json({ success: true, userId, team })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Helper: demux Docker multiplexed log stream into individual log lines
function demuxDockerChunk(chunk, onLine) {
  let offset = 0
  while (offset < chunk.length) {
    if (offset + 8 > chunk.length) break
    const length = chunk.readUInt32BE(offset + 4)
    if (offset + 8 + length > chunk.length) break
    const payload = chunk.slice(offset + 8, offset + 8 + length).toString('utf8')
    offset += 8 + length
    const lines = payload.split('\n')
    for (const line of lines) {
      if (line) onLine(line)
    }
  }
}

app.get('/api/container/logs/stream', requireAuth, requireAdmin, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (text) => {
    res.write(`data: ${JSON.stringify({ text })}\n\n`)
    if (typeof res.flush === 'function') res.flush()
  }

  // Use `openclaw logs --follow` inside the container to stream the actual log file
  // (OpenClaw writes runtime logs to /tmp/openclaw/*.log, not stdout, so Docker logs API misses them)
  let execStream
  try {
    execStream = await execStreamInContainer(userId, ['node', 'dist/index.js', 'logs', '--follow'])
  } catch (err) {
    send(`[Error] ${err.message}`)
    return res.end()
  }

  execStream.on('data', (chunk) => demuxDockerChunk(chunk, send))
  execStream.on('end', () => res.end())
  execStream.on('error', (err) => { send(`[Error] ${err.message}`); res.end() })

  req.on('close', () => {
    try { execStream.destroy() } catch {}
  })
})

app.get('/api/container/logs/download', requireAuth, requireAdmin, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
  const filename = `openclaw-logs-${Date.now()}.txt`
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

  try {
    // follow:false → dockerode returns a Buffer (isStream=false), not a readable stream
    const result = await getContainerLogStream(userId, { follow: false, timestamps: true })
    if (Buffer.isBuffer(result)) {
      demuxDockerChunk(result, (line) => res.write(line + '\n'))
      res.end()
    } else {
      result.on('data', (chunk) => demuxDockerChunk(chunk, (line) => res.write(line + '\n')))
      result.on('end', () => res.end())
      result.on('error', () => res.end())
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
    else res.end()
  }
})

// ── Speaker voiceprint management (proxy to WhisperX) ─────────────────────────

const SPEAKER_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.mp4', '.ogg', '.flac', '.webm', '.aac'])

const speakerUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `clawpm-speaker-${Date.now()}${ext}`)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (SPEAKER_AUDIO_EXTS.has(ext)) return cb(null, true)
    cb(new Error('不支援的檔案格式，請上傳 MP3、WAV、M4A、MP4、OGG、FLAC、WebM 或 AAC'))
  },
})

const SPEAKER_TEAM_RE = /^[A-Za-z0-9_-]+$/

app.get('/api/speakers/:team', requireAuth, async (req, res) => {
  const { team } = req.params
  if (!SPEAKER_TEAM_RE.test(team)) return res.status(400).json({ error: 'team 名稱格式錯誤' })
  const headers = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}
  try {
    const upstream = await fetch(`${WHISPERX_BASE}/speakers/${encodeURIComponent(team)}`, { headers })
    const data = await upstream.json()
    res.status(upstream.status).json(data)
  } catch (err) {
    res.status(502).json({ error: `無法連線到語音辨識伺服器：${err.message}` })
  }
})

app.post('/api/speakers/:team/enroll', requireAuth, (req, res, next) => {
  speakerUpload.single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    next()
  })
}, async (req, res) => {
  const { team } = req.params
  if (!SPEAKER_TEAM_RE.test(team)) return res.status(400).json({ error: 'team 名稱格式錯誤' })
  if (!req.file) return res.status(400).json({ error: '未收到音訊檔案' })
  const { name, device } = req.body ?? {}
  if (!name?.trim()) return res.status(400).json({ error: '請提供 Speaker 名稱' })

  const formData = new FormData()
  const fileBuffer = fs.readFileSync(req.file.path)
  formData.append('audio', new Blob([fileBuffer], { type: req.file.mimetype }), req.file.originalname)
  formData.append('name', name.trim())
  if (device) formData.append('device', device)

  const headers = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}
  try {
    const upstream = await fetch(`${WHISPERX_BASE}/speakers/${encodeURIComponent(team)}/enroll`, { method: 'POST', headers, body: formData })
    const data = await upstream.json()
    res.status(upstream.status).json(data)
  } catch (err) {
    res.status(502).json({ error: `聲紋註冊失敗：${err.message}` })
  } finally {
    fs.unlink(req.file.path, () => {})
  }
})

app.get('/api/speakers/:team/:name/audio', requireAuth, async (req, res) => {
  const { team, name } = req.params
  if (!SPEAKER_TEAM_RE.test(team)) return res.status(400).json({ error: 'team 名稱格式錯誤' })
  const headers = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}
  try {
    const upstream = await fetch(`${WHISPERX_BASE}/speakers/${encodeURIComponent(team)}/${encodeURIComponent(name)}/audio`, { headers })
    if (!upstream.ok) return res.status(upstream.status).json({ error: '找不到聲紋音檔' })
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/wav')
    const reader = upstream.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  } catch (err) {
    res.status(502).json({ error: `無法取得音檔：${err.message}` })
  }
})

app.delete('/api/speakers/:team/:name', requireAuth, async (req, res) => {
  const { team, name } = req.params
  if (!SPEAKER_TEAM_RE.test(team)) return res.status(400).json({ error: 'team 名稱格式錯誤' })
  const headers = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}
  try {
    const upstream = await fetch(`${WHISPERX_BASE}/speakers/${encodeURIComponent(team)}/${encodeURIComponent(name)}`, { method: 'DELETE', headers })
    const data = await upstream.json()
    res.status(upstream.status).json(data)
  } catch (err) {
    res.status(502).json({ error: `刪除失敗：${err.message}` })
  }
})

// ── Azure OpenAI proxy ────────────────────────────────────────────────────────
// Handles two Azure models families:
//   mode "responses" : Codex models (gpt-5.3-codex) that only support Responses API.
//                      Translates chat/completions ↔ Responses API format.
//   mode "chat"      : Standard models (gpt-4o, gpt-4o-mini) that use chat/completions
//                      but require the Azure api-version query parameter.
//
// Set azureConfig.mode = 'chat' for standard models; 'responses' for Codex/reasoning.

function saveAzureProxyConfig(userId, config) {
  fs.mkdirSync(AZURE_CONFIGS_DIR, { recursive: true })
  // mode: 'responses' = Codex/reasoning models (Responses API)
  //       'chat'      = Standard models like gpt-4o (Chat Completions API)
  if (!config.mode) config.mode = 'responses'
  fs.writeFileSync(
    path.join(AZURE_CONFIGS_DIR, `${userId}.json`),
    JSON.stringify(config, null, 2),
    'utf8'
  )
}

function loadAzureProxyConfig(userId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(AZURE_CONFIGS_DIR, `${userId}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function handleAzureProxy(req, res) {
  const { userId } = req.params
  dbg(`[azure-proxy] ▶ userId=${userId} path=${req.path} stream=${!!req.body?.stream}`)
  if (!/^[\w-]+$/.test(userId)) {
    return res.status(400).json({ error: { message: 'Invalid userId' } })
  }

  const azureConfig = loadAzureProxyConfig(userId)
  if (!azureConfig?.endpoint || !azureConfig?.deploymentName) {
    dbgErr(`[azure-proxy] ✗ no config found for userId=${userId}`)
    return res.status(500).json({ error: { message: 'Azure config not found for this user' } })
  }

  const { endpoint, apiKey, deploymentName, mode = 'responses', reasoningEffort = 'medium' } = azureConfig
  const { messages, max_tokens, max_completion_tokens, stream, tools, tool_choice, ...restBody } = req.body
  dbg(`[azure-proxy] mode=${mode} deployment=${deploymentName} msgs=${messages?.length} tools=${tools?.length ?? 0} → ${endpoint}`)

  // ── Mode: chat — standard Azure OpenAI (gpt-4o, gpt-4o-mini, etc.) ──────────
  // Just add api-version and proxy the request through as-is.
  if (mode === 'chat') {
    const chatUrl = `${endpoint.replace(/\/+$/, '')}/openai/deployments/${deploymentName}/chat/completions?api-version=${AZURE_API_VERSION}`
    const chatBody = { messages, ...restBody }
    if (max_tokens || max_completion_tokens) chatBody.max_tokens = max_tokens || max_completion_tokens
    if (tools?.length) { chatBody.tools = tools; chatBody.tool_choice = tool_choice ?? 'auto' }

    if (stream) {
      chatBody.stream = true
      const azureRes = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) },
        body: JSON.stringify(chatBody),
      }).catch(err => { throw new Error(`Azure fetch error: ${err.message}`) })

      if (!azureRes.ok) {
        const errText = await azureRes.text().catch(() => '')
        dbgErr(`[azure-proxy] ✗ chat ${azureRes.status}: ${errText.slice(0, 200)}`)
        return res.status(azureRes.status).json({ error: { message: `Azure API ${azureRes.status}: ${errText}` } })
      }
      dbg(`[azure-proxy] ✓ chat streaming response started`)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      azureRes.body.pipe(res)
      return
    }

    const azureRes = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) },
      body: JSON.stringify(chatBody),
    }).catch(err => { throw new Error(`Azure fetch error: ${err.message}`) })
    const data = await azureRes.json()
    dbg(`[azure-proxy] ✓ chat responded choices=${data.choices?.length}`)
    return res.status(azureRes.status).json(data)
  }

  // ── Mode: responses — Codex/reasoning models (gpt-5.3-codex, etc.) ──────────
  // Full bidirectional translation between Chat Completions and Responses API formats,
  // including tool definitions, tool call requests, and tool call results.

  // 1. Tool definitions: Chat Completions → Responses API
  //    CC:  { type:"function", function:{ name, description, parameters } }
  //    RA:  { type:"function", name, description, parameters }
  function ccToolsToRA(ts) {
    if (!Array.isArray(ts) || !ts.length) return undefined
    return ts.map(t => t.type === 'function'
      ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }
      : t
    )
  }

  // 2. Conversation history: Chat Completions messages → Responses API input items
  //    Handles: system→instructions, role:tool→function_call_output,
  //             assistant+tool_calls→function_call items, regular messages→content-type fix
  function ccMessagesToRA(msgs) {
    const items = []
    let instructions = ''

    for (const msg of (msgs ?? [])) {
      const { role, content, tool_calls, tool_call_id } = msg

      // System messages → instructions field
      if (role === 'system') {
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.map(b => b.text ?? '').join('') : ''
        if (text) instructions += (instructions ? '\n\n' : '') + text
        continue
      }

      // Tool result messages → function_call_output items
      if (role === 'tool') {
        const output = typeof content === 'string' ? content
          : Array.isArray(content) ? content.map(b => b.text ?? b.content ?? '').join('') : String(content ?? '')
        items.push({ type: 'function_call_output', call_id: tool_call_id, output })
        continue
      }

      // Assistant messages that contain tool calls → function_call items
      if (role === 'assistant' && Array.isArray(tool_calls) && tool_calls.length) {
        for (const tc of tool_calls) {
          items.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' })
        }
        // Also emit any accompanying text (rare but valid)
        const txt = typeof content === 'string' ? content.trim()
          : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('').trim() : ''
        if (txt) items.push({ role: 'assistant', content: [{ type: 'output_text', text: txt }] })
        continue
      }

      // Regular user / assistant messages — normalize to block format.
      // Responses API requires assistant messages to use output_text blocks.
      // User messages accept plain strings or input_text blocks.
      if (role === 'assistant') {
        let blocks
        if (typeof content === 'string' && content) {
          blocks = [{ type: 'output_text', text: content }]
        } else if (Array.isArray(content)) {
          blocks = content.map(b => b.type === 'text' || b.type === 'output_text'
            ? { type: 'output_text', text: b.text ?? '' }
            : b
          ).filter(b => b.text !== '' || b.type !== 'output_text')
        }
        if (blocks?.length) items.push({ role: 'assistant', content: blocks })
      } else {
        // role === 'user'
        let c
        if (typeof content === 'string') {
          c = content
        } else if (Array.isArray(content)) {
          c = content.map(b => b.type === 'text'
            ? { ...b, type: 'input_text' }
            : b
          )
        } else {
          c = ''
        }
        if (c !== '' || c?.length > 0) items.push({ role: 'user', content: c })
      }
    }

    return { items, instructions: instructions || undefined }
  }

  // 3. Response: Azure Responses API output → Chat Completions format
  //    Handles both text responses and tool call responses (function_call output items)
  function raToCC(azureData) {
    const id = azureData.id || `chatcmpl-${Date.now()}`
    const created = azureData.created_at || Math.floor(Date.now() / 1000)
    const model = azureData.model || deploymentName
    const output = azureData.output ?? []

    // Tool calls returned by the model
    const fnCalls = output.filter(o => o.type === 'function_call')

    // Text content from the model
    const textParts = output
      .filter(o => o.type === 'message' && o.role === 'assistant')
      .flatMap(m => m.content ?? [])
      .filter(c => c.type === 'output_text')
      .map(c => c.text)

    let message, finishReason
    if (fnCalls.length > 0) {
      message = {
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: fnCalls.map(fc => ({
          id: fc.call_id,
          type: 'function',
          function: { name: fc.name, arguments: fc.arguments },
        })),
      }
      finishReason = 'tool_calls'
    } else {
      message = { role: 'assistant', content: textParts.join('') }
      finishReason = azureData.status === 'completed' ? 'stop' : 'length'
    }

    return {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: azureData.usage?.input_tokens ?? 0,
        completion_tokens: azureData.usage?.output_tokens ?? 0,
        total_tokens: azureData.usage?.total_tokens ?? 0,
      },
    }
  }

  // 4. SSE: serialize a complete chat.completion as SSE stream chunks
  //    Correctly formats tool_call chunks so OpenClaw can reconstruct them
  function toSSE(completion) {
    const msg = completion.choices[0].message
    const fin = completion.choices[0].finish_reason
    const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model }

    const parts = []
    parts.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: msg.tool_calls ? null : '' }, finish_reason: null }] })

    if (msg.tool_calls?.length) {
      msg.tool_calls.forEach((tc, i) => {
        parts.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }] })
        if (tc.function.arguments) {
          parts.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] })
        }
      })
    } else if (msg.content) {
      parts.push({ ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] })
    }

    parts.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: fin }] })
    return parts.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  }

  // Build the Responses API request
  const { items: raInput, instructions } = ccMessagesToRA(messages)
  const raTools = ccToolsToRA(tools)

  const responsesBody = {
    input: raInput,
    max_output_tokens: max_tokens || max_completion_tokens || 16384,
    model: deploymentName,
    reasoning: { effort: reasoningEffort },
  }
  if (instructions) responsesBody.instructions = instructions
  if (raTools?.length) { responsesBody.tools = raTools; responsesBody.tool_choice = 'auto' }

  dbg(`[azure-proxy] → Responses API: items=${raInput.length} tools=${raTools?.length ?? 0} instructions=${!!instructions}`)
  // Debug: show the role sequence of what we're sending so we can verify history is included
  const roleSeq = raInput.map(it => it.role ?? it.type).join(' → ')
  dbg(`[azure-proxy]   role seq: ${roleSeq}`)

  const azureUrl = `${endpoint.replace(/\/+$/, '')}/openai/responses?api-version=${AZURE_API_VERSION}`

  let azureData
  try {
    const azureRes = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(responsesBody),
    })
    if (!azureRes.ok) {
      const errText = await azureRes.text().catch(() => '')
      dbgErr(`[azure-proxy] ✗ responses ${azureRes.status}: ${errText.slice(0, 300)}`)
      return res.status(azureRes.status).json({ error: { message: `Azure API ${azureRes.status}: ${errText}` } })
    }
    azureData = await azureRes.json()
    const fnCount = (azureData.output ?? []).filter(o => o.type === 'function_call').length
    dbg(`[azure-proxy] ✓ responses status=${azureData.status} fnCalls=${fnCount} outputItems=${azureData.output?.length}`)
  } catch (err) {
    dbgErr(`[azure-proxy] ✗ fetch error: ${err.message}`)
    return res.status(502).json({ error: { message: `Azure proxy error: ${err.message}` } })
  }

  const completion = raToCC(azureData)

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.write(toSSE(completion))
    return res.end()
  }

  res.json(completion)
}

// Accept both /v1/chat/completions and /chat/completions since OpenClaw may try either
app.post('/api/azure-proxy/:userId/v1/chat/completions', handleAzureProxy)
app.post('/api/azure-proxy/:userId/chat/completions', handleAzureProxy)

// ── WebSocket chat ────────────────────────────────────────────────────────────

/**
 * Send a user message to OpenClaw and stream the response back to the frontend.
 * Content is read directly from the session JSONL file (source of truth).
 * Falls back to gateway chat.history polling if the file cannot be resolved.
 */
async function handleChatMessage(ws, authUserId, sessionKey, content) {
  const provisionUserId = await getProvisionUserId(authUserId)
  dbg(`[chat] ▶ user=${authUserId} prov=${provisionUserId} session=${sessionKey} msg="${content.slice(0, 40)}"`)

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }
  let client
  try {
    client = getClientForUser(provisionUserId)
    await client.ensureConnected()
    dbg(`[chat] ✓ gateway connected, scopes: ${client.grantedScopes?.join(', ') || 'none'}`)
  } catch (err) {
    dbgErr(`[chat] ✗ gateway connect failed: ${err.message}`)
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
          const prevMsg = {
            id: frontendMsgId,
            role: 'assistant',
            content: lastSentText,
            timestamp: new Date().toISOString(),
            events: processEntries,
          }
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
        dbg(`[chat] process_entries: ${processEntries.length} events`)
        send({ type: 'process_entries', entries: processEntries })
      }

      if (done) {
        dbg(`[chat] done: lastSentText=${lastSentText.length}chars events=${processEntries.length}`)
        if (lastSentText) {
          const assistantMsg = {
            id: frontendMsgId,
            role: 'assistant',
            content: lastSentText,
            timestamp: new Date().toISOString(),
            events: latestProcessEntries,
          }
          send({ type: 'message_complete', messageId: frontendMsgId, message: assistantMsg })
        } else {
          // Gateway returned nothing — cancel the placeholder bubble and surface an error.
          send({ type: 'message_complete', messageId: frontendMsgId, message: null })
          send({ type: 'error', message: '未收到任何回應，請確認 LLM API 金鑰與模型設定是否正確' })
        }
      }
    })

  } catch (err) {
    dbgErr('[chat] OpenClaw error:', err.message)
    send({ type: 'message_complete', messageId: frontendMsgId, message: null })
    send({ type: 'error', message: err.message })
  }
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws/chat' })

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') return
  console.error('[ws] server error:', err.message)
})

function getStartPort() {
  if (Number.isInteger(INITIAL_PORT) && INITIAL_PORT > 0 && INITIAL_PORT <= 65535) {
    return INITIAL_PORT
  }
  console.warn(`[startup] Invalid API_PORT "${process.env.API_PORT}", falling back to ${DEFAULT_PORT}`)
  return DEFAULT_PORT
}

function getPortRetryLimit() {
  if (Number.isInteger(PORT_RETRY_LIMIT) && PORT_RETRY_LIMIT >= 0) {
    return PORT_RETRY_LIMIT
  }
  console.warn(`[startup] Invalid API_PORT_RETRY_LIMIT "${process.env.API_PORT_RETRY_LIMIT}", falling back to 20`)
  return 20
}

function listenOnAvailablePort(port, remainingRetries = getPortRetryLimit()) {
  const onError = (err) => {
    server.off('listening', onListening)
    if (err.code !== 'EADDRINUSE' || remainingRetries <= 0) {
      throw err
    }

    const nextPort = port + 1
    console.warn(`[startup] Port ${port} is in use; trying ${nextPort}`)
    listenOnAvailablePort(nextPort, remainingRetries - 1)
  }

  const onListening = () => {
    server.off('error', onError)
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : port
    RUNNING_PORT = actualPort
    console.log(`ClawPM API server running on http://localhost:${actualPort}`)
  }

  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port)
}

// OpenClaw gateway prefixes user messages with sender metadata in JSONL storage.
// Strip it so only the actual user text is displayed.
// Format: "Sender (untrusted metadata): ```json {...} ``` [timestamp] actual_message"
function stripSenderMetadata(content) {
  if (typeof content !== 'string') return content
  const stripped = content.replace(/^Sender\s*\([^)]*\)\s*:?\s*```[a-z]*\s*\{[^`]*?\}\s*```\s*(?:\[[^\]]*\]\s*)?/i, '').trim()
  return stripped || content.trim()
}

async function loadLatestSessionHistory(provisionUserId) {
  const sessionsDir = getSessionsDir(provisionUserId)
  if (!fs.existsSync(sessionsDir)) return { history: [], sessionKey: getDefaultSessionKey() }

  // Find the most recently modified .jsonl (excluding .trajectory)
  let latestFile = null
  let latestMtime = 0
  try {
    for (const fname of fs.readdirSync(sessionsDir)) {
      if (!fname.endsWith('.jsonl') || fname.includes('.trajectory')) continue
      const fpath = path.join(sessionsDir, fname)
      const mtime = fs.statSync(fpath).mtimeMs
      if (mtime > latestMtime) { latestMtime = mtime; latestFile = fname }
    }
  } catch {}

  if (!latestFile) return { history: [], sessionKey: getDefaultSessionKey() }

  const sessionId = latestFile.replace('.jsonl', '')

  const filePath = path.join(sessionsDir, latestFile)
  const messages = []
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj
      try { obj = JSON.parse(trimmed) } catch { continue }
      const msgObj = (obj.message && typeof obj.message === 'object') ? obj.message : obj
      const rawRole = (msgObj?.role ?? '').toLowerCase()
      if (rawRole === 'user' || rawRole === 'assistant') {
        let textContent = ''
        const contentArr = Array.isArray(msgObj.content) ? msgObj.content : []
        for (const block of contentArr) {
          if (block?.type === 'text') textContent += block.text || ''
        }
        if (!textContent && typeof msgObj.content === 'string') textContent = msgObj.content
        if (!textContent) continue
        messages.push({
          id: obj.id ?? msgObj.id ?? `${sessionId}-${messages.length}`,
          role: rawRole,
          content: rawRole === 'user' ? stripSenderMetadata(textContent) : textContent,
          events: [],
          timestamp: obj.timestamp ?? msgObj.timestamp ?? null,
          isStreaming: false,
        })
      } else if (rawRole === 'toolresult' || rawRole === 'tool_result') {
        let textContent = ''
        const contentArr = Array.isArray(msgObj.content) ? msgObj.content : []
        for (const block of contentArr) {
          if (block?.type === 'text') textContent += block.text || ''
        }
        if (!textContent && typeof msgObj.content === 'string') textContent = msgObj.content
        const toolName = msgObj.toolName ?? msgObj.name ?? null
        const isError = msgObj.isError ?? false
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        if (lastAssistant) {
          lastAssistant.events.push({ role: 'toolresult', name: toolName, content: textContent, isError })
        }
      }
    }
  } catch {}

  // Always use the default 'agent:main:main' key for active session so streaming
  // remains stable. History is loaded from the latest file purely for display context.
  return { history: messages, sessionKey: getDefaultSessionKey() }
}

wss.on('connection', (ws) => {
  let authUserId = null
  let provisionUserId = null
  let sessionKey = getDefaultSessionKey()

  // Per-connection message queue: allows the user to send multiple messages
  // without waiting for each response. Messages are forwarded to OpenClaw in
  // order so the conversation context is preserved.
  const msgQueue = []
  let queueRunning = false

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }

  // Passive session watcher: forwards new JSONL entries to the frontend in
  // real-time when an external process (another OpenClaw client or agent) is
  // writing to the session file between user messages.
  let stopPassiveWatcher = null

  function restartPassiveWatcher() {
    if (stopPassiveWatcher) { stopPassiveWatcher(); stopPassiveWatcher = null }
    if (!provisionUserId) return

    let currentMsgId = null
    let lastSentText = ''
    let lastGatewayMsgId = null

    stopPassiveWatcher = startPassiveSessionWatcher(provisionUserId, sessionKey, ({ lastAssistantMsg, processEntries, done }) => {
      // Open a new bubble the first time we see any activity
      if (!currentMsgId && (processEntries.length > 0 || lastAssistantMsg)) {
        currentMsgId = randomUUID()
        send({ type: 'message_start', messageId: currentMsgId, sessionKey })
      }

      // New gateway assistant message — complete the previous bubble and start a new one
      if (lastAssistantMsg && lastAssistantMsg.id !== lastGatewayMsgId) {
        if (lastGatewayMsgId !== null && currentMsgId) {
          send({ type: 'message_complete', messageId: currentMsgId, message: {
            id: currentMsgId, role: 'assistant', content: lastSentText,
            timestamp: new Date().toISOString(), events: processEntries,
          }})
          lastSentText = ''
          currentMsgId = randomUUID()
          send({ type: 'message_start', messageId: currentMsgId, sessionKey })
        }
        lastGatewayMsgId = lastAssistantMsg.id
      }

      // Stream new characters
      if (lastAssistantMsg?.content && lastAssistantMsg.content.length > lastSentText.length) {
        const delta = lastAssistantMsg.content.slice(lastSentText.length)
        send({ type: 'chunk', messageId: currentMsgId, text: delta })
        lastSentText = lastAssistantMsg.content
      }

      // Forward tool events
      if (processEntries.length > 0 && currentMsgId) {
        send({ type: 'process_entries', entries: processEntries })
      }

      // Done: settle the completed message
      if (done && currentMsgId) {
        send({ type: 'message_complete', messageId: currentMsgId, message: {
          id: currentMsgId, role: 'assistant', content: lastSentText,
          timestamp: new Date().toISOString(), events: processEntries,
        }})
        currentMsgId = null
        lastSentText = ''
        lastGatewayMsgId = null
      }
    })
  }

  async function drainQueue() {
    if (queueRunning) return
    queueRunning = true
    // Suspend passive watcher during active send to avoid duplicate events
    if (stopPassiveWatcher) { stopPassiveWatcher(); stopPassiveWatcher = null }
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
    // Resume passive watcher after the send/stream cycle finishes
    restartPassiveWatcher()
  }

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'auth') {
      let decoded
      try {
        decoded = verifyToken(msg.token)
      } catch {
        send({ type: 'auth_error', message: 'Token 無效' })
        ws.close()
        return
      }
      authUserId = decoded.userId
      let history = []
      try {
        provisionUserId = await getProvisionUserId(authUserId)
        const result = await loadLatestSessionHistory(provisionUserId)
        history = result.history
        sessionKey = result.sessionKey
      } catch {}
      send({ type: 'auth_ok', history, sessionKey })
      restartPassiveWatcher()
      return
    }

    if (!authUserId) {
      send({ type: 'auth_error', message: '請先驗證身份' })
      return
    }

    if (msg.type === 'message' && typeof msg.content === 'string' && msg.content.trim()) {
      const userMsg = {
        id: randomUUID(),
        role: 'user',
        content: msg.content.trim(),
        timestamp: new Date().toISOString(),
        events: [],
      }
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

    if (msg.type === 'set_session' && typeof msg.sessionKey === 'string' && msg.sessionKey.trim()) {
      msgQueue.length = 0
      sessionKey = msg.sessionKey.trim()
      send({ type: 'session_changed', sessionKey })
      restartPassiveWatcher()
    }
  })

  ws.on('close', () => {
    msgQueue.length = 0
    if (stopPassiveWatcher) { stopPassiveWatcher(); stopPassiveWatcher = null }
  })

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message)
  })
})

// ── Task Management ───────────────────────────────────────────────────────────

app.get('/api/tasks', requireAuth, async (req, res) => {
  res.json(await listTasksForTeam(req.user.teamId))
})

app.get('/api/tasks/:id', requireAuth, async (req, res) => {
  const task = await getTask(req.params.id)
  if (!task) return res.status(404).json({ error: '找不到任務' })
  if (task.teamId !== req.user.teamId) return res.status(403).json({ error: '無權限' })
  res.json(task)
})

app.post('/api/tasks', requireAuth, async (req, res) => {
  const { meetingDate, audioFileName, data: initialData } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const task = await createTask({
    teamId: req.user.teamId,
    createdByUserId: req.user.userId,
    provisionUserId,
    meetingDate,
    audioFileName,
    data: initialData,
  })
  res.json(task)
})

app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  const task = await getTask(req.params.id)
  if (!task) return res.status(404).json({ error: '找不到任務' })
  if (task.teamId !== req.user.teamId) return res.status(403).json({ error: '無權限' })
  const updated = await updateTask(req.params.id, req.body)
  res.json(updated)
})

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  const task = await getTask(req.params.id)
  if (!task) return res.status(404).json({ error: '找不到任務' })
  if (task.teamId !== req.user.teamId) return res.status(403).json({ error: '無權限' })
  await deleteTask(req.params.id)
  res.json({ success: true })
})


app.post('/api/tasks/:id/retry', requireAuth, async (req, res) => {
  const task = await getTask(req.params.id)
  if (!task) return res.status(404).json({ error: '找不到任務' })
  if (task.teamId !== req.user.teamId) return res.status(403).json({ error: '無權限' })
  const updated = await retryTask(req.params.id)
  if (!updated) return res.status(400).json({ error: '任務不在錯誤狀態' })
  res.json(updated)
})

// ── Version ───────────────────────────────────────────────────────────────────

// Docker: /app/version.txt (COPY version.txt ./); dev: ../version.txt
const VERSION_FILE = fs.existsSync(path.resolve(__dirname, 'version.txt'))
  ? path.resolve(__dirname, 'version.txt')
  : path.resolve(__dirname, '../version.txt')

const RELEASE_NOTE_FILE = fs.existsSync(path.resolve(__dirname, 'release_note.txt'))
  ? path.resolve(__dirname, 'release_note.txt')
  : path.resolve(__dirname, '../release_note.txt')

app.get('/api/version', (_req, res) => {
  try {
    const version = fs.readFileSync(VERSION_FILE, 'utf8').trim()
    res.json({ version })
  } catch {
    res.json({ version: 'unknown' })
  }
})

app.get('/api/release-notes', (_req, res) => {
  try {
    const text = fs.readFileSync(RELEASE_NOTE_FILE, 'utf8')
    res.json({ content: text })
  } catch {
    res.json({ content: '' })
  }
})

// SPA fallback — must be after all API routes
app.get('{*any}', (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
})

// Run DB migrations, then legacy-data migration, then start
runMigrations()
  .then(() => migrateUsers())
  .then(() => {
    listenOnAvailablePort(getStartPort())
  })
  .catch(err => {
    console.error('[startup] Fatal error during migrations:', err?.message || err)
    if (err?.stack) console.error(err.stack)
    process.exit(1)
  })
