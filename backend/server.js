import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import multer from 'multer'
import { Client as FtpClient } from 'basic-ftp'
import nodemailer from 'nodemailer'
import { registerTeam, login, verifyToken, getUserById, createMember, listMembers, deleteMember, setMemberRole, migrateUsers } from './src/managers/UserManager.js'
import { listTeams, getTeam, completeTeamSetup, resetTeamSetup, getWorkspaceFolder } from './src/managers/TeamManager.js'
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
  getContainerResourceStats,
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
const DEFAULT_PORT = 3000
const INITIAL_PORT = Number.parseInt(process.env.API_PORT || `${DEFAULT_PORT}`, 10)
const PORT_RETRY_LIMIT = Number.parseInt(process.env.API_PORT_RETRY_LIMIT || '20', 10)
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'
const MAX_TERMS = parseInt(process.env.MAX_TERMS || '30', 10)
const WHISPERX_BASE = `http://${process.env.LOCAL_SERVER_IP || '172.22.12.162'}:${process.env.LOCAL_SERVER_PORT || '8787'}`
const WHISPERX_API_KEY = process.env.LOCAL_API_KEY || ''

// In-memory store for active transcription jobs
// jobId → { status, content, error }
const transcriptionJobs = new Map()

async function pollWhisperXJob(jobId, outputHostPath) {
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
const OPENCLAW_VERSION = OPENCLAW_IMAGE.split(':').pop() || '2026.4.22'

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true
}))
app.use(express.json())

// ── Auth routes ───────────────────────────────────────────────────────────────

