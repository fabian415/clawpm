import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'
import multer from 'multer'
import archiver from 'archiver'
import { Client as FtpClient } from 'basic-ftp'
import nodemailer from 'nodemailer'
import { runMigrations } from './src/migrate.js'
import { query } from './src/db.js'
import { registerTeam, login, verifyToken, getUserById, createMember, listMembers, deleteMember, setMemberRole, migrateUsers, deleteAllTeamMembers } from './src/managers/UserManager.js'
import { listTeams, getTeam, completeTeamSetup, resetTeamSetup, getWorkspaceFolder, deleteTeam } from './src/managers/TeamManager.js'
import {
  getClientForUser, disconnectClientForUser,
  getDefaultSessionKey, makeScopedSessionKey,
  sendAndStream, getHistory as getGatewayHistory,
  startPassiveSessionWatcher,
} from './src/managers/OpenClawClient.js'
import { allocatePorts, releasePorts, getPortsForUser } from './src/containers/PortManager.js'
import {
  createTask, getTask, listTasksForTeam, updateTask, deleteTask, retryTask, sendAndStreamOrThrow,
  ensureProjectDescriptions, checkInsightsRegression, readProjectMarkdownSnapshot,
} from './src/managers/TaskManager.js'
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

// ess-kms 知識庫 GraphQL（供補充文件連結萃取 → 抓頁面內容用）。token 只放在後端，
// 不傳進容器；容器內腳本只負責從文件萃取 URL，實際抓取由後端完成。
const ESS_KMS_GRAPHQL_ENDPOINT = process.env.ESS_KMS_GRAPHQL_ENDPOINT || 'https://ess-kms.edgecenter.io/graphql'
const ESS_KMS_GRAPHQL_TOKEN = process.env.ESS_KMS_GRAPHQL_TOKEN || ''
const ESS_KMS_LOCALE = process.env.ESS_KMS_LOCALE || 'en'
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

async function monitorInsightsCompletion(taskId, projectsJsonHostPath, beforeMtime, followUp) {
  const MAX_CHECKS = 72  // 72 × 10s = 12 minutes max
  let checks = 0

  const check = async () => {
    checks++
    if (checks > MAX_CHECKS) return

    try {
      if (fs.existsSync(projectsJsonHostPath)) {
        const mtime = fs.statSync(projectsJsonHostPath).mtimeMs
        if (mtime > beforeMtime) {
          // 主要寫入已落地。在標記任務完成前，補跑跟 TaskManager.js 的 runInsightsStep 同一套
          // 收尾檢查（內容縮水偵測、description 補齊）——這個 workflow 是由前端聊天視窗直接
          // 觸發 LLM 對話，後端只負責準備 prompt 跟監測完成，這兩道保險原本只接在
          // TaskManager.js 的任務式流程上，沒有套用到這裡，所以一併補上。
          if (followUp) {
            try {
              // projects.json 剛被寫入時，agent 在前端聊天視窗裡的這一輪對話可能還在處理
              // 其他檔案（index.md、HTML），稍微等一下再插話，降低跟同一個 session 撞期的機率。
              await new Promise(r => setTimeout(r, 15000))
              await checkInsightsRegression(followUp.client, followUp.sessionKey, followUp.workspaceHostPath, followUp.beforeSnapshots)
              await ensureProjectDescriptions(followUp.client, followUp.sessionKey, followUp.workspaceHostPath)
            } catch (e) {
              console.warn('[insights-monitor] follow-up checks failed, leaving as-is:', e.message)
            }
          }

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

// multer/busboy 預設把 multipart 表單裡的 filename 欄位當 Latin-1 解碼；
// 瀏覽器實際送出的是 UTF-8 位元組，因此非 ASCII 檔名（例如中文）會變成雙重編碼亂碼。
// 這裡還原成正確的 UTF-8 字串，避免亂碼被寫進 FTP 路徑、進而流入 project-insights 的來源索引。
function fixUploadedFilename(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8')
  } catch {
    return name
  }
}

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
  const originalName = fixUploadedFilename(req.file.originalname)

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
  const originalName = fixUploadedFilename(req.file.originalname)

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

app.get('/api/workflow/download-doc', requireAuth, async (req, res) => {
  const { remotePath } = req.query
  if (!remotePath || typeof remotePath !== 'string') {
    return res.status(400).json({ error: '缺少 remotePath' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const allowedPrefix = `/${provisionUserId}/workspace/ftp_data/doc/`
  if (!remotePath.startsWith(allowedPrefix)) {
    return res.status(403).json({ error: '無權限存取此檔案' })
  }

  const filename = path.basename(remotePath)
  const ftpUser = process.env.FTP_USER || 'advantech'
  const ftpPass = process.env.FTP_PASS || 'changeme'
  const client = new FtpClient()
  try {
    const ftpHost = process.env.FTP_HOST || '127.0.0.1'
    const ftpPort = parseInt(process.env.FTP_PORT || '21')
    await client.access({ host: ftpHost, port: ftpPort, user: ftpUser, password: ftpPass, secure: false })
    client.ftp.pasvIpReplace = ftpHost
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    res.setHeader('Content-Type', 'application/octet-stream')
    await client.downloadTo(res, remotePath)
  } catch (err) {
    console.error('[download-doc] FTP error:', err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: `FTP 下載失敗：${err.message}` })
    }
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

// ── Terminology library ───────────────────────────────────────────────────────

app.get('/api/terminology', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, term, created_at FROM terminology WHERE team_id = $1 ORDER BY term ASC',
      [req.user.teamId]
    )
    res.json(rows)
  } catch (err) {
    console.error('[terminology] list error:', err.message)
    res.status(500).json({ error: '讀取辭庫失敗' })
  }
})

app.post('/api/terminology', requireAuth, async (req, res) => {
  const { term } = req.body ?? {}
  if (!term?.trim()) return res.status(400).json({ error: '術語不可為空' })
  try {
    const { rows } = await query(
      'INSERT INTO terminology (team_id, term) VALUES ($1, $2) ON CONFLICT (team_id, term) DO NOTHING RETURNING id, term, created_at',
      [req.user.teamId, term.trim()]
    )
    if (rows.length === 0) return res.status(409).json({ error: '術語已存在' })
    res.json(rows[0])
  } catch (err) {
    console.error('[terminology] add error:', err.message)
    res.status(500).json({ error: '新增術語失敗' })
  }
})

app.put('/api/terminology/:id', requireAuth, async (req, res) => {
  const { term } = req.body ?? {}
  if (!term?.trim()) return res.status(400).json({ error: '術語不可為空' })
  try {
    const { rows } = await query(
      'UPDATE terminology SET term = $1 WHERE id = $2 AND team_id = $3 RETURNING id, term, created_at',
      [term.trim(), req.params.id, req.user.teamId]
    )
    if (rows.length === 0) return res.status(404).json({ error: '術語不存在' })
    res.json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '術語已存在' })
    res.status(500).json({ error: '更新術語失敗' })
  }
})

app.delete('/api/terminology/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM terminology WHERE id = $1 AND team_id = $2',
      [req.params.id, req.user.teamId]
    )
    if (rowCount === 0) return res.status(404).json({ error: '術語不存在' })
    res.json({ success: true })
  } catch (err) {
    console.error('[terminology] delete error:', err.message)
    res.status(500).json({ error: '刪除術語失敗' })
  }
})

app.post('/api/terminology/bulk-add', requireAuth, async (req, res) => {
  const { terms } = req.body ?? {}
  if (!Array.isArray(terms) || terms.length === 0) return res.status(400).json({ error: '術語列表不可為空' })
  const cleanTerms = [...new Set(terms.map(t => String(t).trim()).filter(Boolean))]
  try {
    let added = 0
    for (const term of cleanTerms) {
      const { rowCount } = await query(
        'INSERT INTO terminology (team_id, term) VALUES ($1, $2) ON CONFLICT (team_id, term) DO NOTHING',
        [req.user.teamId, term]
      )
      added += rowCount
    }
    res.json({ added })
  } catch (err) {
    console.error('[terminology] bulk-add error:', err.message)
    res.status(500).json({ error: '批量新增失敗' })
  }
})

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

// ── Transcript save & AI repair (Step 3) ─────────────────────────────────────

app.post('/api/workflow/save-transcript', requireAuth, async (req, res) => {
  const { transcriptContainerPath, content } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!transcriptContainerPath || !transcriptContainerPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的逐字稿路徑' })
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: '無效的內容' })
  }

  const relPath = transcriptContainerPath.slice(CONTAINER_WORKSPACE.length)
  const hostPath = path.join(paths.workspace, relPath)
  if (!hostPath.startsWith(paths.workspace)) {
    return res.status(403).json({ error: '無權限' })
  }

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true })
    fs.writeFileSync(hostPath, content, 'utf8')
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: `儲存失敗：${err.message}` })
  }
})

app.post('/api/workflow/prepare-transcript-repair', requireAuth, async (req, res) => {
  const { transcriptContainerPath } = req.body ?? {}

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!transcriptContainerPath || !transcriptContainerPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的逐字稿路徑' })
  }

  const transcriptDir = path.dirname(transcriptContainerPath)
  const transcriptBase = path.basename(transcriptContainerPath, '_逐字稿.md')
  const repairedOutputContainerPath = `${transcriptDir}/${transcriptBase}_逐字稿_修復.md`

  const sessionKey = makeScopedSessionKey('transcript-repair')

  const prompt = [
    '請執行以下逐字稿雜訊修復任務：',
    '',
    `逐字稿檔案路徑：${transcriptContainerPath}`,
    `修復結果輸出路徑：${repairedOutputContainerPath}`,
    '',
    '修復規則（請嚴格遵守）：',
    '1. **完全保持原意** — 只修復雜訊，不改變說話者所表達的意思',
    '2. 移除語音辨識產生的填充詞（例如重複的「嗯」「啊」「那個」「就是說」等無意義詞）',
    '3. 修正明顯的語音辨識錯誤（同音字錯誤、句子中斷後重複的片段等）',
    '4. 若某段內容不確定如何修復，**保留原文，絕對不要猜測或改寫**',
    '5. 保持 Markdown 格式完全不變（時間戳 `**[HH:MM:SS → HH:MM:SS] Speaker:**`、段落分隔等）',
    '6. 不添加任何原文沒有的內容，不刪除有意義的對話',
    '',
    '請依序完成：',
    '1. 讀取逐字稿全文',
    '2. 對每個段落進行雜訊修復',
    `3. 將完整修復後的逐字稿寫入：${repairedOutputContainerPath}`,
    '',
    '請直接執行，無需確認。',
  ].join('\n')

  res.json({ success: true, sessionKey, prompt, repairedOutputContainerPath })
})

app.get('/api/workflow/transcript-repair-result', requireAuth, async (req, res) => {
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
    res.json({ ready: false, content: null })
  }
})

// ── Meeting notes (Step 4) ────────────────────────────────────────────────────