// Public: list teams for login page
app.get('/api/teams', (_req, res) => {
  res.json(listTeams())
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

app.get('/api/user/me', requireAuth, (req, res) => {
  const user = getUserById(req.user.userId)
  if (!user) return res.status(404).json({ error: '用戶不存在' })
  const team = user.teamId ? getTeam(user.teamId) : null
  res.json({ ...user, team })
})

// Team setup (replaces /api/user/setup)
app.patch('/api/team/setup', requireAuth, requireAdmin, (req, res) => {
  const { provider, apiKey, baseUrl, model, workspaceFolder } = req.body ?? {}
  if (!provider || !apiKey || !model || !workspaceFolder) {
    return res.status(400).json({ error: '缺少必要的設定欄位' })
  }
  try {
    const team = completeTeamSetup(req.user.teamId, { provider, apiKey, baseUrl, model, workspaceFolder })
    res.json(team)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Keep old route for backward compat
app.patch('/api/user/setup', requireAuth, (req, res) => {
  const { provider, apiKey, baseUrl, model, workspaceFolder } = req.body ?? {}
  if (!provider || !apiKey || !model || !workspaceFolder) {
    return res.status(400).json({ error: '缺少必要的設定欄位' })
  }
  try {
    const team = completeTeamSetup(req.user.teamId, { provider, apiKey, baseUrl, model, workspaceFolder })
    res.json(team)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── Team member management routes (admin only) ────────────────────────────────

app.get('/api/team/members', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(listMembers(req.user.userId))
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

app.delete('/api/team/members/:memberId', requireAuth, requireAdmin, (req, res) => {
  try {
    deleteMember(req.user.userId, req.params.memberId)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.patch('/api/team/members/:memberId/role', requireAuth, requireAdmin, (req, res) => {
  const { role } = req.body ?? {}
  if (!role) return res.status(400).json({ error: '請指定角色' })
  try {
    const member = setMemberRole(req.user.userId, req.params.memberId, role)
    res.json(member)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── Chat history REST endpoint ────────────────────────────────────────────────

app.get('/api/chat/history', requireAuth, (req, res) => {
  const history = getChatHistory(req.user.userId)
  res.json({ messages: history })
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

  const provisionUserId = getProvisionUserId(req.user.userId)
  const ftpUser = process.env.FTP_USER || 'advantech'
  const ftpPass = process.env.FTP_PASS || 'changeme'
  const dateFolder = new Date().toISOString().slice(0, 10)
  const remoteDir = `/${provisionUserId}/workspace/ftp_data/media/${dateFolder}`
  const originalName = req.file.originalname

  const client = new FtpClient()
  try {
    await client.access({ host: '127.0.0.1', port: 2121, user: ftpUser, password: ftpPass, secure: false })
    // Override PASV address so data channel also connects to localhost
    client.ftp.pasvIpReplace = '127.0.0.1'
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

  const provisionUserId = getProvisionUserId(req.user.userId)
  const ftpUser = process.env.FTP_USER || 'advantech'
  const ftpPass = process.env.FTP_PASS || 'changeme'
  const dateFolder = new Date().toISOString().slice(0, 10)
  const remoteDir = `/${provisionUserId}/workspace/ftp_data/doc/${dateFolder}`
  const originalName = req.file.originalname

  const client = new FtpClient()
  try {
    await client.access({ host: '127.0.0.1', port: 2121, user: ftpUser, password: ftpPass, secure: false })
    client.ftp.pasvIpReplace = '127.0.0.1'
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

  const provisionUserId = getProvisionUserId(req.user.userId)
  const allowedPrefix = `/${provisionUserId}/workspace/ftp_data/doc/`
  if (!remotePath.startsWith(allowedPrefix)) {
    return res.status(403).json({ error: '無權限刪除此檔案' })
  }

  const ftpUser = process.env.FTP_USER || 'advantech'
  const ftpPass = process.env.FTP_PASS || 'changeme'

  const client = new FtpClient()
  try {
    await client.access({ host: '127.0.0.1', port: 2121, user: ftpUser, password: ftpPass, secure: false })
    client.ftp.pasvIpReplace = '127.0.0.1'
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

app.post('/api/workflow/prepare-extraction', requireAuth, (req, res) => {
  const { sourcePath, originalName } = req.body ?? {}
  const provisionUserId = getProvisionUserId(req.user.userId)
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

app.get('/api/workflow/extraction-tags', requireAuth, (req, res) => {
  const { outputPath } = req.query
  const provisionUserId = getProvisionUserId(req.user.userId)
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
  const { mediaPath, tags } = req.body ?? {}
  const provisionUserId = getProvisionUserId(req.user.userId)
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

  const formData = new FormData()
  const audioBuffer = fs.readFileSync(hostAudioPath)
  formData.append('audio', new Blob([audioBuffer]), path.basename(hostAudioPath))
  formData.append('lang', 'zh')
  if (Array.isArray(tags) && tags.length > 0) {
    formData.append('terms', tags.join(', '))
  }

  const whisperxHeaders = WHISPERX_API_KEY ? { 'X-API-Key': WHISPERX_API_KEY } : {}

  try {
    const uploadRes = await fetch(`${WHISPERX_BASE}/transcribe`, {
      method: 'POST',
      body: formData,
      headers: whisperxHeaders,
    })

    if (!uploadRes.ok) {
      const errBody = await uploadRes.json().catch(() => ({}))
      return res.status(502).json({ error: errBody.detail || `WhisperX 回傳 HTTP ${uploadRes.status}` })
    }

    const { job_id } = await uploadRes.json()
    transcriptionJobs.set(job_id, { status: 'pending', content: null, error: null })
    pollWhisperXJob(job_id, outputHostPath)

    res.json({ success: true, jobId: job_id, transcriptOutputPath })
  } catch (err) {
    console.error('[prepare-transcription] WhisperX error:', err.message)
    res.status(502).json({ error: `無法連接轉錄伺服器：${err.message}` })
  }
})

app.get('/api/workflow/transcription-result', requireAuth, (req, res) => {
  const { jobId } = req.query

  if (!jobId) return res.status(400).json({ error: '缺少 jobId 參數' })

  const job = transcriptionJobs.get(jobId)
  if (!job) return res.json({ ready: false, content: null, status: 'unknown' })

  if (job.status === 'done' && job.content) {
    return res.json({ ready: true, content: job.content })
  }
  if (job.status === 'failed') {
    return res.status(500).json({ error: job.error || '轉錄失敗' })
  }

  res.json({ ready: false, content: null, status: job.status })
})

// ── Meeting notes (Step 4) ────────────────────────────────────────────────────

app.post('/api/workflow/prepare-meeting-notes', requireAuth, (req, res) => {
  const { transcriptContainerPath } = req.body ?? {}
  const provisionUserId = getProvisionUserId(req.user.userId)

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!transcriptContainerPath || !transcriptContainerPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的逐字稿路徑' })
  }

  const transcriptDir = path.dirname(transcriptContainerPath)
  const transcriptBase = path.basename(transcriptContainerPath, '_逐字稿.md')
  const notesOutputContainerPath = `${transcriptDir}/${transcriptBase}_notes.md`

  const sessionKey = makeScopedSessionKey('meeting-notes')

  const prompt = [
    '請執行 meeting-transcription skill 的步驟 2：讀取逐字稿並生成會議記錄。',
    '',
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

app.get('/api/workflow/meeting-notes-result', requireAuth, (req, res) => {
  const { outputPath } = req.query
  const provisionUserId = getProvisionUserId(req.user.userId)
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
      text: content || '',
      attachments,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('[send-meeting-email] error:', err.message)
    res.status(500).json({ error: `郵件發送失敗：${err.message}` })
  }
})

// ── Project Insights (Step 5) ─────────────────────────────────────────────────

const CONTAINER_INSIGHTS_DIR = `${CONTAINER_WORKSPACE}/project-insights`

app.post('/api/workflow/prepare-insights', requireAuth, (req, res) => {
  const { transcriptContainerPath, notesContainerPath } = req.body ?? {}
  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  const provisionUserId = getProvisionUserId(req.user.userId)
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

  const today = new Date().toISOString().slice(0, 10)
  const sessionKey = makeScopedSessionKey('insights')

  const parts = [
    '請使用 project-insight-synthesizer skill，將本次會議資料增量更新至專案知識庫。',
    '',
    `本次會議日期：${today}`,
  ]
  if (transcriptContainerPath) parts.push(`本次會議逐字稿路徑：${transcriptContainerPath}`)
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
})

app.get('/api/workflow/insights-result', requireAuth, (req, res) => {
  const { insightsDir, beforeMtime } = req.query
  const provisionUserId = getProvisionUserId(req.user.userId)
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

app.get('/api/project-insights/list', requireAuth, (req, res) => {
  const provisionUserId = getProvisionUserId(req.user.userId)
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

app.get('/api/project-insights/file', requireAuth, (req, res) => {
  const { name } = req.query
  const provisionUserId = getProvisionUserId(req.user.userId)
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

app.post('/api/project-insights/create', requireAuth, (req, res) => {
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

  const provisionUserId = getProvisionUserId(req.user.userId)
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

app.patch('/api/project-insights/file', requireAuth, (req, res) => {
  const { name, content } = req.body ?? {}
  const provisionUserId = getProvisionUserId(req.user.userId)
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

app.delete('/api/project-insights/delete', requireAuth, (req, res) => {
  const { slug } = req.query
  if (!slug || typeof slug !== 'string' || slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return res.status(400).json({ error: '無效的專案識別碼' })
  }

  const provisionUserId = getProvisionUserId(req.user.userId)
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

app.get('/api/project-insights/viewer', (req, res) => {
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

  const provisionUserId = getProvisionUserId(user.userId)
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
  if (user?.teamId) {
    const folder = getWorkspaceFolder(user.teamId)
    if (folder) return folder
  }
  // backward compat: fall back to user-level setupConfig
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

app.get('/api/provision/check-userid/:userId', requireAuth, requireAdmin, (req, res) => {
  const { userId } = req.params
  if (!/^[\w-]+$/.test(userId)) {
    return res.json({ available: false, reason: '格式不正確，只允許英文字母、數字、連字號與底線' })
  }
  const taken = !!(getContainerConfig(userId) || getPortsForUser(userId))
  res.json({ available: !taken, reason: taken ? '此 ID 已被使用' : null })
})

app.post('/api/provision', requireAuth, requireAdmin, async (req, res) => {
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
  if (provider === 'custom' && (!baseUrl || !modelId)) {
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

    // 8. Link team → workspace so getProvisionUserId resolves correctly
    try {
      completeTeamSetup(req.user.teamId, {
        provider,
        apiKey: provider === 'gemini' ? geminiApiKey : (apiKey ?? ''),
        baseUrl: baseUrl ?? null,
        model: provider === 'gemini' ? 'google/gemini-2.5-flash' : (modelId ?? ''),
        workspaceFolder: userId,
      })
    } catch (e) {
      console.warn('[provision] Could not link team to workspace:', e.message)
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

app.get('/api/container/stats', requireAuth, async (req, res) => {
  const userId = getProvisionUserId(req.user.userId)
  const stats = await getContainerResourceStats(userId)
  res.json(stats ?? {})
})

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

app.post('/api/container/restart', requireAuth, requireAdmin, async (req, res) => {
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

app.delete('/api/container', requireAuth, requireAdmin, async (req, res) => {
  const userId = getProvisionUserId(req.user.userId)
  try {
    const status = await getContainerStatus(userId)
    if (status.exists) await destroyContainer(userId)
    releasePorts(userId)
    deleteContainerConfig(userId)
    const team = req.user.teamId ? resetTeamSetup(req.user.teamId) : null
    res.json({ success: true, userId, team })
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
    console.log(`ClawPM API server running on http://localhost:${actualPort}`)
  }

  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port)
}

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

    if (msg.type === 'set_session' && typeof msg.sessionKey === 'string' && msg.sessionKey.trim()) {
      msgQueue.length = 0
      sessionKey = msg.sessionKey.trim()
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

// Run migration once on startup to assign legacy users to teams
migrateUsers()

listenOnAvailablePort(getStartPort())