app.post('/api/workflow/prepare-meeting-notes', requireAuth, async (req, res) => {
  const { transcriptContainerPath, meetingDate, docFtpPaths } = req.body ?? {}
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

  const promptParts = [
    '請執行 meeting-transcription skill 的步驟 2：讀取逐字稿並生成會議記錄。',
    '',
    `本次會議日期：${resolvedDate}`,
    `逐字稿路徑：${transcriptContainerPath}`,
  ]

  // Convert FTP doc paths to container paths and include in prompt
  if (Array.isArray(docFtpPaths) && docFtpPaths.length > 0) {
    const provisionPrefix = `/${provisionUserId}/workspace`
    const validDocPaths = docFtpPaths.filter(p =>
      typeof p === 'string' && p.startsWith(`${provisionPrefix}/ftp_data/doc/`)
    )
    if (validDocPaths.length > 0) {
      const containerDocPaths = validDocPaths.map(p => `${CONTAINER_WORKSPACE}${p.slice(provisionPrefix.length)}`)
      promptParts.push(`本次會議補充文件（請一併參考這些文件內容，以豐富會議記錄的背景與專有名詞）：\n${containerDocPaths.map(p => `- ${p}`).join('\n')}，`)
    }
  }

  promptParts.push(
    '',
    '請依序完成：',
    '1. 讀取逐字稿全文',
    '2. 若有補充文件，讀取其內容以輔助理解背景',
    '3. 判斷錄音類型（商務會議 / 訪談與使用者研究 / 知識學習與演講 / 其他）',
    '4. 依對應格式生成完整會議記錄',
    `5. 將完整結果**寫入以下固定路徑**（無論類型皆統一輸出此路徑）：\n   ${notesOutputContainerPath}`,
    '',
    '請直接執行，無需確認。',
  )

  const prompt = promptParts.join('\n')

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

// 共用：把補充文件的 FTP 路徑轉成 container 內路徑（與 prepare-meeting-notes 相同邏輯）
function resolveDocContainerPaths(docFtpPaths, provisionUserId) {
  if (!Array.isArray(docFtpPaths) || docFtpPaths.length === 0) return []
  const provisionPrefix = `/${provisionUserId}/workspace`
  const validDocPaths = docFtpPaths.filter(p =>
    typeof p === 'string' && p.startsWith(`${provisionPrefix}/ftp_data/doc/`)
  )
  return validDocPaths.map(p => `${CONTAINER_WORKSPACE}${p.slice(provisionPrefix.length)}`)
}

// 把 AI 回覆裡可能夾帶的 ```json ... ``` 包裝拆掉，回傳乾淨的字串
function stripCodeFence(text) {
  return String(text || '').trim().replace(/^```(?:json|markdown|md)?\n?/, '').replace(/\n?```$/, '').trim()
}

// 行號定位替換：AI 指定 start_line/end_line，以 splice 方式替換，不做文字比對
function applyLinePatches(original, patches) {
  const norm = s => String(s || '').replace(new RegExp('\r\n', 'g'), '\n').replace(new RegExp('\r', 'g'), '\n')
  const lines = norm(original).split('\n')
  const sorted = [...patches].sort((a, b) => Number(b.start_line) - Number(a.start_line))
  for (const patch of sorted) {
    const start = parseInt(patch.start_line, 10)
    const end = parseInt(patch.end_line, 10)
    if (isNaN(start) || isNaN(end) || start < 1) continue
    const newLines = norm(String(patch.new_content ?? '')).split('\n')
    lines.splice(start - 1, end - start + 1, ...newLines)
  }
  return lines.join('\n')
}

// Step 4「AI 反思校正」第一步：請 AI 比對逐字稿/補充文件與目前的會議記錄，
// 回覆一份結構化問題清單（JSON），讓前端以「一題一題、GUI 選項」的方式呈現給使用者作答。
app.post('/api/workflow/review-meeting-notes', requireAuth, async (req, res) => {
  const { transcriptContainerPath, meetingNotesContent, meetingDate, docFtpPaths } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!transcriptContainerPath || !transcriptContainerPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的逐字稿路徑' })
  }
  if (typeof meetingNotesContent !== 'string' || !meetingNotesContent.trim()) {
    return res.status(400).json({ error: '沒有可供校正的會議記錄內容' })
  }

  const resolvedDate = meetingDate && /^\d{4}-\d{2}-\d{2}$/.test(meetingDate)
    ? meetingDate
    : new Date().toISOString().slice(0, 10)

  const promptParts = [
    '你是一位熟悉這份會議內容的討論夥伴。請先完整讀取以下逐字稿原文，再閱讀目前的會議記錄，依照記錄中實際討論到的議題，向「當時在場的與會者」提出 10 個開放性的內容問題。',
    '',
    `本次會議日期：${resolvedDate}`,
    `逐字稿路徑：${transcriptContainerPath}`,
  ]

  const containerDocPaths = resolveDocContainerPaths(docFtpPaths, provisionUserId)
  if (containerDocPaths.length > 0) {
    promptParts.push(`本次會議補充文件：\n${containerDocPaths.map(p => `- ${p}`).join('\n')}`)
  }

  promptParts.push(
    '',
    '目前的會議記錄（使用者可能已手動編輯，請以此為基準）：',
    '```',
    meetingNotesContent,
    '```',
    '',
    '【你的任務】',
    '請就會議記錄中的各個討論主題，逐一提問——目的是讓與會者「回想並說出他們對這個議題的真實看法或補充」，而不是驗證記錄是否正確。',
    '',
    '問題風格指引（以下是方向，不是固定格式）：',
    '- 針對某個具體的議題或決定，問：當時大家的想法是什麼？有沒有什麼考量是記錄裡沒有寫到的？',
    '- 針對某個行動項目，問：這件事有沒有前提條件、或你覺得最大的挑戰是什麼？',
    '- 針對某段討論，問：當時有沒有其他的方向被提出來，或被否決的選項？',
    '- 針對某個結論，問：這個結論是大家的共識，還是你個人覺得後來還有討論空間的？',
    '- 問與會者有沒有覺得記錄中哪件事重要程度被低估了，或哪件事其實沒那麼確定？',
    '',
    '問題應該具體、直接，每題都要讓人感覺是在討論這場會議本身發生的事，而不是在做技術審查。',
    '',
    '不要在這次回覆中修改任何檔案，也不要輸出任何說明文字、前言或客套話。請直接回覆一個 JSON 陣列字串（不要用 ```包住），格式如下：',
    '[{"question": "問題文字", "type": "text"}, {"question": "問題文字", "type": "choice", "options": ["選項一", "選項二", "其他／我自己填寫"]}]',
    '',
    '規則：',
    '- 總題數 10 題，若逐字稿或記錄內容真的太少，可以少於 10 題',
    '- 每一題都必須是 "choice" 類型，並根據逐字稿與會議記錄的實際內容，提供 2～3 個具體的可能答案作為選項',
    '- 選項不是隨便列幾個方向，而是根據逐字稿中真實出現過的觀點、說法或決定來歸納，讓與會者看到選項就能馬上對照自己的記憶',
    '- 每一題的選項中必須包含一個代表「目前會議記錄中的既有論點或表述」的選項，在文字前加上「(原意) 」標記（例如：「(原意) 目前記錄標示的結論是…」），讓使用者可以直接表示「原本的記錄已經正確」',
    '- 最後一個選項固定是「其他／我自己填寫」',
    '- 只回覆 JSON 本身，不要有任何其他文字',
  )
  const prompt = promptParts.join('\n')

  try {
    const client = getClientForUser(provisionUserId)
    const sessionKey = makeScopedSessionKey('meeting-notes-review-q')
    const lastMsg = await sendAndStreamOrThrow(client, sessionKey, prompt)
    const raw = stripCodeFence(lastMsg.content)

    let questions
    try {
      questions = JSON.parse(raw)
    } catch {
      return res.status(502).json({ error: 'AI 回覆格式無法解析，請重試一次' })
    }
    if (!Array.isArray(questions)) {
      return res.status(502).json({ error: 'AI 回覆格式不正確，請重試一次' })
    }

    const cleaned = questions
      .filter(q => q && typeof q.question === 'string' && q.question.trim())
      .slice(0, 10)
      .map(q => {
        const isChoice = q.type === 'choice' && Array.isArray(q.options) && q.options.filter(o => typeof o === 'string' && o.trim()).length >= 2
        return isChoice
          ? { question: q.question.trim(), type: 'choice', options: q.options.filter(o => typeof o === 'string' && o.trim()).slice(0, 5) }
          : { question: q.question.trim(), type: 'text' }
      })

    res.json({ success: true, questions: cleaned })
  } catch (err) {
    res.status(502).json({ error: err.message || 'AI 反思校正失敗' })
  }
})

// Step 4「AI 反思校正」第二步：使用者透過 GUI 一題一題回答後，送出全部問答，
// 請 AI 依據回答修正會議記錄全文，並直接覆寫回原本的固定輸出路徑。
app.post('/api/workflow/review-meeting-notes/apply', requireAuth, async (req, res) => {
  const { transcriptContainerPath, meetingNotesOutputPath, meetingNotesContent, meetingDate, docFtpPaths, answers } = req.body ?? {}
  const provisionUserId = await getProvisionUserId(req.user.userId)

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!transcriptContainerPath || !transcriptContainerPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的逐字稿路徑' })
  }
  if (!meetingNotesOutputPath || !meetingNotesOutputPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的會議記錄路徑' })
  }
  if (typeof meetingNotesContent !== 'string' || !meetingNotesContent.trim()) {
    return res.status(400).json({ error: '沒有可供校正的會議記錄內容' })
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: '沒有可套用的回答' })
  }

  const resolvedDate = meetingDate && /^\d{4}-\d{2}-\d{2}$/.test(meetingDate)
    ? meetingDate
    : new Date().toISOString().slice(0, 10)

  // 在後端就把「原意」與「補充」分類，只把真正需要納入的補充項丟給 AI。
  // 注意：前端送來的是結構化陣列（choice 帶 options 陣列、text 帶 text），
  // 不再是用「、」串接的字串，避免選項內容本身含「、」造成無法拆分。
  const isOriginalIntent = s => typeof s === 'string' && s.trimStart().startsWith('(原意)')
  const supplements = []
  for (const a of answers) {
    if (!a || typeof a.question !== 'string') continue
    if (a.type === 'text') {
      const t = (a.text || '').toString().trim()
      if (t) supplements.push({ question: a.question.trim(), additions: [t] })
      continue
    }
    const opts = Array.isArray(a.options) ? a.options : []
    const additions = opts
      .filter(o => typeof o === 'string' && o.trim() && !isOriginalIntent(o))
      .map(o => o.trim())
    if (additions.length > 0) supplements.push({ question: a.question.trim(), additions })
  }

  // 全部都是「(原意)」或未作答 → 沒有任何補充，直接回原文，不呼叫 AI。
  if (supplements.length === 0) {
    // console.log('[review-apply] no supplements (all 原意) → return unchanged')
    return res.json({ success: true, content: meetingNotesContent, unchanged: true })
  }

  const supplementText = supplements
    .map((s, i) => `${i + 1}. 主題：${s.question}\n   使用者補充（必須納入記錄）：\n${s.additions.map(t => `   - ${t}`).join('\n')}`)
    .join('\n\n')

  const normalizedNotes = meetingNotesContent.replace(new RegExp('\r\n', 'g'), '\n').replace(new RegExp('\r', 'g'), '\n')
  const numberedContent = normalizedNotes.split('\n').map((line, i) => (i + 1) + ': ' + line).join('\n')

  const promptParts = [
    '你是一位會議記錄編輯。使用者針對會議記錄提出了以下「補充看法」，這些看法目前可能未完整反映在記錄中。',
    '你的任務是把每一則補充看法，整合進會議記錄中最相關的段落，產出修改清單。',
    '',
    `本次會議日期：${resolvedDate}`,
  ]

  const containerDocPaths = resolveDocContainerPaths(docFtpPaths, provisionUserId)
  if (containerDocPaths.length > 0) {
    promptParts.push(`逐字稿路徑：${transcriptContainerPath}`)
    promptParts.push(`補充文件：\n${containerDocPaths.map(p => `- ${p}`).join('\n')}`)
  }

  promptParts.push(
    '',
    '【使用者補充看法】（每一則都「必須」反映到記錄中，不可忽略）',
    supplementText,
    '',
    '原始會議記錄（每行前面標有行號）：',
    '```',
    numberedContent,
    '```',
    '',
    '【你的任務】針對上方每一則補充看法，找出會議記錄中最相關的行範圍，將補充內容自然地整合進去（保留原有內容、在其後補述或調整措辭），輸出以下格式的 JSON（只輸出 JSON，不要前言或 ``` 包裝）：',
    '',
    '{"patches":[{"start_line":42,"end_line":44,"new_content":"整合補充後的完整內容（不含行號、可包含換行）"}]}',
    '',
    '欄位說明：',
    '- start_line：要替換的起始行號（對應上方行號欄位，整數）',
    '- end_line：要替換的結束行號（含該行，整數）',
    '- new_content：替換後的完整文字（不含行號前綴，可多行用 \\n 分隔）',
    '',
    '【硬性規則】',
    `- 上方共有 ${supplements.length} 則補充看法，你至少要產出 ${supplements.length} 個對應的 patch（除非某則確實已完整存在於記錄中）`,
    '- 整合時保留原有敘述，把補充看法併入，不要刪除原本資訊',
    '- 日期（標題、頁首、文內所有日期）絕對不得修改',
    '- new_content 必須是整合後該行範圍的完整內容，不可只寫新增片段',
  )

  const prompt = promptParts.join('\n')
  // console.log('[review-apply] supplements:', supplements.length, JSON.stringify(supplements).slice(0, 400))
  // console.log('[review-apply] === FULL PROMPT START ===\n' + prompt + '\n=== FULL PROMPT END ===')

  try {
    const client = getClientForUser(provisionUserId)
    const sessionKey = makeScopedSessionKey('meeting-notes-review-apply-' + Date.now())
    const lastMsg = await sendAndStreamOrThrow(client, sessionKey, prompt)
    const rawJson = stripCodeFence(lastMsg.content)
    // console.log('[review-apply] AI raw response:', rawJson.slice(0, 500))

    let parsed
    try { parsed = JSON.parse(rawJson) } catch {
      console.error('[review-apply] JSON parse error, raw:', rawJson.slice(0, 300))
      return res.status(502).json({ error: 'AI 回覆格式異常（非 JSON），請重試' })
    }
    if (!Array.isArray(parsed?.patches)) {
      console.error('[review-apply] missing patches array, parsed:', JSON.stringify(parsed).slice(0, 300))
      return res.status(502).json({ error: 'AI 回覆格式異常（缺少 patches 陣列），請重試' })
    }
    // console.log('[review-apply] patches count:', parsed.patches.length, JSON.stringify(parsed.patches).slice(0, 500))

    const corrected = applyLinePatches(meetingNotesContent, parsed.patches)
    // console.log('[review-apply] original length:', meetingNotesContent.length, 'corrected length:', corrected.length, 'same:', corrected === meetingNotesContent)

    if (!corrected || corrected.trim().length < 20) {
      return res.status(502).json({ error: 'AI 回覆內容為空，請重試一次，原記錄未被覆寫' })
    }

    const paths = getUserPaths(provisionUserId)
    const relPath = meetingNotesOutputPath.slice(CONTAINER_WORKSPACE.length)
    const hostPath = path.join(paths.workspace, relPath)
    if (!hostPath.startsWith(paths.workspace)) {
      return res.status(403).json({ error: '無權限' })
    }

    fs.writeFileSync(hostPath, corrected, 'utf8')
    res.json({ success: true, content: corrected })
  } catch (err) {
    res.status(502).json({ error: err.message || 'AI 套用校正失敗' })
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
  const fromName = process.env.EMAIL_FROM_NAME || 'MemoSynth 會議助理'

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
const IMAGE_EXTRACT_SCRIPT = `${CONTAINER_WORKSPACE}/skills/project-insight-synthesizer/scripts/extract_supplementary_images.py`
const LINK_EXTRACT_SCRIPT = `${CONTAINER_WORKSPACE}/skills/project-insight-synthesizer/scripts/extract_supplementary_links.py`
const IMAGE_SOURCE_EXTS = new Set(['.pptx', '.xlsx', '.pdf'])

// Convert FTP-relative doc paths (as stored when uploaded) into container-visible absolute paths.
function ftpDocPathsToContainerPaths(provisionUserId, docFtpPaths) {
  if (!Array.isArray(docFtpPaths) || docFtpPaths.length === 0) return []
  const provisionPrefix = `/${provisionUserId}/workspace`
  return docFtpPaths
    .filter(p => typeof p === 'string' && p.startsWith(`${provisionPrefix}/ftp_data/doc/`))
    .map(p => `${CONTAINER_WORKSPACE}${p.slice(provisionPrefix.length)}`)
}

app.post('/api/workflow/prepare-insights', requireAuth, async (req, res) => {
  const { transcriptContainerPath, notesContainerPath, meetingDate, taskId, docFtpPaths } = req.body ?? {}
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
      .map(p => ({ name: p.name, slug: p.slug || p.id, description: p.description || '' }))
  } catch {}

  // 跟 TaskManager.js 的 runInsightsStep 一樣，先在觸發 skill 前讀出每個既有專案目前的
  // Markdown 快照（只在後端本地比對用，不塞進 prompt），事後給 checkInsightsRegression 用。
  const beforeSnapshots = {}
  for (const p of knownProjects) {
    const snap = readProjectMarkdownSnapshot(paths.workspace, p.slug)
    if (snap) beforeSnapshots[p.slug] = snap
  }

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
  if (notesContainerPath) parts.push(`本次會議記錄路徑：${notesContainerPath}，`)

  // Convert FTP doc paths to container-visible paths and include in prompt
  const insightsDocPaths = ftpDocPathsToContainerPaths(provisionUserId, docFtpPaths)
  if (insightsDocPaths.length > 0) {
    parts.push(`本次會議補充文件（請一併參考這些文件內容進行洞見整合）：\n${insightsDocPaths.map(p => `- ${p}`).join('\n')}，`)
  }

  parts.push('', `專案知識庫目錄：${CONTAINER_INSIGHTS_DIR}/`, '，')

  if (knownProjects.length > 0) {
    parts.push(
      '知識庫中已有以下專案（Markdown 文件已就緒），請優先將本次會議內容對應至這些專案進行增量整併：',
      ...knownProjects.map(p => `- ${p.name}（${p.slug}.md）${p.description ? `：${p.description}` : '（尚無 description，請依本次與既有內容補上）'}`),
      '',
      '請依照 skill 工作流程完整執行：',
      '1. 用 Read 工具讀取上方所列專案的 Markdown 文件，取得目前版本作為比對與插入錨點的依據',
      '2. 檔案已存在時，現狀型章節一律用 Edit 工具定點插入新 bullet（以章節標題作錨點），不要用 Write 整份覆寫；只有新建專案檔案時才用 Write',
      '3. 嚴格遵守 references/markdown-schema.md 的「增量寫作鐵則」：逐筆累加、不可整節覆寫、不可刪除舊 bullet（只能加註取代標記）',
      '4. 同步維護 reviewer/projects.json 裡每個專案的 description 欄位（1-3 句話描述範疇與關鍵字，供記錄分發/圖片分類等其他流程比對用）：沒有就補上，已經過時或不夠精確就直接覆寫成更準確的版本',
      '5. 執行 Step 5.5 自查：確認每個 Edit 的錨點唯一且正確、新 bullet 都帶日期來源',
      '6. 若本次會議出現上述清單以外的新主題，可自動新增對應 Markdown 與 description',
      '7. 同步更新 index.md、reviewer/projects.json 與相關 HTML 檔',
      '8. 完成後回報各專案更新情況、目前進度、對外發表成熟度、主要缺口，以及 Step 5.5 自查結果',
      '',
      '最後檢查所有的Markdown檔案寫入時，\n 要取代成斷行。',
    )
  } else {
    parts.push(
      '請依照 skill 工作流程完整執行：',
      '1. 讀取現有 project-insights/ 目錄中的所有專案 Markdown（若存在）',
      '2. 偵測本次會議涉及哪些專案',
      '3. 以增量合併方式更新每個涉及的專案 Markdown',
      '4. 若出現新專案主題，自動建立對應新 Markdown 檔，並在 reviewer/projects.json 寫上 description（1-3 句話描述範疇與關鍵字，供記錄分發/圖片分類等其他流程比對用）',
      '5. 同步更新 index.md、reviewer/projects.json 與相關 HTML 檔',
      '6. 完成後回報已更新哪些專案、目前進度、對外發表成熟度與主要缺口',
      '',
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
    const client = getClientForUser(provisionUserId)
    monitorInsightsCompletion(taskId, projectsJsonHostPath, beforeMtime, {
      client, sessionKey, workspaceHostPath: paths.workspace, beforeSnapshots,
    })
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

// Bundles a project's knowledge base file plus its SWOT/market/tech/record
// archives and any _assets images referenced from those markdown files into
// a single zip for the user to download.
app.get('/api/project-insights/export', requireAuth, async (req, res) => {
  const { slug } = req.query
  if (!validSlug(slug)) {
    return res.status(400).json({ error: '無效的專案識別碼' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const mdPath = path.join(hostInsightsDir, `${slug}.md`)

  if (!mdPath.startsWith(hostInsightsDir + path.sep) || !fs.existsSync(mdPath)) {
    return res.status(404).json({ error: '專案不存在' })
  }

  const referencedAssets = new Set()
  const collectAssetRefs = (content) => {
    for (const m of content.matchAll(/_assets\/([^)\s"']+)/g)) referencedAssets.add(m[1])
  }

  const archive = archiver('zip', { zlib: { level: 9 } })
  archive.on('error', (err) => {
    console.error('[export] archive error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: '匯出失敗' })
    else res.end()
  })

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-export.zip"`)
  archive.pipe(res)

  const mdContent = fs.readFileSync(mdPath, 'utf8')
  collectAssetRefs(mdContent)
  archive.append(mdContent, { name: `${slug}.md` })

  const subDirs = [
    ['record', recordDir],
    ['swot', swotDir],
    ['market', marketDir],
    ['tech', techDir],
    ['supplements', supplementsDir],
    ['pptx', pptxDir],
  ]
  for (const [label, dirFn] of subDirs) {
    const dir = dirFn(hostInsightsDir, slug)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) collectAssetRefs(fs.readFileSync(path.join(dir, f), 'utf8'))
    }
    archive.directory(dir, `${label}-${slug}`)
  }

  const assetsDir = assetsDirFor(hostInsightsDir)
  if (fs.existsSync(assetsDir)) {
    for (const file of referencedAssets) {
      const assetPath = path.join(assetsDir, file)
      if (assetPath.startsWith(assetsDir + path.sep) && fs.existsSync(assetPath)) {
        archive.file(assetPath, { name: `_assets/${file}` })
      }
    }
  }

  archive.finalize()
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
  const { name, description } = req.body ?? {}
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
      description: typeof description === 'string' ? description.trim() : '',
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

// description：1-3 句話描述專案範疇與關鍵字，供記錄分發、補充圖片分類建議等自動化流程比對用。
app.patch('/api/project-insights/description', requireAuth, async (req, res) => {
  const { slug, description } = req.body ?? {}
  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })
  if (typeof description !== 'string') return res.status(400).json({ error: '無效的描述內容' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const projectsJsonPath = path.join(hostInsightsDir, 'reviewer', 'projects.json')

  const projectsData = readJsonSafe(projectsJsonPath)
  if (!projectsData || !Array.isArray(projectsData.projects)) {
    return res.status(404).json({ error: '找不到專案清單' })
  }

  const project = projectsData.projects.find(p => (p.slug || p.id) === slug)
  if (!project) return res.status(404).json({ error: '找不到對應的專案' })

  project.description = description.trim()
  try {
    writeJsonSafe(projectsJsonPath, projectsData)
    res.json({ success: true, slug, description: project.description })
  } catch {
    res.status(500).json({ error: '儲存失敗' })
  }
})

// 用 AI 根據專案目前的 Markdown 內容草擬一段 description，回傳給前端讓使用者確認/編輯後再儲存
// （不直接寫入 projects.json，維持「AI 建議、人工確認」的一致設計）。
app.post('/api/project-insights/description/generate', requireAuth, async (req, res) => {
  const { slug } = req.body ?? {}
  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const mdPath = path.join(hostInsightsDir, `${slug}.md`)

  let content = ''
  try { content = fs.readFileSync(mdPath, 'utf8') } catch {}
  if (!content.trim()) return res.status(404).json({ error: '找不到專案內容，無法生成描述' })

  const projectsData = readJsonSafe(path.join(hostInsightsDir, 'reviewer', 'projects.json'))
  const project = (projectsData?.projects || []).find(p => (p.slug || p.id) === slug)
  const displayName = project?.name || slug

  const prompt = [
    `請根據以下專案 Markdown 內容，幫我寫一個 1-3 句話的「專案描述」。`,
    `這段描述會被其他自動化流程（會議記錄分發、補充圖片分類建議）拿來判斷會議內容或圖片是否屬於這個專案，請盡量具體列出技術領域、核心關鍵字、產品／技術名詞，不要寫空泛的形容詞。`,
    `只回覆描述本身的文字，不要加引號、不要加「好的」之類的開頭客套話、不要條列、不要任何額外說明。`,
    ``,
    `專案名稱：${displayName}`,
    `專案內容：`,
    content.slice(0, 20000),
  ].join('\n')

  try {
    const client = getClientForUser(provisionUserId)
    const sessionKey = makeScopedSessionKey('describe')
    const lastMsg = await sendAndStreamOrThrow(client, sessionKey, prompt)
    const description = (lastMsg.content || '').trim().replace(/^["「]|["」]$/g, '')
    res.json({ success: true, description })
  } catch (err) {
    res.status(502).json({ error: err.message || 'AI 生成描述失敗' })
  }
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

// ── SWOT Reports ──────────────────────────────────────────────────────────────

// SWOT files live in project-insights/swot-{slug}/{YYYYMMDD}-{HHmmss}.md

function swotDir(hostInsightsDir, slug) {
  return path.join(hostInsightsDir, `swot-${slug}`)
}

function swotFilePath(hostInsightsDir, slug, name) {
  const dir = swotDir(hostInsightsDir, slug)
  const safeFile = name.endsWith('.md') ? name : `${name}.md`
  const full = path.join(dir, safeFile)
  // must stay within the swot subfolder
  if (!full.startsWith(dir + path.sep)) return null
  return full
}

function marketDir(hostInsightsDir, slug) {
  return path.join(hostInsightsDir, `market-${slug}`)
}

function marketFilePath(hostInsightsDir, slug, name) {
  const dir = marketDir(hostInsightsDir, slug)
  const safeFile = name.endsWith('.md') ? name : `${name}.md`
  const full = path.join(dir, safeFile)
  if (!full.startsWith(dir + path.sep)) return null
  return full
}

function techDir(hostInsightsDir, slug) {
  return path.join(hostInsightsDir, `tech-${slug}`)
}

function techFilePath(hostInsightsDir, slug, name) {
  const dir = techDir(hostInsightsDir, slug)
  const safeFile = name.endsWith('.md') ? name : `${name}.md`
  const full = path.join(dir, safeFile)
  if (!full.startsWith(dir + path.sep)) return null
  return full
}

function recordDir(hostInsightsDir, slug) {
  return path.join(hostInsightsDir, `record-${slug}`)
}

function recordFilePath(hostInsightsDir, slug, name) {
  const dir = recordDir(hostInsightsDir, slug)
  const safeFile = name.endsWith('.md') ? name : `${name}.md`
  const full = path.join(dir, safeFile)
  if (!full.startsWith(dir + path.sep)) return null
  return full
}

function validDateFilename(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

// 補充文件圖片的人工分類審核：agent 只負責萃取＋建議（寫進 suggestions-{date}.json），
// 實際要分到哪個專案、最終文字說明，一律由使用者在前端確認後才透過下方 confirm 端點寫入。
// 只在 manifest 是「最近產生的」時才視為這次會議的圖片，避免把舊會議留下的 manifest 誤判成這次的。
const IMAGE_REVIEW_FRESHNESS_MS = 2 * 60 * 60 * 1000

function assetsDirFor(hostInsightsDir) {
  return path.join(hostInsightsDir, '_assets')
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function writeJsonSafe(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
}

function suggestionsPathFor(hostInsightsDir, meetingDate) {
  return path.join(assetsDirFor(hostInsightsDir), `suggestions-${meetingDate}.json`)
}

function assignmentsPathFor(hostInsightsDir, meetingDate) {
  return path.join(assetsDirFor(hostInsightsDir), `assignments-${meetingDate}.json`)
}

// 圖片 manifest 也綁定會議日期，避免舊會議留下的 manifest.json 在 2 小時新鮮度視窗內被誤讀成這次會議的。
function imageManifestPathFor(hostInsightsDir, meetingDate) {
  return path.join(assetsDirFor(hostInsightsDir), `manifest-${meetingDate}.json`)
}

// ── 補充文件 ess-kms 連結分發 ────────────────────────────────────────────────
// 容器內的 extract_supplementary_links.py 只把 URL 萃取進 links-manifest-{date}.json；
// 後端負責用 GraphQL 抓每頁 title+content、給 AI 分類建議，並在使用者確認後把
// Markdown 寫進 supplements-{slug}/。檔名綁日期，避免舊會議的 manifest 在新鮮度視窗內被誤用。
function linksManifestPathFor(hostInsightsDir, meetingDate) {
  return path.join(assetsDirFor(hostInsightsDir), `links-manifest-${meetingDate}.json`)
}

function linkReviewCachePathFor(hostInsightsDir, meetingDate) {
  return path.join(assetsDirFor(hostInsightsDir), `link-review-${meetingDate}.json`)
}

function linkAssignmentsPathFor(hostInsightsDir, meetingDate) {
  return path.join(assetsDirFor(hostInsightsDir), `link-assignments-${meetingDate}.json`)
}

function supplementsDir(hostInsightsDir, slug) {
  return path.join(hostInsightsDir, `supplements-${slug}`)
}

function supplementFilePath(hostInsightsDir, slug, name) {
  const dir = supplementsDir(hostInsightsDir, slug)
  const safeFile = name.endsWith('.md') ? name : `${name}.md`
  const full = path.join(dir, safeFile)
  if (!full.startsWith(dir + path.sep)) return null
  return full
}

// ── 簡報(.pptx)產出 ─────────────────────────────────────────────────────────
// 由 presentation-generator skill 產出,存在 project-insights/pptx-{slug}/{timestamp}.pptx，
// 同資料夾另有 {timestamp}.spec.json(deck spec)與 {timestamp}/page-NN.png(預覽縮圖)。
function pptxDir(hostInsightsDir, slug) {
  return path.join(hostInsightsDir, `pptx-${slug}`)
}

function pptxFilePath(hostInsightsDir, slug, name) {
  const dir = pptxDir(hostInsightsDir, slug)
  const safeFile = name.endsWith('.pptx') ? name : `${name}.pptx`
  const full = path.join(dir, safeFile)
  if (!full.startsWith(dir + path.sep)) return null
  return full
}

// 補充資料檔名是頁面標題淨化後的結果（可含中文），只擋路徑穿越，不像會議記錄限定日期格式。
function validSupplementName(s) {
  return typeof s === 'string' && s.length > 0 && s.length < 300
    && !s.includes('..') && !s.includes('/') && !s.includes('\\')
}

// 把頁面 title 淨化成安全檔名（去掉路徑分隔與控制字元），並確保在目標資料夾中唯一。
function sanitizeTitleToFilename(title, dir) {
  let base = String(title || '').trim()
    .replace(/[\\/:*?"<>|]/g, '-')   // 檔名保留字元
    .replace(/[\x00-\x1f]/g, '')      // 控制字元
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')              // 別讓檔名以點開頭
    .slice(0, 120)
    .trim()
  if (!base) base = 'untitled'
  let candidate = `${base}.md`
  let n = 2
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${n}.md`
    n++
  }
  return candidate
}

// 把 manifest 裡的一筆連結（可能是裸 path、含 locale 前綴的 path、或完整 URL）正規化成
// { path, locale, url, sourceFile, location }。Wiki.js 的 URL 結構是 /{locale}/{path}，而
// GraphQL singleByPath 需要「去掉 locale 的 path」+ 另外傳 locale，所以要把首段 locale 拆出來。
function normalizeKmsLink(entry) {
  // 優先用已萃取好的裸 path；沒有才退回 url（url 的 pathname 會含 /{locale}/ 前綴）。
  const raw = String((entry && (entry.path || entry.url)) || '').trim()
  if (!raw) return null
  let pathname
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      if (u.hostname.toLowerCase() !== 'ess-kms.edgecenter.io') return null
      pathname = u.pathname
    } catch { return null }
  } else {
    pathname = raw
  }
  let segs = pathname.split('/').filter(Boolean)
  if (segs.length === 0) return null
  let locale = (entry && entry.locale) || ESS_KMS_LOCALE
  // Wiki.js URL 結構是 /{locale}/{path}。只在「首段確實是 locale」時才拆：
  // 有給 entry.locale → 首段等於它才拆（裸 path 通常已不含 locale，就不會誤砍真實段落）；
  // 沒給 locale → 首段長得像 locale（en、zh、zh-tw…）就當作 locale 拆掉。
  if (entry?.locale) {
    if (segs[0].toLowerCase() === String(entry.locale).toLowerCase()) segs = segs.slice(1)
  } else if (/^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0])) {
    locale = segs[0].toLowerCase()
    segs = segs.slice(1)
  }
  if (segs.length === 0) return null
  const pagePath = segs.join('/')
  return {
    path: pagePath,
    locale,
    url: (entry && entry.url) || `https://ess-kms.edgecenter.io/${locale}/${pagePath}`,
    sourceFile: (entry && entry.sourceFile) || '補充文件',
    location: (entry && entry.location) || '',
  }
}

// 下載 ess-kms 頁面內容裡引用的圖片（多為 /xdept/public/... 之類的站內相對路徑）到 _assets/，
// 並把 Markdown 裡的圖片路徑改成本地可服務的 ../_assets/<file>。回傳 { content, changed }。
async function localizeKmsImages(content, assetsDir) {
  if (!content) return { content, changed: false }
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g
  const srcs = new Set()
  let m
  while ((m = imgRe.exec(content)) !== null) {
    const src = m[2]
    // 只處理 ess-kms 站內圖片：以 / 開頭的相對路徑，或指向 ess-kms 的絕對 URL。
    if (src.startsWith('/') || /^https?:\/\/ess-kms\.edgecenter\.io\//i.test(src)) srcs.add(src)
  }
  if (srcs.size === 0) return { content, changed: false }

  fs.mkdirSync(assetsDir, { recursive: true })
  const replacements = new Map()
  for (const src of srcs) {
    const url = src.startsWith('/') ? `https://ess-kms.edgecenter.io${src}` : src
    try {
      // /xdept/public/... 這類圖是公開的，帶 Bearer token 反而會被擋（403）。所以先不帶 token 抓，
      // 失敗才退回帶 token（少數受保護的圖才需要）。
      let res = await fetch(url)
      if (!res.ok && ESS_KMS_GRAPHQL_TOKEN) {
        res = await fetch(url, { headers: { Authorization: `Bearer ${ESS_KMS_GRAPHQL_TOKEN}` } })
      }
      if (!res.ok) { dbgErr('[link-image] 下載失敗', res.status, url); continue }
      const buf = Buffer.from(await res.arrayBuffer())
      let base = decodeURIComponent(url.split('/').pop().split('?')[0] || 'image')
        .replace(/[\\/:*?"<>|]/g, '-').replace(/[\x00-\x1f]/g, '').slice(0, 100) || 'image'
      // 用來源路徑 hash 當前綴，確保不同頁面同名圖不衝突、同一張圖重覆執行時冪等。
      const filename = `${createHash('sha1').update(src).digest('hex').slice(0, 8)}-${base}`
      fs.writeFileSync(path.join(assetsDir, filename), buf)
      replacements.set(src, `../_assets/${filename}`)
    } catch (err) {
      dbgErr('[link-image] 下載例外', url, err?.message)
    }
  }
  if (replacements.size === 0) return { content, changed: false }

  const localized = content.replace(imgRe, (whole, alt, src, title) =>
    replacements.has(src) ? `![${alt}](${replacements.get(src)}${title || ''})` : whole)
  return { content: localized, changed: localized !== content }
}

// 用 GraphQL pages.singleByPath 抓回單一頁面的 title + content。失敗回 null。
async function fetchKmsPage(pagePath, locale = ESS_KMS_LOCALE) {
  if (!ESS_KMS_GRAPHQL_TOKEN) {
    dbgErr('[link-review] 未設定 ESS_KMS_GRAPHQL_TOKEN，跳過抓取', pagePath)
    return null
  }
  const query = `query ($path: String!, $locale: String!) {
    pages { singleByPath(path: $path, locale: $locale) { id title content createdAt updatedAt } }
  }`
  try {
    const res = await fetch(ESS_KMS_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ESS_KMS_GRAPHQL_TOKEN}`,
      },
      body: JSON.stringify({ query, variables: { path: pagePath, locale: locale || ESS_KMS_LOCALE } }),
    })
    if (!res.ok) {
      dbgErr('[link-review] GraphQL HTTP', res.status, pagePath)
      return null
    }
    const data = await res.json()
    const page = data?.data?.pages?.singleByPath
    if (!page) return null
    return {
      id: page.id ?? null,
      title: (page.title || '').trim() || pagePath,
      content: page.content || '',
      updatedAt: page.updatedAt || null,
    }
  } catch (err) {
    dbgErr('[link-review] GraphQL fetch failed', pagePath, err?.message)
    return null
  }
}

// 一次性請 LLM 依 title+content 對照專案清單給出 suggestedSlug。失敗回空建議（不阻斷流程）。
async function suggestLinkProject(provisionUserId, title, content, projects) {
  if (!Array.isArray(projects) || projects.length === 0) return { suggestedSlug: null, reason: '無可用專案清單' }
  const projectList = projects
    .map(p => `- ${p.name}（${p.slug}）${p.description ? `：${p.description}` : '（尚無描述）'}`)
    .join('\n')
  const prompt = [
    `以下是一篇從會議補充文件連結抓回的知識庫頁面。請判斷它最應該歸屬到哪一個既有專案。`,
    ``,
    `已知專案清單：`,
    projectList,
    ``,
    `頁面標題：${title}`,
    `頁面內容（節錄）：`,
    (content || '').slice(0, 4000),
    ``,
    `請對照專案的名稱與描述，找出語意最吻合的專案。若沒有任何專案合理對應，suggestedSlug 給 null。`,
    `只回覆 JSON，格式為：{"suggestedSlug": "{清單中的 slug 或 null}", "reason": "{一句話說明理由}"}`,
    `不要有其他文字、不要用 markdown 程式碼區塊包住。`,
  ].join('\n')
  try {
    const client = getClientForUser(provisionUserId)
    const sessionKey = makeScopedSessionKey('link-suggest')
    const lastMsg = await sendAndStreamOrThrow(client, sessionKey, prompt)
    const raw = (lastMsg.content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(raw)
    const slug = parsed?.suggestedSlug && projects.some(p => p.slug === parsed.suggestedSlug)
      ? parsed.suggestedSlug : null
    return { suggestedSlug: slug, reason: typeof parsed?.reason === 'string' ? parsed.reason : '' }
  } catch (err) {
    dbgErr('[link-review] suggest failed', err?.message)
    return { suggestedSlug: null, reason: '' }
  }
}

// 在記錄檔案的「## 相關圖片」區段裡新增或更新某張圖片的 bullet（用圖片檔名當識別key）。
function upsertImageBullet(content, file, bulletLine) {
  const marker = `_assets/${file})`
  const lines = content.split('\n')
  const existingIdx = lines.findIndex(l => l.includes(marker))
  if (existingIdx !== -1) {
    lines[existingIdx] = bulletLine
    return lines.join('\n')
  }
  const headingIdx = lines.findIndex(l => l.trim() === '## 相關圖片')
  if (headingIdx === -1) {
    return `${content.replace(/\s+$/, '')}\n\n## 相關圖片\n${bulletLine}\n`
  }
  let insertAt = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { insertAt = i; break }
  }
  lines.splice(insertAt, 0, bulletLine)
  return lines.join('\n')
}

function removeImageBullet(content, file) {
  const marker = `_assets/${file})`
  return content.split('\n').filter(l => !l.includes(marker)).join('\n')
}

function validSlug(s) {
  return typeof s === 'string' && s.length > 0 && !s.includes('..') && !s.includes('/') && !s.includes('\\')
}

function validTimestamp(s) {
  return typeof s === 'string' && /^\d{8}-\d{6}$/.test(s)
}

app.post('/api/swot/analyze', requireAuth, async (req, res) => {
  const { projectSlug, projectName } = req.body ?? {}

  if (!validSlug(projectSlug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')

  const projectContainerPath = `${CONTAINER_INSIGHTS_DIR}/${projectSlug}.md`
  const recordFolderContainerPath = `${CONTAINER_INSIGHTS_DIR}/record-${projectSlug}`

  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const swotFolderContainer = `${CONTAINER_INSIGHTS_DIR}/swot-${projectSlug}`
  const containerOutputPath = `${swotFolderContainer}/${timestamp}.md`
  const today = now.toISOString().slice(0, 10)
  const sessionKey = makeScopedSessionKey('swot')
  const displayName = (typeof projectName === 'string' && projectName.trim()) ? projectName.trim() : projectSlug

  const parts = [
    `請使用 swot-analyzer skill，針對「${displayName}」專案執行完整 SWOT 分析。`,
    '',
    `專案名稱：${displayName}`,
    `分析日期：${today}`,
    `專案洞察來源檔案：${projectContainerPath}`,
    `專案會議記錄資料夾（逐次會議的原始記錄全文，依日期分檔）：${recordFolderContainerPath}/（若存在，請列出並讀取其中所有 .md 檔案）`,
    '',
    '分析範疇：完整 SWOT（含初步競品掃描與產業趨勢）',
    '輸出目標：standalone',
    `輸出檔案路徑：${containerOutputPath}`,
    `（請先建立資料夾 ${swotFolderContainer}/ 若尚未存在）`,
    '',
    '請依照 skill 工作流程完整執行：',
    `1. 讀取 ${projectContainerPath}，並列出 ${recordFolderContainerPath}/ 下所有檔案逐一讀取，從兩者中提取已知事實作為內部事實基礎（標記來源日期；專案 Markdown 為整理後事實，記錄資料夾為逐次會議原文，遇到不一致以記錄資料夾的逐次原文為準並標註待確認）`,
    '2. 執行外部研究（搜尋相關市場資料、競品資訊、產業趨勢）',
    '3. 合成 SWOT 矩陣（嚴格區分會議事實層與外部 insights 層）',
    '4. 整理競品分析（每個競品描述附官方來源 URL）',
    '5. 整理產業趨勢（每項數字或判斷附來源日期與 URL）',
    `6. 輸出完整報告至：${containerOutputPath}`,
    '',
    '所有外部資料必須附來源 URL。',
    '最後檢查所有的 Markdown 檔案寫入時，\\n 要取代成斷行。',
  ]

  res.json({ success: true, sessionKey, prompt: parts.join('\n'), filename: timestamp, timestamp: today })
})

app.get('/api/swot/list', requireAuth, async (req, res) => {
  const { slug } = req.query

  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const dir = swotDir(hostInsightsDir, slug)

  if (!fs.existsSync(dir)) return res.json({ reports: [] })

  try {
    const reports = fs.readdirSync(dir)
      .filter(f => /^\d{8}-\d{6}\.md$/.test(f))
      .map(f => {
        const name = f.replace(/\.md$/, '')
        const d = name.slice(0, 8)
        const t = name.slice(9)
        const displayDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`
        let mtime = 0
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs } catch {}
        return { name, displayDate, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)

    res.json({ reports })
  } catch {
    res.status(500).json({ error: '讀取 SWOT 報告清單失敗' })
  }
})

app.get('/api/swot/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = swotFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    const content = fs.readFileSync(hostPath, 'utf8')
    res.json({ content, name })
  } catch {
    res.status(500).json({ error: '讀取檔案失敗' })
  }
})

app.patch('/api/swot/file', requireAuth, async (req, res) => {
  const { slug, name, content } = req.body ?? {}

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })
  if (typeof content !== 'string') return res.status(400).json({ error: '缺少 content' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const hostPath = swotFilePath(hostInsightsDir, slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true })
    fs.writeFileSync(hostPath, content, 'utf8')
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '儲存檔案失敗' })
  }
})

app.delete('/api/swot/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = swotFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    fs.unlinkSync(hostPath)
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '刪除檔案失敗' })
  }
})

app.get('/api/swot/result', requireAuth, async (req, res) => {
  const { slug, filename } = req.query

  if (!validSlug(slug) || !validTimestamp(filename)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = swotFilePath(path.join(paths.workspace, 'project-insights'), slug, filename)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  res.json({ ready: fs.existsSync(hostPath) })
})

// ── Presentation Generator（.pptx 簡報產出）──────────────────────────────────

const CONTAINER_SKILL_PPTX = `${CONTAINER_WORKSPACE}/skills/presentation-generator`

const PPTX_ACCENTS = ['green', 'blue', 'gold', 'pink', 'sand', 'green2']

function randomAccentOrder() {
  const a = [...PPTX_ACCENTS]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, 5)
}

function newTimestamp() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// ── Phase 1：探索（做市場/技術研究 + 依專案動態產出要反問使用者的問題）─────────
app.post('/api/presentation/plan/start', requireAuth, async (req, res) => {
  const { projectSlug, projectName, note } = req.body ?? {}
  if (!validSlug(projectSlug)) return res.status(400).json({ error: '無效的專案識別碼' })
  const userNote = (typeof note === 'string' && note.trim()) ? note.trim() : ''

  const planId = newTimestamp()
  const today = new Date().toISOString().slice(0, 10)
  const displayName = (typeof projectName === 'string' && projectName.trim()) ? projectName.trim() : projectSlug
  const pptxFolderContainer = `${CONTAINER_INSIGHTS_DIR}/pptx-${projectSlug}`
  const discoveryPath = `${pptxFolderContainer}/${planId}.discovery.json`
  const sessionKey = makeScopedSessionKey('presentation')

  const parts = [
    `請使用 presentation-generator skill 的 **discovery 模式**，為「${displayName}」專案的簡報做前置研究與提問（這個階段不要生成 pptx）。`,
    '',
    `專案 slug：${projectSlug}`,
    `專案名稱：${displayName}`,
    `日期：${today}`,
    ...(userNote ? ['', `使用者的額外方向說明（請在研究與設計問題時納入考量）：「${userNote}」`] : []),
    '',
    '資料來源（請完整讀取）：',
    `- 專案知識庫主檔：${CONTAINER_INSIGHTS_DIR}/${projectSlug}.md`,
    `- 逐次會議記錄資料夾：${CONTAINER_INSIGHTS_DIR}/record-${projectSlug}/（若存在，讀取其中所有 .md）`,
    `- 補充資料資料夾：${CONTAINER_INSIGHTS_DIR}/supplements-${projectSlug}/（若存在，讀取其中所有 .md）`,
    `- 既有 SWOT 分析資料夾：${CONTAINER_INSIGHTS_DIR}/swot-${projectSlug}/（若存在，用 Glob 列出其中的 {timestamp}.md，只讀檔名時間戳記最新的一份）`,
    `- 既有市場行銷分析資料夾：${CONTAINER_INSIGHTS_DIR}/market-${projectSlug}/（若存在，同樣只讀最新一份）`,
    `- 既有技術分享分析資料夾：${CONTAINER_INSIGHTS_DIR}/tech-${projectSlug}/（若存在，同樣只讀最新一份）`,
    `- 圖片資產目錄：${CONTAINER_INSIGHTS_DIR}/_assets/`,
    '',
    '請依 SKILL.md 的 Mode A 執行：',
    '1. 完整讀取專案內容，掌握現狀、數據、成果、目標客戶線索；同時讀取上面既有的 SWOT/市場/技術分析報告最新版（若存在），重複利用其中已驗證的洞察與來源標記，不要重做一次相同分析',
    '2. 用 Glob 列出 _assets/ 實際存在的圖片並建立圖片語意清單（file/desc/topic）',
    '3. 先確認既有報告是否已涵蓋市場規模/競品/趨勢/技術背景，缺的部分再用 web 搜尋做**深入**研究補齊，逐條記錄來源 URL',
    '4. 依這個專案的實際狀況，動態設計 3–5 個要反問使用者的關鍵問題（single/multi/open，選項要貼合本專案）',
    `5. 依 references/discovery-schema.md 寫出完整 discovery.json 到：${discoveryPath}`,
    `   （planId 請填 "${planId}"；請先建立資料夾 ${pptxFolderContainer}/ 若尚未存在）`,
    '',
    '完成後回報：研究到的主要洞察（含來源）、設計了哪些問題。這個階段**不要**產生 pptx。',
  ]

  res.json({ success: true, sessionKey, prompt: parts.join('\n'), planId })
})

app.get('/api/presentation/plan/result', requireAuth, async (req, res) => {
  const { slug, planId } = req.query
  if (!validSlug(slug) || !validTimestamp(planId)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const dir = pptxDir(hostInsightsDir, slug)
  const discoveryHostPath = path.join(dir, `${planId}.discovery.json`)
  if (!discoveryHostPath.startsWith(dir + path.sep) || !fs.existsSync(discoveryHostPath)) {
    return res.json({ ready: false })
  }
  const discovery = readJsonSafe(discoveryHostPath)
  if (!discovery) return res.json({ ready: false })
  res.json({ ready: true, discovery })
})

const PPTX_STYLES = ['professional', 'vivid', 'minimal', 'warm']

function validRevision(v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 20
}

// ── Phase 2：故事大綱（先寫目的、設計逐頁大綱、自我檢視，交給使用者確認或依回饋重做）──
// outline 檔用 revision 編號（{planId}.outline.v{N}.json），每次呼叫（含重新設計）都是
// 新檔案，避免「使用者要求重寫、但輪詢讀到舊檔」的競態，也保留每一版的歷史方便除錯。
app.post('/api/presentation/outline/start', requireAuth, async (req, res) => {
  const { projectSlug, projectName, planId, answers, style, feedback, previousRevision } = req.body ?? {}
  if (!validSlug(projectSlug)) return res.status(400).json({ error: '無效的專案識別碼' })
  if (!validTimestamp(planId)) return res.status(400).json({ error: '缺少有效的 planId（請先完成規劃階段）' })
  const deckStyle = PPTX_STYLES.includes(style) ? style : 'professional'
  const revision = validRevision(previousRevision) ? Number(previousRevision) + 1 : 1
  const isRefine = revision > 1

  const today = new Date().toISOString().slice(0, 10)
  const displayName = (typeof projectName === 'string' && projectName.trim()) ? projectName.trim() : projectSlug
  const pptxFolderContainer = `${CONTAINER_INSIGHTS_DIR}/pptx-${projectSlug}`
  const discoveryPath = `${pptxFolderContainer}/${planId}.discovery.json`
  const outlinePath = `${pptxFolderContainer}/${planId}.outline.v${revision}.json`
  const previousOutlinePath = `${pptxFolderContainer}/${planId}.outline.v${revision - 1}.json`
  const sessionKey = makeScopedSessionKey('presentation')

  let answersBlock = '（使用者未提供額外回答，請依 discovery.json 的問題以合理預設進行）'
  try {
    if (answers && typeof answers === 'object') answersBlock = JSON.stringify(answers, null, 2)
  } catch {}
  const feedbackText = (typeof feedback === 'string' && feedback.trim()) ? feedback.trim() : ''

  const parts = [
    `請使用 presentation-generator skill 的 **outline 模式**，為「${displayName}」專案${isRefine ? '重新設計' : '設計'}故事大綱（這個階段不要生成 pptx，只寫 outline.json）。`,
    '',
    `專案 slug：${projectSlug}`,
    `專案名稱：${displayName}`,
    `日期：${today}`,
    `視覺風格（供你安排語氣參考）：${deckStyle}`,
    '',
    `研究檔（discovery.json）：${discoveryPath}（請先讀取，取得研究摘要、圖片語意清單）`,
    '',
    '使用者對規劃問題的回答（key 為問題 id，對照 discovery.json 的 questions）：',
    '```json',
    answersBlock,
    '```',
    '',
    ...(isRefine ? [
      `**這是重新設計（第 ${revision} 版）**：請先讀取上一版大綱：${previousOutlinePath}`,
      `使用者對上一版的回饋：「${feedbackText || '（使用者未填寫具體文字，僅按下重新設計）'}」`,
      '請針對回饋具體修正故事線與每頁目的，不是換個說法敷衍過去；若回饋指出「太像流水帳」，',
      '就要實際刪減/合併目的薄弱的頁面，換成更有畫面感的頁型。',
      '',
    ] : []),
    '請依 SKILL.md 的 Mode B 執行：',
    '1. 消化 discovery.json 與使用者回答' + (isRefine ? '、上一版大綱與使用者回饋' : '') + '，定出受眾/核心訊息/強調重點/頁數',
    '2. **先寫整份簡報的 deck_purpose（完整目的）**，再逐頁「先寫 purpose、再寫 one_liner」',
    '3. 封面固定用 type=cover，目的固定（建立位階與野心），不要另外設計封面呈現方式',
    '4. 自我檢視：是否為一篇完整、連貫、有記憶點的故事？有沒有目的薄弱的流水帳頁面？誠實填 self_check，不通過就修正到通過',
    `5. 依 references/outline-schema.md 寫出完整 outline.json 到：${outlinePath}`,
    `   （planId 填 "${planId}"，revision 填 ${revision}${isRefine ? `，based_on_feedback 填使用者的回饋文字` : ''}；請先建立資料夾 ${pptxFolderContainer}/ 若尚未存在）`,
    '',
    '完成後回報：deck_purpose、核心訊息、逐頁大綱摘要（一頁一句話＋目的一句話）、self_check 結果。',
    '**這個階段絕對不要**寫 deck spec、呼叫 deck_builder 或產生 pptx——大綱要先給使用者確認。',
  ]

  res.json({ success: true, sessionKey, prompt: parts.join('\n'), planId, revision })
})

app.get('/api/presentation/outline/result', requireAuth, async (req, res) => {
  const { slug, planId, revision } = req.query
  if (!validSlug(slug) || !validTimestamp(planId) || !validRevision(revision)) {
    return res.status(400).json({ error: '無效的參數' })
  }
  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const dir = pptxDir(hostInsightsDir, slug)
  const outlineHostPath = path.join(dir, `${planId}.outline.v${revision}.json`)
  if (!outlineHostPath.startsWith(dir + path.sep) || !fs.existsSync(outlineHostPath)) {
    return res.json({ ready: false })
  }
  const outline = readJsonSafe(outlineHostPath)
  if (!outline) return res.json({ ready: false })
  res.json({ ready: true, outline })
})

// ── Phase 3：build（只在使用者已確認某一版大綱後才觸發，依大綱生成 pptx）──────────
app.post('/api/presentation/generate', requireAuth, async (req, res) => {
  const { projectSlug, projectName, planId, revision, style } = req.body ?? {}
  if (!validSlug(projectSlug)) return res.status(400).json({ error: '無效的專案識別碼' })
  if (!validTimestamp(planId)) return res.status(400).json({ error: '缺少有效的 planId（請先完成規劃階段）' })
  if (!validRevision(revision)) return res.status(400).json({ error: '缺少已確認的故事大綱版本（請先完成大綱確認）' })
  const deckStyle = PPTX_STYLES.includes(style) ? style : 'professional'

  const today = new Date().toISOString().slice(0, 10)
  const displayName = (typeof projectName === 'string' && projectName.trim()) ? projectName.trim() : projectSlug
  const pptxFolderContainer = `${CONTAINER_INSIGHTS_DIR}/pptx-${projectSlug}`
  // 沿用 planId 當最終簡報的 timestamp，讓 discovery / outline / spec / pptx / 預覽同名成組
  const outputPptx = `${pptxFolderContainer}/${planId}.pptx`
  const specPath = `${pptxFolderContainer}/${planId}.spec.json`
  const discoveryPath = `${pptxFolderContainer}/${planId}.discovery.json`
  const outlinePath = `${pptxFolderContainer}/${planId}.outline.v${revision}.json`
  const previewDir = `${pptxFolderContainer}/${planId}`
  const sessionKey = makeScopedSessionKey('presentation')
  const layoutSeed = Math.floor(Math.random() * 10000)

  const parts = [
    `請使用 presentation-generator skill 的 **build 模式**，依「已核准的故事大綱」為「${displayName}」專案產出 PowerPoint 簡報（.pptx）。`,
    '',
    `專案 slug：${projectSlug}`,
    `專案名稱：${displayName}`,
    `日期：${today}`,
    '',
    `研究檔（discovery.json）：${discoveryPath}`,
    `**已核准的故事大綱（outline.json，第 ${revision} 版）：${outlinePath}**`,
    '請先讀取這份大綱，逐頁依其 purpose 與 one_liner 撰寫內容，不要偏離已核准的目的重新發揮。',
    '',
    '本次版面變化設定（很重要:每次都要做出不同的 layout,避免每份簡報長得一樣）：',
    `- **視覺風格（使用者指定）：meta.style 請設為 "${deckStyle}"**（professional / vivid / minimal / warm）。`,
    `- 請在 meta 設 layoutSeed:${layoutSeed}（讓版面變體的預設每次不同）。`,
    '- **主動變換每頁的版面變體**（見 deck-spec-schema.md「版面變體」）:',
    '    · bullets 可用 variant: list（條列）/ cards（卡片）,並用 imageSide: left/right 換圖片位置',
    '    · stats 可用 variant: row（單排）/ grid（2×2）;two_column 可用 variant: panels / divider',
    '    · 適時改用 process / big_number / quote / hero_image / image_full 等不同頁型呈現',
    '- 封面固定用 type=cover，只給 title/domain/team/date，不要加 variant 或任何賽事字樣。',
    '- 多數內容頁**不要**設 accent（留空會自動吃 style 主色,整份才一致）。',
    '',
    '產出設定：',
    `- 圖片解析根目錄（--assets-root）：${CONTAINER_INSIGHTS_DIR}`,
    `- 模板（--template）：${CONTAINER_SKILL_PPTX}/references/template.pptx`,
    `- deck spec 輸出：${specPath}`,
    `- pptx 輸出（--out）：${outputPptx}`,
    `- 預覽縮圖輸出資料夾：${previewDir}/`,
    '',
    '請依 SKILL.md 的 Mode C 執行：',
    '1. 讀取已核准的 outline.json，逐頁取用 purpose 與 one_liner',
    '2. 語意配對圖片:只在圖片真正支撐該頁訊息時才放，圖說寫清楚它證明什麼;配不上就不放',
    '3. 決定本次版面組合(layoutSeed + 混搭頁型與變體),避免與過往雷同',
    `4. 依 references/deck-spec-schema.md 寫出完整 spec 到 ${specPath}（外部數字句末附來源,倒數第二頁放 sources）`,
    '5. 執行 scripts/deck_builder.py 產 pptx;missing_images 非空就修正重跑',
    '6. 執行 scripts/render_preview.py 產預覽',
    '7. 回報:pptx 頁數、逐頁如何對應大綱目的、用了哪些 _assets 圖(用在哪頁與原因)、引用了哪些來源、這次的版面/配色變化',
    '',
    '務必:忠於已核准的大綱、圖片語意到位不硬塞、外部引用附連結、只用真實存在的 _assets 圖。',
  ]

  res.json({ success: true, sessionKey, prompt: parts.join('\n'), filename: planId, timestamp: today })
})

app.get('/api/presentation/result', requireAuth, async (req, res) => {
  const { slug, filename } = req.query
  if (!validSlug(slug) || !validTimestamp(filename)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const hostPath = pptxFilePath(hostInsightsDir, slug, filename)
  if (!hostPath) return res.status(403).json({ error: '無權限' })

  const ready = fs.existsSync(hostPath)
  let pages = 0
  if (ready) {
    const previewDir = path.join(pptxDir(hostInsightsDir, slug), filename)
    try {
      pages = fs.readdirSync(previewDir).filter(f => /^page-\d+\.png$/.test(f)).length
    } catch {}
  }
  res.json({ ready, pages })
})

app.get('/api/presentation/list', requireAuth, async (req, res) => {
  const { slug } = req.query
  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const dir = pptxDir(hostInsightsDir, slug)
  if (!fs.existsSync(dir)) return res.json({ decks: [] })

  try {
    const decks = fs.readdirSync(dir)
      .filter(f => /^\d{8}-\d{6}\.pptx$/.test(f))
      .map(f => {
        const name = f.replace(/\.pptx$/, '')
        const d = name.slice(0, 8)
        const t = name.slice(9)
        const displayDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`
        let mtime = 0
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs } catch {}
        let pages = 0
        try { pages = fs.readdirSync(path.join(dir, name)).filter(x => /^page-\d+\.png$/.test(x)).length } catch {}
        return { name, displayDate, mtime, pages }
      })
      .sort((a, b) => b.mtime - a.mtime)
    res.json({ decks })
  } catch {
    res.status(500).json({ error: '讀取簡報清單失敗' })
  }
})

app.get('/api/presentation/download', requireAuth, async (req, res) => {
  const { slug, name } = req.query
  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const hostPath = pptxFilePath(hostInsightsDir, slug, name)
  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    const data = fs.readFileSync(hostPath)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-${name}.pptx"`)
    res.send(data)
  } catch (err) {
    console.error('[presentation] download error:', err.message)
    res.status(500).json({ error: '下載失敗' })
  }
})

// 預覽 PNG:img 標籤無法帶 Authorization header，改用 query token 驗證(同 /asset 端點作法)。
app.get('/api/presentation/preview', async (req, res) => {
  const { slug, name, page, token } = req.query
  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })
  const pageNum = String(page || '').padStart(2, '0')
  if (!/^\d{2}$/.test(pageNum)) return res.status(400).json({ error: '無效的頁碼' })

  let user
  try {
    const auth = req.headers.authorization ?? ''
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null
    user = verifyToken(bearer || token)
  } catch {
    return res.status(401).json({ error: '未授權' })
  }

  const provisionUserId = await getProvisionUserId(user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const previewDir = path.join(pptxDir(hostInsightsDir, slug), name)
  const hostPath = path.join(previewDir, `page-${pageNum}.png`)
  if (!hostPath.startsWith(previewDir + path.sep) || !fs.existsSync(hostPath)) {
    return res.status(404).json({ error: '預覽不存在' })
  }

  try {
    const data = fs.readFileSync(hostPath)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.send(data)
  } catch {
    res.status(500).json({ error: '讀取預覽失敗' })
  }
})

app.delete('/api/presentation/delete', requireAuth, async (req, res) => {
  const { slug, name } = req.body ?? {}
  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const dir = pptxDir(hostInsightsDir, slug)

  // 一份簡報 = {name}.pptx + {name}.spec.json + {name}.discovery.json + 每一版
  // {name}.outline.v{N}.json + {name}/(預覽縮圖資料夾)。逐一刪除,並確保每個目標路徑
  // 都仍在 pptx-{slug} 資料夾內(擋路徑穿越)。
  const targets = [
    path.join(dir, `${name}.pptx`),
    path.join(dir, `${name}.spec.json`),
    path.join(dir, `${name}.discovery.json`),
    path.join(dir, name),
  ]
  try {
    for (let rev = 1; rev <= 20; rev++) {
      targets.push(path.join(dir, `${name}.outline.v${rev}.json`))
    }
    for (const t of targets) {
      if (!t.startsWith(dir + path.sep)) continue
      if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[presentation] delete error:', err.message)
    res.status(500).json({ error: '刪除失敗' })
  }
})

// ── Market Analyzer ───────────────────────────────────────────────────────────

app.post('/api/market/analyze', requireAuth, async (req, res) => {
  const { projectSlug, projectName } = req.body ?? {}

  if (!validSlug(projectSlug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)

  const projectContainerPath = `${CONTAINER_INSIGHTS_DIR}/${projectSlug}.md`
  const recordFolderContainerPath = `${CONTAINER_INSIGHTS_DIR}/record-${projectSlug}`

  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const marketFolderContainer = `${CONTAINER_INSIGHTS_DIR}/market-${projectSlug}`
  const containerOutputPath = `${marketFolderContainer}/${timestamp}.md`
  const today = now.toISOString().slice(0, 10)
  const sessionKey = makeScopedSessionKey('market')
  const displayName = (typeof projectName === 'string' && projectName.trim()) ? projectName.trim() : projectSlug

  const parts = [
    `請使用 market-analyzer skill，針對「${displayName}」專案產出一份可直接用於行銷推廣的 Markdown 文件。`,
    '',
    `專案名稱：${displayName}`,
    `分析日期：${today}`,
    `專案洞察來源檔案：${projectContainerPath}`,
    `專案會議記錄資料夾（逐次會議的原始記錄全文，依日期分檔）：${recordFolderContainerPath}/（若存在，請列出並讀取其中所有 .md 檔案）`,
    '',
    '行銷重點：痛點解決、ROI 佐證、競品比較、產業趨勢',
    '目標讀者：非技術決策者（IT 採購主管、中小企業主、部門主管）',
    '輸出目標：standalone',
    `輸出檔案路徑：${containerOutputPath}`,
    `（請先建立資料夾 ${marketFolderContainer}/ 若尚未存在）`,
    '',
    '請依照 skill 工作流程完整執行：',
    `1. 讀取 ${projectContainerPath}，並列出 ${recordFolderContainerPath}/ 下所有檔案逐一讀取，從兩者中提取產品功能、客戶案例、效益數字作為事實基礎（標記來源日期；專案 Markdown 為整理後事實，記錄資料夾為逐次會議原文，可從中挖出整理稿未收錄的具體案例與數字細節）`,
    '2. 執行外部市場研究（搜尋市場規模、客戶痛點現況、競品行銷說法、產業趨勢）',
    '3. 選定痛點導向敘事框架，以平易近人語言撰寫（把技術詞彙翻成業務語言）',
    '4. 整理市場佐證數字（每項附來源 URL 與日期）',
    `5. 輸出完整行銷文件至：${containerOutputPath}`,
    '',
    '所有外部市場資料必須附來源 URL。語言要親切易懂，初學者也能理解。',
    '最後檢查所有的 Markdown 檔案寫入時，\\n 要取代成斷行。',
  ]

  res.json({ success: true, sessionKey, prompt: parts.join('\n'), filename: timestamp, timestamp: today })
})

app.get('/api/market/list', requireAuth, async (req, res) => {
  const { slug } = req.query

  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const dir = marketDir(path.join(paths.workspace, 'project-insights'), slug)

  if (!fs.existsSync(dir)) return res.json({ reports: [] })

  try {
    const reports = fs.readdirSync(dir)
      .filter(f => /^\d{8}-\d{6}\.md$/.test(f))
      .map(f => {
        const name = f.replace(/\.md$/, '')
        const d = name.slice(0, 8)
        const t = name.slice(9)
        const displayDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`
        let mtime = 0
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs } catch {}
        return { name, displayDate, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)

    res.json({ reports })
  } catch {
    res.status(500).json({ error: '讀取行銷分析報告清單失敗' })
  }
})

app.get('/api/market/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = marketFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    const content = fs.readFileSync(hostPath, 'utf8')
    res.json({ content, name })
  } catch {
    res.status(500).json({ error: '讀取檔案失敗' })
  }
})

app.patch('/api/market/file', requireAuth, async (req, res) => {
  const { slug, name, content } = req.body ?? {}

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })
  if (typeof content !== 'string') return res.status(400).json({ error: '缺少 content' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = marketFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true })
    fs.writeFileSync(hostPath, content, 'utf8')
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '儲存檔案失敗' })
  }
})

app.delete('/api/market/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = marketFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    fs.unlinkSync(hostPath)
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '刪除檔案失敗' })
  }
})

app.get('/api/market/result', requireAuth, async (req, res) => {
  const { slug, filename } = req.query

  if (!validSlug(slug) || !validTimestamp(filename)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = marketFilePath(path.join(paths.workspace, 'project-insights'), slug, filename)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  res.json({ ready: fs.existsSync(hostPath) })
})

// ── Tech Analyzer ─────────────────────────────────────────────────────────────

app.post('/api/tech/analyze', requireAuth, async (req, res) => {
  const { projectSlug, projectName } = req.body ?? {}

  if (!validSlug(projectSlug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)

  const projectContainerPath = `${CONTAINER_INSIGHTS_DIR}/${projectSlug}.md`
  const recordFolderContainerPath = `${CONTAINER_INSIGHTS_DIR}/record-${projectSlug}`

  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const techFolderContainer = `${CONTAINER_INSIGHTS_DIR}/tech-${projectSlug}`
  const containerOutputPath = `${techFolderContainer}/${timestamp}.md`
  const today = now.toISOString().slice(0, 10)
  const sessionKey = makeScopedSessionKey('tech')
  const displayName = (typeof projectName === 'string' && projectName.trim()) ? projectName.trim() : projectSlug

  const parts = [
    `請使用 tech-analyzer skill，針對「${displayName}」專案，從 CTO 技術長角度產出一篇可對外發表的技術部落格文章。`,
    '',
    `專案名稱：${displayName}`,
    `分析日期：${today}`,
    `專案洞察來源檔案：${projectContainerPath}`,
    `專案會議記錄資料夾（逐次會議的原始記錄全文，依日期分檔）：${recordFolderContainerPath}/（若存在，請列出並讀取其中所有 .md 檔案）`,
    '',
    '文章深度：deep-dive',
    '目標讀者：有技術背景的工程師與架構師',
    '輸出目標：standalone',
    `輸出檔案路徑：${containerOutputPath}`,
    `（請先建立資料夾 ${techFolderContainer}/ 若尚未存在）`,
    '',
    '請依照 skill 工作流程完整執行：',
    `1. 讀取 ${projectContainerPath}，並列出 ${recordFolderContainerPath}/ 下所有檔案逐一讀取，從兩者中提取技術架構、設計決策、效能指標與技術突破點（標記來源日期；專案 Markdown 為整理後事實，記錄資料夾為逐次會議原文，可從中挖出整理稿未收錄的實作細節與數字）`,
    '2. 識別 1-3 個最有看點的核心技術突破作為文章主軸',
    '3. 執行外部技術研究（搜尋業界做法比較、相關技術規範、知名公司類似實踐）',
    '4. 以「問題解決型」結構撰寫：背景 → 挑戰 → 解法 → 實作 → 結果 → 延伸',
    '5. 每個技術主張附具體數字或外部參考來源',
    `6. 輸出完整技術文章至：${containerOutputPath}`,
    '',
    '所有外部技術資料必須附來源 URL 與日期。技術術語第一次出現時附中文說明。',
    '最後檢查所有的 Markdown 檔案寫入時，\\n 要取代成斷行。',
  ]

  res.json({ success: true, sessionKey, prompt: parts.join('\n'), filename: timestamp, timestamp: today })
})

app.get('/api/tech/list', requireAuth, async (req, res) => {
  const { slug } = req.query

  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const dir = techDir(path.join(paths.workspace, 'project-insights'), slug)

  if (!fs.existsSync(dir)) return res.json({ reports: [] })

  try {
    const reports = fs.readdirSync(dir)
      .filter(f => /^\d{8}-\d{6}\.md$/.test(f))
      .map(f => {
        const name = f.replace(/\.md$/, '')
        const d = name.slice(0, 8)
        const t = name.slice(9)
        const displayDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`
        let mtime = 0
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs } catch {}
        return { name, displayDate, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)

    res.json({ reports })
  } catch {
    res.status(500).json({ error: '讀取技術分享文章清單失敗' })
  }
})

app.get('/api/tech/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = techFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    const content = fs.readFileSync(hostPath, 'utf8')
    res.json({ content, name })
  } catch {
    res.status(500).json({ error: '讀取檔案失敗' })
  }
})

app.patch('/api/tech/file', requireAuth, async (req, res) => {
  const { slug, name, content } = req.body ?? {}

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })
  if (typeof content !== 'string') return res.status(400).json({ error: '缺少 content' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = techFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true })
    fs.writeFileSync(hostPath, content, 'utf8')
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '儲存檔案失敗' })
  }
})

app.delete('/api/tech/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validTimestamp(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = techFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    fs.unlinkSync(hostPath)
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '刪除檔案失敗' })
  }
})

app.get('/api/tech/result', requireAuth, async (req, res) => {
  const { slug, filename } = req.query

  if (!validSlug(slug) || !validTimestamp(filename)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = techFilePath(path.join(paths.workspace, 'project-insights'), slug, filename)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  res.json({ ready: fs.existsSync(hostPath) })
})

// ── Meeting Record Distribution ───────────────────────────────────────────────

app.post('/api/meeting-record/prepare-distribution', requireAuth, async (req, res) => {
  const { meetingDate, notesContainerPath, projects, docFtpPaths } = req.body ?? {}

  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的會議日期格式' })
  if (!notesContainerPath || typeof notesContainerPath !== 'string') return res.status(400).json({ error: '缺少會議記錄路徑' })
  if (!Array.isArray(projects) || projects.length === 0) return res.status(400).json({ error: '未指定專案' })

  const validProjects = projects.filter(p => p && validSlug(p.slug))
  if (validProjects.length === 0) return res.status(400).json({ error: '無有效的專案' })

  const containerPrefix = `${CONTAINER_WORKSPACE}/`
  if (!notesContainerPath.startsWith(containerPrefix)) {
    return res.status(400).json({ error: '無效的會議記錄路徑' })
  }

  const provisionUserId = await getProvisionUserId(req.user.userId)

  const sessionKey = makeScopedSessionKey('record-dist')

  const outputEntries = validProjects.map(p => {
    const folderPath = `${CONTAINER_INSIGHTS_DIR}/record-${p.slug}`
    const filePath = `${folderPath}/${meetingDate}.md`
    return { slug: p.slug, name: p.name || p.slug, description: p.description || '', folderPath, filePath }
  })

  const parts = [
    `你的任務是：讀取指定的會議記錄檔案，將其中的內容依照專案歸屬，精確分割並分別寫入各專案的記錄檔案。`,
    ``,
    `## 分割原則（核心）`,
    ``,
    `**判斷一段內容屬於哪個專案，必須同時滿足以下條件之一：**`,
    `1. 該段落的標題、開頭句、或主語直接提及專案名稱`,
    `2. 整個段落的討論脈絡是針對該專案的功能、進度、問題或決議`,
    `3. 行動事項的執行對象或影響範圍明確屬於該專案`,
    `4. 段落討論的技術領域、產品名詞或關鍵字，與下方「專案清單」裡某個專案的 description 高度吻合（即使沒有直接點名專案，但討論的就是該專案的核心範疇）`,
    ``,
    `**嚴格禁止的行為：**`,
    `- 不得將「通用討論」或「與多專案相關的背景說明」寫入某一個專案的記錄，除非該專案被明確點名`,
    `- 不得因為上下文是某個專案，就把後續的泛用性內容也歸入該專案`,
    `- 不得在某專案記錄中寫入屬於其他專案的決議或行動事項`,
    `- 不得補充、推測、改寫或摘要原始內容，必須原文照錄`,
    ``,
    `## 模糊內容的處理方式`,
    ``,
    `若某段內容無法明確判斷專案歸屬（例如：泛談組織流程、技術架構而未點名特定專案），則：`,
    `- **不要**將該段寫入任何專案`,
    `- 若確實同時涉及多個已命名專案，才可重複寫入各自的檔案，並且必須完整保留原文`,
    ``,
    `## 操作資訊`,
    ``,
    `會議記錄來源檔案：${notesContainerPath}`,
    `會議日期：${meetingDate}`,
    ``,
    `請針對以下 ${outputEntries.length} 個專案，各自建立會議記錄（若某專案在本次會議中完全未被提及，請略過，不建立空檔案）：`,
    ...outputEntries.map(e =>
      `- 專案「${e.name}」${e.description ? `（範疇：${e.description}）` : '（尚無描述）'} → 輸出至 ${e.filePath}（先建立資料夾 ${e.folderPath}/ 若尚未存在）`,
    ),
    ``,
    `## 每個輸出檔案的格式`,
    ``,
    `- 第一行標題：# 會議記錄 — ${meetingDate}`,
    `- 第二行：> 專案：{專案名稱}`,
    `- 其後為從原始會議記錄中提取的相關內容，保持原始段落結構與 Markdown 格式，僅更換頂層標題`,
    ``,
    `## 執行步驟`,
    ``,
    `1. 先完整讀取會議記錄來源檔案`,
    `2. 逐段分析每個段落屬於哪個（些）專案，嚴格依照上述分割原則判斷`,
    `3. 依序為各有相關內容的專案建立並寫入記錄檔案`,
    `4. 寫入 Markdown 檔案時，\\n 必須取代成實際斷行字元`,
    `5. 完成後確認各檔案均已成功寫入`,
  ]

  const imageSourcePaths = ftpDocPathsToContainerPaths(provisionUserId, docFtpPaths)
    .filter(p => IMAGE_SOURCE_EXTS.has(path.extname(p).toLowerCase()))

  if (imageSourcePaths.length > 0) {
    const assetsDir = `${CONTAINER_INSIGHTS_DIR}/_assets`
    const suggestionsPath = `${assetsDir}/suggestions-${meetingDate}.json`
    const imageManifestPath = `${assetsDir}/manifest-${meetingDate}.json`
    parts.push(
      ``,
      `## 補充文件圖片萃取與「建議」分類（不要自己決定插入哪個專案，也不要修改任何 record-*.md）`,
      ``,
      `本次會議有以下補充文件，裡面可能含有與專案內容相關的圖片（圖表、架構圖、產品畫面等）：`,
      ...imageSourcePaths.map(p => `- ${p}`),
      ``,
      `已知專案清單（共 ${outputEntries.length} 個，與步驟一的專案清單相同）：`,
      ...outputEntries.map(e => `- ${e.name}（${e.slug}）${e.description ? `：${e.description}` : '（尚無描述）'}`),
      ``,
      `圖片最終要分到哪個專案，由使用者在前端介面手動確認，你只需要負責萃取與給建議，不要自己寫入任何專案的記錄檔案：`,
      `1. 執行：python3 ${IMAGE_EXTRACT_SCRIPT} ${imageSourcePaths.map(p => `"${p}"`).join(' ')} --output-dir ${assetsDir} --manifest ${imageManifestPath}`,
      `2. 讀取產生的 ${imageManifestPath}，並用 Read 工具逐一實際開啟、親眼檢視每一張圖片本身的畫面內容，把圖片裡的關鍵文字、術語、表格欄位都看清楚（不要只看大概構圖，更不能只憑 manifest 裡的文字欄位猜測內容）`,
      `3. 對 manifest 裡「每一張」圖片，先判斷這張圖片本身的類型（例如：數據折線圖／長條圖、UI 截圖、流程圖、架構圖、表格…），再依照圖片裡實際看到的內容給出建議（找不到合理對應時 suggestedSlug 給 null，不要硬猜）：`,
      `   - 對照圖片中出現的具體名詞（工具名、程式庫名、API、模組名、版本號、品牌／產品名等）與上方「已知專案清單」`,
      `   - manifest 裡的 sourceFile/location/captionHint 都只是文件結構上的輔助線索，不能當作判斷依據。captionHint 尤其要小心：它只是該投影片或該頁文件裡離圖片最近的一段文字（例如投影片標題、頁面第一行字），**不是圖片內容的描述**，常常跟圖片實際畫面完全無關，絕對不能直接拿來當 suggestedCaption 或用來判斷 suggestedSlug`,
      `   - suggestedCaption 必須是你親眼看過這張圖片之後、針對這張圖片畫面裡實際出現的內容寫的一句話，且要先點出圖片類型（例如「折線圖，顯示…」「UI 截圖，顯示…」），不能套用 captionHint 或文件其他段落、其他圖片的內容`,
      `   - 同一份補充文件裡，不同圖片很可能對應到不同專案，每張圖片要獨立判斷，不要因為前後幾張圖片判斷成某專案就順勢套用`,
      `   - 純裝飾、背景、版頭版尾、公司 Logo、無資訊量的圖示，suggestedSlug 給 null 並在 reason 註明「裝飾性圖片」`,
      `   - 若你用 Read 工具實際開啟圖片後，發現回傳結果只是「檔案存在」之類的訊息、沒有真正的可視畫面內容（無法看到圖片裡的文字與構圖），代表目前這個執行環境暫時無法判讀圖片，請把所有圖片的 suggestedSlug 給 null，並在 reason 中誠實註明此原因，不要編造或瞎猜內容`,
      `4. 用 Write 工具把建議寫成 ${suggestionsPath}，格式為：`,
      `   {"images": [{"file": "{manifest 中的 file 檔名}", "suggestedSlug": "{已知專案清單中的 slug 或 null}", "suggestedCaption": "{一句話說明這張圖在說什麼}", "reason": "{為什麼建議這個專案，或為什麼判斷不相關}"}, ...]}`,
      `   陣列必須包含 manifest 裡的每一張圖片，數量要對得上，不可以省略`,
      `5. 完成後告知使用者：補充文件已萃取出幾張圖片、建議寫好了，請到前端「圖片分類確認」面板逐一確認後才會真正寫入專案記錄`,
    )

    parts.push(
      ``,
      `## 補充文件 ess-kms 連結萃取（只萃取連結，不要抓內容、不要分類、不要寫任何檔案）`,
      ``,
      `上述補充文件內文可能夾帶 https://ess-kms.edgecenter.io/{path} 形式的知識庫連結。你只需要把這些連結萃取出來：`,
      `1. 執行：python3 ${LINK_EXTRACT_SCRIPT} ${imageSourcePaths.map(p => `"${p}"`).join(' ')} --output-dir ${assetsDir} --manifest ${assetsDir}/links-manifest-${meetingDate}.json`,
      `2. 這支腳本會產生 ${assetsDir}/links-manifest-${meetingDate}.json（列出所有 ess-kms 連結的 path）`,
      `3. 你「不需要」也「不可以」自己去抓這些連結的頁面內容、判斷專案歸屬或寫入任何專案記錄——頁面內容抓取與分類建議一律由後端負責`,
      `4. 完成後告知使用者：補充文件已萃取出幾條 ess-kms 連結，請到前端「連結分類確認」面板逐一確認後才會真正寫入專案`,
    )
  }

  res.json({
    success: true,
    sessionKey,
    prompt: parts.join('\n'),
    expectedPaths: outputEntries.map(e => ({ slug: e.slug, containerPath: e.filePath })),
    meetingDate,
  })
})

app.get('/api/meeting-record/distribution-result', requireAuth, async (req, res) => {
  const { meetingDate, slugs } = req.query

  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的日期格式' })
  if (!slugs || typeof slugs !== 'string') return res.status(400).json({ error: '缺少 slugs 參數' })

  const slugList = slugs.split(',').map(s => s.trim()).filter(s => validSlug(s))
  if (slugList.length === 0) return res.status(400).json({ error: '無有效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')

  const completed = []
  const pending = []

  for (const slug of slugList) {
    const hostPath = recordFilePath(hostInsightsDir, slug, meetingDate)
    if (hostPath && fs.existsSync(hostPath)) {
      try {
        const raw = fs.readFileSync(hostPath, 'utf8')
        const lines = raw.split('\n')
        if (lines[0] !== undefined && /^#\s*會議記錄/.test(lines[0]) && lines[0] !== `# 會議記錄 — ${meetingDate}`) {
          lines[0] = `# 會議記錄 — ${meetingDate}`
          fs.writeFileSync(hostPath, lines.join('\n'), 'utf8')
        }
      } catch {}
      completed.push(slug)
    } else {
      pending.push(slug)
    }
  }

  res.json({ ready: pending.length === 0, completed, pending, total: slugList.length })
})

app.get('/api/meeting-record/image-review', requireAuth, async (req, res) => {
  const { meetingDate } = req.query
  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的日期格式' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const manifestPath = imageManifestPathFor(hostInsightsDir, meetingDate)

  const manifest = readJsonSafe(manifestPath)
  const generatedAt = manifest?.generatedAt ? new Date(manifest.generatedAt).getTime() : 0
  const fresh = !!generatedAt && (Date.now() - generatedAt <= IMAGE_REVIEW_FRESHNESS_MS)

  if (!fresh || !manifest?.images?.length) {
    return res.json({ fresh, images: [], allConfirmed: true })
  }

  const suggestions = readJsonSafe(suggestionsPathFor(hostInsightsDir, meetingDate))
  const suggestionMap = new Map((suggestions?.images || []).map(s => [s.file, s]))
  const assignments = readJsonSafe(assignmentsPathFor(hostInsightsDir, meetingDate)) || {}

  const images = manifest.images.map(img => {
    const suggestion = suggestionMap.get(img.file)
    const assignment = assignments[img.file]
    return {
      file: img.file,
      sourceFile: img.sourceFile,
      location: img.location,
      suggestedSlug: suggestion?.suggestedSlug ?? null,
      suggestedCaption: suggestion?.suggestedCaption ?? '',
      reason: suggestion?.reason ?? '',
      currentSlug: assignment?.slug ?? null,
      currentCaption: assignment?.caption ?? '',
      skipped: !!assignment?.skipped,
      confirmed: !!assignment,
    }
  })

  res.json({ fresh, images, allConfirmed: images.every(i => i.confirmed) })
})

app.post('/api/meeting-record/image-review/confirm', requireAuth, async (req, res) => {
  const { meetingDate, file, slug, caption, skip } = req.body ?? {}

  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的日期格式' })
  if (!file || typeof file !== 'string' || file.includes('..') || file.includes('/') || file.includes('\\')) {
    return res.status(400).json({ error: '無效的檔案名稱' })
  }
  if (!skip && !validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const manifestPath = imageManifestPathFor(hostInsightsDir, meetingDate)
  const manifest = readJsonSafe(manifestPath)
  const imgMeta = manifest?.images?.find(i => i.file === file)
  if (!imgMeta) return res.status(404).json({ error: '找不到對應的圖片（manifest 已變更或過期）' })

  const assignmentsPath = assignmentsPathFor(hostInsightsDir, meetingDate)
  const assignments = readJsonSafe(assignmentsPath) || {}
  const previous = assignments[file]

  // 若先前已指派到別的專案，先把舊記錄檔裡的 bullet 移除，避免同一張圖片留在兩個專案裡
  if (previous?.slug && previous.slug !== (skip ? null : slug)) {
    const oldPath = recordFilePath(hostInsightsDir, previous.slug, meetingDate)
    if (oldPath && fs.existsSync(oldPath)) {
      try {
        fs.writeFileSync(oldPath, removeImageBullet(fs.readFileSync(oldPath, 'utf8'), file), 'utf8')
      } catch {}
    }
  }

  if (skip) {
    assignments[file] = { slug: null, caption: null, skipped: true, confirmedAt: new Date().toISOString() }
    writeJsonSafe(assignmentsPath, assignments)
    return res.json({ success: true, file, slug: null, skipped: true })
  }

  if (!caption || typeof caption !== 'string' || !caption.trim()) {
    return res.status(400).json({ error: '請填寫圖片說明' })
  }

  const projectsData = readJsonSafe(path.join(hostInsightsDir, 'reviewer', 'projects.json'))
  const project = (projectsData?.projects || []).find(p => (p.slug || p.id) === slug)
  const projectName = project?.name || slug

  const recordPath = recordFilePath(hostInsightsDir, slug, meetingDate)
  if (!recordPath) return res.status(403).json({ error: '無權限' })

  let content
  if (fs.existsSync(recordPath)) {
    content = fs.readFileSync(recordPath, 'utf8')
  } else {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true })
    content = `# 會議記錄 — ${meetingDate}\n> 專案：${projectName}\n`
  }

  const bulletLine = `- ${caption.trim()}（來源：${imgMeta.sourceFile}，${imgMeta.location}） ![](../_assets/${file})`
  fs.writeFileSync(recordPath, upsertImageBullet(content, file, bulletLine), 'utf8')

  assignments[file] = { slug, caption: caption.trim(), skipped: false, confirmedAt: new Date().toISOString() }
  writeJsonSafe(assignmentsPath, assignments)

  res.json({ success: true, file, slug, skipped: false })
})

// 給使用者在前端快速測試：對單一一張圖片，直接請 agent 用 Read 工具親眼檢視並回報一句話描述，
// 不寫入任何 suggestions/assignments 檔案，純粹用來驗證目前這個環境的模型是否真的能讀到圖片畫面內容。
app.post('/api/meeting-record/image-review/test-caption', requireAuth, async (req, res) => {
  const { file, meetingDate } = req.body ?? {}
  if (!file || typeof file !== 'string' || file.includes('..') || file.includes('/') || file.includes('\\')) {
    return res.status(400).json({ error: '無效的檔案名稱' })
  }
  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的日期格式' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const manifestPath = imageManifestPathFor(hostInsightsDir, meetingDate)
  const manifest = readJsonSafe(manifestPath)
  const imgMeta = manifest?.images?.find(i => i.file === file)
  if (!imgMeta) return res.status(404).json({ error: '找不到對應的圖片（manifest 已變更或過期）' })

  const containerImagePath = `${CONTAINER_INSIGHTS_DIR}/_assets/${file}`
  const prompt = [
    `請用 Read 工具開啟並親眼檢視這張圖片：${containerImagePath}`,
    `用一句話老實描述你實際在畫面裡看到的內容（圖表類型、UI 截圖、流程圖等，以及裡面出現的關鍵文字或術語）。`,
    `若 Read 工具回傳的內容只是「檔案存在」之類的訊息、你其實看不到真正的可視畫面，就照實回答「目前讀不到這張圖片的真實畫面內容」，不要瞎猜或編造。`,
    `只回覆這一句話本身，不要加引號、不要寫步驟說明、不要有其他文字。`,
  ].join('\n')

  try {
    const client = getClientForUser(provisionUserId)
    const sessionKey = makeScopedSessionKey('img-test')
    const lastMsg = await sendAndStreamOrThrow(client, sessionKey, prompt)
    const caption = (lastMsg.content || '').trim().replace(/^["「]|["」]$/g, '')
    res.json({ success: true, caption })
  } catch (err) {
    res.status(502).json({ error: err.message || 'AI 測試判讀失敗' })
  }
})

// ── 補充文件 ess-kms 連結分發 ────────────────────────────────────────────────
// 讀 links-manifest.json（agent 萃取的 URL 清單），逐條 GraphQL 抓 title+content 並請 LLM
// 給專案建議，結果快取到 link-review-{date}.json；再合併使用者的 link-assignments-{date}.json。
app.get('/api/meeting-record/link-review', requireAuth, async (req, res) => {
  const { meetingDate } = req.query
  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的日期格式' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const manifestPath = linksManifestPathFor(hostInsightsDir, meetingDate)

  const manifest = readJsonSafe(manifestPath)
  // agent 有時沒寫 generatedAt，改用檔案 mtime 當新鮮度依據（manifest 每次分發都會重寫）。
  let manifestStamp = manifest?.generatedAt ? new Date(manifest.generatedAt).getTime() : 0
  if (!manifestStamp) {
    try { manifestStamp = fs.statSync(manifestPath).mtimeMs } catch {}
  }
  const fresh = !!manifestStamp && (Date.now() - manifestStamp <= IMAGE_REVIEW_FRESHNESS_MS)

  // 正規化每筆連結（處理 path 塞完整 URL、含 locale 前綴、缺欄位等變異），依 path 去重。
  const normalized = []
  const seenPaths = new Set()
  for (const entry of (manifest?.links || [])) {
    const link = normalizeKmsLink(entry)
    if (!link || seenPaths.has(link.path)) continue
    seenPaths.add(link.path)
    normalized.push(link)
  }

  if (!fresh || normalized.length === 0) {
    return res.json({ fresh, links: [], allConfirmed: true })
  }

  // 快取：只要 manifest 沒換新（stamp 相同），就沿用已抓好的 title/content/建議，避免每次輪詢都重打 GraphQL 與 LLM。
  // 前綴 cache 版本號：修了 normalize/localize 邏輯後，讓舊的錯誤快取自動失效重建。
  const cacheKey = `v3-${manifestStamp}`
  const cachePath = linkReviewCachePathFor(hostInsightsDir, meetingDate)
  let cache = readJsonSafe(cachePath)
  if (!cache || cache.cacheKey !== cacheKey) {
    const projectsData = readJsonSafe(path.join(hostInsightsDir, 'reviewer', 'projects.json'))
    const projects = (projectsData?.projects || [])
      .filter(p => p.name && (p.slug || p.id))
      .map(p => ({ name: p.name, slug: p.slug || p.id, description: p.description || '' }))

    const assetsDir = assetsDirFor(hostInsightsDir)
    const items = []
    for (const link of normalized) {
      const page = await fetchKmsPage(link.path, link.locale)
      if (!page) {
        items.push({
          path: link.path, url: link.url, sourceFile: link.sourceFile, location: link.location,
          title: link.path, content: '', excerpt: '', suggestedSlug: null,
          reason: ESS_KMS_GRAPHQL_TOKEN
            ? '無法透過 GraphQL 取得此頁面內容（可能是路徑錯誤或權限不足）'
            : '後端未設定 ESS_KMS_GRAPHQL_TOKEN，無法抓取頁面內容',
          fetchError: true,
        })
        continue
      }
      // 抓內容當下就把站內圖片下載到 _assets/ 並改寫路徑，讓「確認前」的預覽也看得到圖。
      const content = (await localizeKmsImages(page.content, assetsDir)).content
      const suggestion = await suggestLinkProject(provisionUserId, page.title, content, projects)
      items.push({
        path: link.path, url: link.url, sourceFile: link.sourceFile, location: link.location,
        title: page.title, content,
        excerpt: content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 200),
        suggestedSlug: suggestion.suggestedSlug, reason: suggestion.reason, fetchError: false,
      })
    }
    cache = { cacheKey, fetchedAt: new Date().toISOString(), items }
    writeJsonSafe(cachePath, cache)
  }

  const assignments = readJsonSafe(linkAssignmentsPathFor(hostInsightsDir, meetingDate)) || {}
  const links = (cache.items || []).map(item => {
    const assignment = assignments[item.path]
    return {
      path: item.path,
      url: item.url,
      sourceFile: item.sourceFile,
      location: item.location,
      title: item.title,
      excerpt: item.excerpt,
      suggestedSlug: item.suggestedSlug ?? null,
      reason: item.reason ?? '',
      fetchError: !!item.fetchError,
      currentSlug: assignment?.slug ?? null,
      skipped: !!assignment?.skipped,
      confirmed: !!assignment,
    }
  })

  res.json({ fresh, links, allConfirmed: links.every(l => l.confirmed) })
})

// 回傳單條連結抓回的完整 Markdown 內容，供前端預覽。
app.get('/api/meeting-record/link-review/preview', requireAuth, async (req, res) => {
  const { meetingDate, path: pagePath } = req.query
  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的日期格式' })
  if (!pagePath || typeof pagePath !== 'string') return res.status(400).json({ error: '缺少 path 參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const cache = readJsonSafe(linkReviewCachePathFor(hostInsightsDir, meetingDate))
  const item = (cache?.items || []).find(i => i.path === pagePath)
  if (!item) return res.status(404).json({ error: '找不到對應的連結（快取已變更或過期）' })

  // 直接在後端把本地化圖片路徑（../_assets/<file>）改寫成帶 token 的 asset 端點，讓任何前端
  // （不論版本）都能直接顯示圖片，不需前端再做一次替換。<img> 無法帶 Authorization header，
  // 所以走 ?token= query（同 asset 端點既有設計）。
  const bearer = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : ''
  const rewriteAssetPaths = (md) => (md || '').replace(
    /!\[([^\]]*)\]\((?:\.\.\/)?_assets\/([^)\s]+)\)/g,
    (_, alt, file) => `![${alt}](/api/project-insights/asset?file=${encodeURIComponent(file)}&token=${encodeURIComponent(bearer)})`,
  )

  // 已分類的連結：直接回傳已寫入 supplements 的檔案（圖片已下載、路徑已本地化），預覽即可看到圖。
  const assignment = (readJsonSafe(linkAssignmentsPathFor(hostInsightsDir, meetingDate)) || {})[pagePath]
  if (assignment?.slug && assignment?.file) {
    const filePath = supplementFilePath(hostInsightsDir, assignment.slug, assignment.file)
    if (filePath && fs.existsSync(filePath)) {
      try {
        return res.json({ title: item.title, content: rewriteAssetPaths(fs.readFileSync(filePath, 'utf8')), url: item.url, localized: true })
      } catch {}
    }
  }

  res.json({ title: item.title, content: rewriteAssetPaths(item.content), url: item.url, localized: false })
})

app.post('/api/meeting-record/link-review/confirm', requireAuth, async (req, res) => {
  const { meetingDate, path: pagePath, slug, skip } = req.body ?? {}

  if (!validDateFilename(meetingDate)) return res.status(400).json({ error: '無效的日期格式' })
  if (!pagePath || typeof pagePath !== 'string') return res.status(400).json({ error: '無效的連結路徑' })
  if (!skip && !validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostInsightsDir = path.join(paths.workspace, 'project-insights')
  const cache = readJsonSafe(linkReviewCachePathFor(hostInsightsDir, meetingDate))
  const item = (cache?.items || []).find(i => i.path === pagePath)
  if (!item) return res.status(404).json({ error: '找不到對應的連結（快取已變更或過期）' })

  const assignmentsPath = linkAssignmentsPathFor(hostInsightsDir, meetingDate)
  const assignments = readJsonSafe(assignmentsPath) || {}
  const previous = assignments[pagePath]

  // 重指派：先刪掉先前寫進舊專案 supplements 資料夾的那份檔案，避免同一頁殘留在兩個專案。
  if (previous?.slug && previous.file && previous.slug !== (skip ? null : slug)) {
    const oldFile = path.join(supplementsDir(hostInsightsDir, previous.slug), previous.file)
    if (oldFile.startsWith(supplementsDir(hostInsightsDir, previous.slug) + path.sep) && fs.existsSync(oldFile)) {
      try { fs.unlinkSync(oldFile) } catch {}
    }
  }

  if (skip) {
    assignments[pagePath] = { slug: null, file: null, skipped: true, confirmedAt: new Date().toISOString() }
    writeJsonSafe(assignmentsPath, assignments)
    return res.json({ success: true, path: pagePath, slug: null, skipped: true })
  }

  if (item.fetchError || !item.content) {
    return res.status(400).json({ error: '此連結沒有可寫入的內容（抓取失敗）' })
  }

  const dir = supplementsDir(hostInsightsDir, slug)
  fs.mkdirSync(dir, { recursive: true })

  // 重指派回同一專案時沿用舊檔名覆寫，否則產生新的唯一檔名。
  const filename = (previous?.slug === slug && previous?.file)
    ? previous.file
    : sanitizeTitleToFilename(item.title, dir)
  const filePath = path.join(dir, filename)
  if (!filePath.startsWith(dir + path.sep)) return res.status(400).json({ error: '無效的檔名' })

  const header = [
    `# ${item.title}`,
    ``,
    `> 來源：${item.url}`,
    `> 補充文件連結，會議日期：${meetingDate}`,
    ``,
  ].join('\n')
  let body = (item.content || '').replace(/\\n/g, '\n')
  // 把內文引用的 ess-kms 站內圖片（/xdept/public/... 等）下載到 _assets/ 並改寫成本地路徑。
  body = (await localizeKmsImages(body, assetsDirFor(hostInsightsDir))).content
  fs.writeFileSync(filePath, `${header}${body}\n`, 'utf8')

  assignments[pagePath] = { slug, file: filename, skipped: false, confirmedAt: new Date().toISOString() }
  writeJsonSafe(assignmentsPath, assignments)

  res.json({ success: true, path: pagePath, slug, file: filename, skipped: false })
})

// ── 專案補充資料（supplements-{slug}/，由 ess-kms 連結分發寫入） ──────────────
app.get('/api/project-supplements/list', requireAuth, async (req, res) => {
  const { slug } = req.query
  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const dir = supplementsDir(path.join(paths.workspace, 'project-insights'), slug)

  if (!fs.existsSync(dir)) return res.json({ records: [] })

  try {
    const records = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const name = f.replace(/\.md$/, '')
        let mtime = 0
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs } catch {}
        return { name, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)

    res.json({ records })
  } catch {
    res.status(500).json({ error: '讀取補充資料清單失敗' })
  }
})

app.get('/api/project-supplements/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query
  if (!validSlug(slug) || !validSupplementName(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = supplementFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    let content = fs.readFileSync(hostPath, 'utf8')
    // 修復既有檔案：若內文還有未下載的 ess-kms 站內圖片，下載到 _assets/ 並改寫路徑後回寫檔案。
    const assetsDir = assetsDirFor(path.join(paths.workspace, 'project-insights'))
    const localized = await localizeKmsImages(content, assetsDir)
    if (localized.changed) {
      content = localized.content
      try { fs.writeFileSync(hostPath, content, 'utf8') } catch {}
    }
    res.json({ content, name })
  } catch {
    res.status(500).json({ error: '讀取檔案失敗' })
  }
})

app.patch('/api/project-supplements/file', requireAuth, async (req, res) => {
  const { slug, name, content } = req.body ?? {}
  if (!validSlug(slug) || !validSupplementName(name)) return res.status(400).json({ error: '無效的參數' })
  if (typeof content !== 'string') return res.status(400).json({ error: '缺少 content' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = supplementFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true })
    fs.writeFileSync(hostPath, content, 'utf8')
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '儲存檔案失敗' })
  }
})

app.delete('/api/project-supplements/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query
  if (!validSlug(slug) || !validSupplementName(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = supplementFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    fs.unlinkSync(hostPath)
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '刪除檔案失敗' })
  }
})

app.get('/api/meeting-record/list', requireAuth, async (req, res) => {
  const { slug } = req.query

  if (!validSlug(slug)) return res.status(400).json({ error: '無效的專案識別碼' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const dir = recordDir(path.join(paths.workspace, 'project-insights'), slug)

  if (!fs.existsSync(dir)) return res.json({ records: [] })

  try {
    const records = fs.readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => {
        const name = f.replace(/\.md$/, '')
        let mtime = 0
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs } catch {}
        return { name, mtime }
      })
      .sort((a, b) => b.name.localeCompare(a.name))

    res.json({ records })
  } catch {
    res.status(500).json({ error: '讀取會議記錄清單失敗' })
  }
})

app.get('/api/meeting-record/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validDateFilename(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = recordFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    const content = fs.readFileSync(hostPath, 'utf8')
    res.json({ content, name })
  } catch {
    res.status(500).json({ error: '讀取檔案失敗' })
  }
})

app.patch('/api/meeting-record/file', requireAuth, async (req, res) => {
  const { slug, name, content } = req.body ?? {}

  if (!validSlug(slug) || !validDateFilename(name)) return res.status(400).json({ error: '無效的參數' })
  if (typeof content !== 'string') return res.status(400).json({ error: '缺少 content' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = recordFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true })
    fs.writeFileSync(hostPath, content, 'utf8')
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '儲存檔案失敗' })
  }
})

app.delete('/api/meeting-record/file', requireAuth, async (req, res) => {
  const { slug, name } = req.query

  if (!validSlug(slug) || !validDateFilename(name)) return res.status(400).json({ error: '無效的參數' })

  const provisionUserId = await getProvisionUserId(req.user.userId)
  const paths = getUserPaths(provisionUserId)
  const hostPath = recordFilePath(path.join(paths.workspace, 'project-insights'), slug, name)

  if (!hostPath) return res.status(403).json({ error: '無權限' })
  if (!fs.existsSync(hostPath)) return res.status(404).json({ error: '檔案不存在' })

  try {
    fs.unlinkSync(hostPath)
    res.json({ success: true, name })
  } catch {
    res.status(500).json({ error: '刪除檔案失敗' })
  }
})

// ── Project Insights Image Assets ─────────────────────────────────────────────
// Images extracted from meeting supplementary docs (see extract_supplementary_images.py),
// referenced from record-{slug}/{date}.md via `![](../_assets/<file>)`. <img> tags can't
// send an Authorization header, so this also accepts a `?token=` query param (same pattern
// as the reviewer iframe route below).

app.get('/api/project-insights/asset', async (req, res) => {
  const { file, token } = req.query

  if (!file || typeof file !== 'string' || file.includes('..') || file.includes('/') || file.includes('\\')) {
    console.warn('[asset] rejected: invalid file param', file)
    return res.status(400).json({ error: '無效的檔案名稱' })
  }

  let user
  try {
    const auth = req.headers.authorization ?? ''
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null
    user = verifyToken(bearer || token)
  } catch (err) {
    console.warn('[asset] rejected: token verify failed:', err.message)
    return res.status(401).json({ error: '未授權' })
  }

  const provisionUserId = await getProvisionUserId(user.userId)
  const paths = getUserPaths(provisionUserId)
  const assetsDir = path.join(paths.workspace, 'project-insights', '_assets')
  const hostPath = path.join(assetsDir, file)

  if (!hostPath.startsWith(assetsDir + path.sep) || !fs.existsSync(hostPath)) {
    console.warn('[asset] 404 not found:', hostPath)
    return res.status(404).json({ error: '檔案不存在' })
  }

  // Avoid res.sendFile(): Express runs encodeURI() on the path internally, which mangles
  // Windows backslash separators (\ -> %5C) and breaks the lookup in the `send` module.
  const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }
  try {
    const data = fs.readFileSync(hostPath)
    res.setHeader('Content-Type', mimeByExt[path.extname(hostPath).toLowerCase()] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.send(data)
  } catch (err) {
    console.error('[asset] read error:', err.message)
    res.status(500).json({ error: '讀取檔案失敗' })
  }
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
          content: rawRole === 'user' ? stripSenderMetadata(textContent) : stripDirectiveTags(textContent),
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
        },
      },
      gateway,
      session: { dmScope: 'per-channel-peer' },
      tools: { 
        profile: 'coding', 
        web: {
          "search": {
            "provider": "searxng",
            "enabled": true,
            "openaiCodex": {}
          },
          "fetch": {
            "enabled": true
          }
        }   
      },
      plugins: {
        entries: {
          google: { enabled: true },
          tokenjuice: { enabled: false },
          searxng: {
            "enabled": true,
            "config": {
              "webSearch": {
                "baseUrl": process.env.SEARXNG_BASE_URL
              }
            }
          }
        },
      },
      meta: {
        lastTouchedVersion: OPENCLAW_VERSION,
        lastTouchedAt: new Date().toISOString(),
      },
    }
  }

  const { baseUrl, apiKey, modelId, isReasoningModel } = llmConfig
  const modelRef = `custom/${modelId}`
  return {
    agents: {
      defaults: {
        workspace: '/home/node/.openclaw/workspace',
        sandbox: { mode: 'off' },
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
          // Replaces the legacy agents.defaults.llm.idleTimeoutSeconds (removed in 2026.6.8).
          // Without this the gateway falls back to a 120s idle timeout, which slower
          // custom/Azure-hosted models can exceed.
          timeoutSeconds: 1200,
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: !!isReasoningModel,
              // 'image' 讓 OpenClaw 把圖片真正的可視內容（而非僅檔名/metadata）附加到送給這個
              // custom 模型的請求裡；漏掉這個會讓 Read 工具對圖片只回傳「檔案存在」之類的訊息。
              input: ['text', 'image'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 524288,
              // gpt-5.4 最大輸出 128K tokens；32768 僅約 1/4 上限。
              // 調高以避免長文件（如大型會議記錄校正）在輸出中途被硬截斷。
              maxTokens: 64000,
              // 推理模型（gpt-5/o1/o3 系列等）不接受舊式 max_tokens，Azure/OpenAI 會直接 400
              // 拒絕請求（"Unsupported parameter: 'max_tokens'... Use 'max_completion_tokens'"），
              // 導致 LLM 完全沒有回應。maxTokensField 讓 OpenClaw 改送正確的參數名稱。
              compat: isReasoningModel
                ? { supportsUsageInStreaming: true, maxTokensField: 'max_completion_tokens' }
                : { supportsUsageInStreaming: true },
            },
          ],
        },
      },
    },
    gateway,
    session: { dmScope: 'per-channel-peer' },
    tools: { 
      profile: 'coding', 
      web: {
        "search": {
          "provider": "searxng",
          "enabled": true,
          "openaiCodex": {}
        },
        "fetch": {
          "enabled": true
        }
      }  
    },
    plugins: {
      entries: {
        tokenjuice: { enabled: false },
        searxng: {
          "enabled": true,
          "config": {
            "webSearch": {
              "baseUrl": process.env.SEARXNG_BASE_URL
            }
          }
        }
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
  const { userId, provider, geminiApiKey, baseUrl, apiKey, modelId, isReasoningModel, azureEndpoint, azureApiKey, azureDeploymentName, azureReasoningEffort } = req.body ?? {}

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
      : { provider: 'custom', baseUrl, apiKey, modelId, isReasoningModel: !!isReasoningModel }

  try {
    // 1. Allocate ports
    send('info', 'Allocating ports...')
    const ports = await allocatePorts(userId)
    send('success', `Ports allocated — gateway: ${ports.gatewayPort}, bridge: ${ports.bridgePort}, relay: ${ports.relayPort}`)

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
              relayPort: ports.relayPort,
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
          relayPort: ports.relayPort,
          gatewayToken,
          workspacePath: paths.workspace,
          provisionedAt: new Date().toISOString(),
        })
      }
    }

    // 7. Link team → workspace so getProvisionUserId resolves correctly
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
    relayPort: config?.relayPort || status.relayPort,
    containerId: config?.containerId || status.id,
    containerStatus: status.status,
    containerHealth: status.health,
    provisionedAt: config?.provisionedAt,
  })
})

// Update LLM config in openclaw.json and restart the container to apply it.
app.post('/api/container/update-llm', requireAuth, requireAdmin, async (req, res) => {
  const userId = await getProvisionUserId(req.user.userId)
  const { provider, geminiApiKey, baseUrl, apiKey, modelId, isReasoningModel, azureEndpoint, azureApiKey, azureDeploymentName, azureReasoningEffort } = req.body ?? {}

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
      : { provider: 'custom', baseUrl, apiKey, modelId, isReasoningModel: !!isReasoningModel }

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

      // Stream new characters of the current assistant message (with directive
      // tags like [[reply_to_current]] stripped before they reach the UI).
      if (lastAssistantMsg) {
        const displayText = stripDirectiveTags(lastAssistantMsg.content)
        if (displayText.length > lastSentText.length) {
          const delta = displayText.slice(lastSentText.length)
          send({ type: 'chunk', messageId: frontendMsgId, text: delta })
          lastSentText = displayText
        }
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
  server.listen(port, '0.0.0.0')
}

// OpenClaw gateway prefixes user messages with sender metadata in JSONL storage.
// Strip it so only the actual user text is displayed.
// Format: "Sender (untrusted metadata): ```json {...} ``` [timestamp] actual_message"
function stripSenderMetadata(content) {
  if (typeof content !== 'string') return content
  const stripped = content.replace(/^Sender\s*\([^)]*\)\s*:?\s*```[a-z]*\s*\{[^`]*?\}\s*```\s*(?:\[[^\]]*\]\s*)?/i, '').trim()
  return stripped || content.trim()
}

// OpenClaw lets the model emit inline directive tags (e.g. [[reply_to_current]],
// [[reply_to: <id>]], [[audio_as_voice]]) that control delivery behavior but
// must never reach the user as literal text.
const DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+|audio_as_voice)\s*\]\]/gi

function stripDirectiveTags(content) {
  if (typeof content !== 'string' || !content || !content.includes('[[')) return content
  return content.replace(DIRECTIVE_TAG_RE, '').replace(/^\s+/, '')
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
          content: rawRole === 'user' ? stripSenderMetadata(textContent) : stripDirectiveTags(textContent),
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

      // Stream new characters (with directive tags like [[reply_to_current]]
      // stripped before they reach the UI).
      if (lastAssistantMsg?.content) {
        const displayText = stripDirectiveTags(lastAssistantMsg.content)
        if (displayText.length > lastSentText.length) {
          const delta = displayText.slice(lastSentText.length)
          send({ type: 'chunk', messageId: currentMsgId, text: delta })
          lastSentText = displayText
        }
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
