import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getWorkspaceFolder } from './TeamManager.js'
import { getUserPaths } from '../containers/WorkspaceManager.js'
import { getClientForUser, makeScopedSessionKey, sendAndStream } from './OpenClawClient.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_FILE = path.resolve(__dirname, '../../data/tasks.json')
const CONTAINER_WORKSPACE = '/home/node/.openclaw/workspace'
const CONTAINER_INSIGHTS_DIR = `${CONTAINER_WORKSPACE}/project-insights`
const AUTO_ADVANCE_DELAY_MS = 10_000
const MAX_TERMS = 30

const inProgressTasks = new Set()

// ── Persistence ───────────────────────────────────────────────────────────────

function readTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return []
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).tasks || []
  } catch { return [] }
}

function writeTasks(tasks) {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true })
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks }, null, 2))
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createTask({ teamId, createdByUserId, provisionUserId, meetingDate, audioFileName, data: initialData = {} }) {
  const tasks = readTasks()
  const task = {
    id: randomUUID(),
    teamId,
    createdByUserId,
    provisionUserId,
    createdAt: new Date().toISOString(),
    meetingDate: meetingDate || new Date().toISOString().slice(0, 10),
    audioFileName: audioFileName || '',
    currentStep: 1,
    status: 'waiting',
    autoAdvanceAt: new Date(Date.now() + AUTO_ADVANCE_DELAY_MS).toISOString(),
    errorStep: null,
    errorMessage: null,
    stepStatuses: { 1: 'done', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending' },
    data: {
      uploadedMediaPath: null,
      uploadedOriginalName: null,
      uploadedDocPaths: [],
      tags: [],
      extractionOutputPath: null,
      transcriptJobId: null,
      transcriptContainerPath: null,
      transcriptRawContent: '',
      meetingNotesOutputPath: null,
      meetingNotesContent: '',
      meetingNotesType: '商務會議',
      insightsOutputDir: null,
      insightsBeforeMtime: 0,
      existingProjectIds: [],
      ...initialData,
    },
  }
  tasks.push(task)
  writeTasks(tasks)
  return task
}

export function getTask(id) {
  return readTasks().find(t => t.id === id) || null
}

export function listTasksForTeam(teamId) {
  return readTasks()
    .filter(t => t.teamId === teamId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function updateTask(id, updates) {
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx < 0) return null
  if (updates.data) {
    tasks[idx] = { ...tasks[idx], ...updates, data: { ...tasks[idx].data, ...updates.data } }
  } else {
    tasks[idx] = { ...tasks[idx], ...updates }
  }
  writeTasks(tasks)
  return tasks[idx]
}

export function deleteTask(id) {
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx < 0) return false
  tasks.splice(idx, 1)
  writeTasks(tasks)
  return true
}

export function pauseTask(id) {
  return updateTask(id, { status: 'paused', autoAdvanceAt: null })
}

export function resumeTask(id) {
  return updateTask(id, { status: 'waiting', autoAdvanceAt: new Date(Date.now() + AUTO_ADVANCE_DELAY_MS).toISOString() })
}

export function retryTask(id) {
  const task = getTask(id)
  if (!task || task.status !== 'error') return null
  return updateTask(id, { status: 'waiting', errorMessage: null, autoAdvanceAt: new Date(Date.now() + AUTO_ADVANCE_DELAY_MS).toISOString() })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function sanitizeBaseName(value) {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9一-龥._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function setError(taskId, step, message) {
  updateTask(taskId, { status: 'error', errorStep: step, errorMessage: message, autoAdvanceAt: null })
}

function completeStep(taskId, completedStep, dataUpdates = {}) {
  const current = getTask(taskId)
  if (!current) return null
  const isLast = completedStep >= 5
  return updateTask(taskId, {
    currentStep: completedStep,
    status: isLast ? 'completed' : 'waiting',
    autoAdvanceAt: isLast ? null : new Date(Date.now() + AUTO_ADVANCE_DELAY_MS).toISOString(),
    errorStep: null,
    errorMessage: null,
    stepStatuses: { ...current.stepStatuses, [completedStep]: 'done' },
    data: dataUpdates,
  })
}

// ── Step runners ──────────────────────────────────────────────────────────────

async function runStep(task) {
  const { id, currentStep, provisionUserId } = task
  inProgressTasks.add(id)
  updateTask(id, { status: 'running', autoAdvanceAt: null })

  try {
    const paths = getUserPaths(provisionUserId)
    if (currentStep === 2) await runExtractionStep(task, paths)
    else if (currentStep === 3) await runTranscriptionStep(task, paths)
    else if (currentStep === 4) await runMeetingNotesStep(task, paths)
    else if (currentStep === 5) await runInsightsStep(task, paths)
  } catch (err) {
    console.error(`[task-worker] step ${currentStep} error for task ${id}:`, err.message)
    setError(id, currentStep, err.message)
  } finally {
    inProgressTasks.delete(id)
  }
}

async function runExtractionStep(task, paths) {
  const { id, data } = task
  const docs = (data.uploadedDocPaths || []).filter(d => d.remotePath && !d.error)

  if (docs.length === 0) {
    completeStep(id, 2, {})
    return
  }

  const sourceDoc = docs[0]
  const sourcePath = sourceDoc.remotePath
  const originalName = sourceDoc.name
  const allowedPrefix = `/${task.provisionUserId}/workspace/`

  if (!sourcePath?.startsWith(allowedPrefix)) {
    completeStep(id, 2, {})
    return
  }

  const relativePath = sourcePath.slice(`/${task.provisionUserId}/workspace`.length)
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

  updateTask(id, { data: { extractionOutputPath: outputPath } })

  const client = getClientForUser(task.provisionUserId)
  await sendAndStream(client, sessionKey, prompt, () => {})

  const relPath = outputPath.slice(CONTAINER_WORKSPACE.length)
  const hostPath = path.join(paths.workspace, relPath)
  const tags = await pollForCsvTags(hostPath, 60_000, 3_000)

  completeStep(id, 2, { extractionOutputPath: outputPath, tags })
}

async function runTranscriptionStep(task, paths) {
  const { id, data } = task
  if (!data.uploadedMediaPath) throw new Error('未取得音訊檔案路徑')

  const allowedPrefix = `/${task.provisionUserId}/workspace/`
  if (!data.uploadedMediaPath.startsWith(allowedPrefix)) throw new Error('無效的媒體檔案路徑')

  const relativePath = data.uploadedMediaPath.slice(`/${task.provisionUserId}/workspace`.length)
  const hostAudioPath = path.join(paths.workspace, relativePath)
  if (!fs.existsSync(hostAudioPath)) throw new Error('找不到音訊檔案')

  const audioExt = path.extname(hostAudioPath)
  const baseName = path.basename(hostAudioPath, audioExt).replace(/---[0-9a-f-]{36}$/i, '')
  const outputHostPath = path.join(path.dirname(hostAudioPath), baseName, `${baseName}_逐字稿.md`)

  const containerAudioPath = `${CONTAINER_WORKSPACE}${relativePath}`
  const containerAudioDir = path.dirname(containerAudioPath)
  const transcriptOutputPath = `${containerAudioDir}/${baseName}/${baseName}_逐字稿.md`

  const whisperxBase = `http://${process.env.LOCAL_SERVER_IP || '172.22.12.162'}:${process.env.LOCAL_SERVER_PORT || '8787'}`
  const apiKey = process.env.LOCAL_API_KEY || ''
  const whisperxHeaders = apiKey ? { 'X-API-Key': apiKey } : {}

  let jobId = data.transcriptJobId

  if (!jobId) {
    let whisperModel = 'large-v3'
    try {
      const settingsPath = path.resolve('./data/app_settings.json')
      if (fs.existsSync(settingsPath)) {
        whisperModel = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).whisperModel || whisperModel
      }
    } catch {}

    const formData = new FormData()
    const audioBuffer = fs.readFileSync(hostAudioPath)
    formData.append('audio', new Blob([audioBuffer]), path.basename(hostAudioPath))
    formData.append('lang', 'zh')
    formData.append('model', whisperModel)
    if (data.tags?.length > 0) formData.append('terms', data.tags.join(', '))

    const uploadRes = await fetch(`${whisperxBase}/transcribe`, {
      method: 'POST',
      body: formData,
      headers: whisperxHeaders,
    })
    if (!uploadRes.ok) {
      const errBody = await uploadRes.json().catch(() => ({}))
      throw new Error(errBody.detail || `WhisperX 回傳 HTTP ${uploadRes.status}`)
    }
    const parsed = await uploadRes.json()
    jobId = parsed.job_id
    if (!jobId) throw new Error('WhisperX 未回傳 job_id')
    updateTask(id, { data: { transcriptJobId: jobId, transcriptContainerPath: transcriptOutputPath } })
  }

  const content = await pollWhisperXJobDirect(jobId, whisperxBase, whisperxHeaders, outputHostPath)
  completeStep(id, 3, { transcriptJobId: jobId, transcriptContainerPath: transcriptOutputPath, transcriptRawContent: content })
}

async function runMeetingNotesStep(task, paths) {
  const { id, data } = task
  if (!data.transcriptContainerPath) throw new Error('找不到逐字稿路徑')

  const transcriptDir = path.dirname(data.transcriptContainerPath)
  const transcriptBase = path.basename(data.transcriptContainerPath, '_逐字稿.md')
  const notesOutputContainerPath = `${transcriptDir}/${transcriptBase}_notes.md`

  const sessionKey = makeScopedSessionKey('meeting-notes')
  const resolvedDate = task.meetingDate || new Date().toISOString().slice(0, 10)

  const prompt = [
    '請執行 meeting-transcription skill 的步驟 2：讀取逐字稿並生成會議記錄。',
    '',
    `本次會議日期：${resolvedDate}`,
    `逐字稿路徑：${data.transcriptContainerPath}`,
    '',
    '請依序完成：',
    '1. 讀取逐字稿全文',
    '2. 判斷錄音類型（商務會議 / 訪談與使用者研究 / 知識學習與演講 / 其他）',
    '3. 依對應格式生成完整會議記錄',
    `4. 將完整結果**寫入以下固定路徑**（無論類型皆統一輸出此路徑）：\n   ${notesOutputContainerPath}`,
    '',
    '請直接執行，無需確認。',
  ].join('\n')

  updateTask(id, { data: { meetingNotesOutputPath: notesOutputContainerPath } })

  const client = getClientForUser(task.provisionUserId)
  await sendAndStream(client, sessionKey, prompt, () => {})

  const relPath = notesOutputContainerPath.slice(CONTAINER_WORKSPACE.length)
  const hostPath = path.join(paths.workspace, relPath)
  const content = await pollForFile(hostPath, 120_000, 5_000)

  completeStep(id, 4, { meetingNotesOutputPath: notesOutputContainerPath, meetingNotesContent: content })
}

async function runInsightsStep(task, paths) {
  const { id, data } = task

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

  const today = task.meetingDate || new Date().toISOString().slice(0, 10)
  const sessionKey = makeScopedSessionKey('insights')

  const parts = [
    '請使用 project-insight-synthesizer skill，將本次會議資料增量更新至專案知識庫。',
    '',
    `本次會議日期：${today}`,
  ]
  if (data.transcriptContainerPath) parts.push(`本次會議逐字稿路徑：${data.transcriptContainerPath}`)
  if (data.meetingNotesOutputPath) parts.push(`本次會議記錄路徑：${data.meetingNotesOutputPath}`)
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

  updateTask(id, { data: { insightsOutputDir: CONTAINER_INSIGHTS_DIR, insightsBeforeMtime: beforeMtime, existingProjectIds } })

  const client = getClientForUser(task.provisionUserId)
  await sendAndStream(client, sessionKey, parts.join('\n'), () => {})

  await pollForProjectsUpdate(projectsJsonHostPath, beforeMtime, 120_000, 10_000)

  completeStep(id, 5)
}

// ── Polling helpers ───────────────────────────────────────────────────────────

async function pollForCsvTags(hostPath, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    if (fs.existsSync(hostPath)) {
      try {
        const lines = fs.readFileSync(hostPath, 'utf8').split('\n').filter(Boolean)
        const tags = lines.slice(1).map(l => l.split(',')[0]?.trim()).filter(Boolean).slice(0, MAX_TERMS)
        if (tags.length > 0) return tags
      } catch {}
    }
  }
  return []
}

async function pollForFile(hostPath, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    if (fs.existsSync(hostPath)) {
      try {
        const content = fs.readFileSync(hostPath, 'utf8')
        if (content.trim()) return content
      } catch {}
    }
  }
  throw new Error('等待檔案超時')
}

async function pollWhisperXJobDirect(jobId, whisperxBase, headers, outputHostPath) {
  while (true) {
    await sleep(15_000)
    try {
      const res = await fetch(`${whisperxBase}/jobs/${jobId}`, { headers })
      if (!res.ok) throw new Error(`WhisperX HTTP ${res.status}`)
      const job = await res.json()
      if (job.status === 'done') {
        const resultRes = await fetch(`${whisperxBase}/jobs/${jobId}/result`, { headers })
        if (!resultRes.ok) throw new Error('無法下載轉錄結果')
        const content = await resultRes.text()
        fs.mkdirSync(path.dirname(outputHostPath), { recursive: true })
        fs.writeFileSync(outputHostPath, content, 'utf8')
        fetch(`${whisperxBase}/jobs/${jobId}`, { method: 'DELETE', headers }).catch(() => {})
        return content
      }
      if (job.status === 'failed') throw new Error(job.error || '轉錄失敗')
    } catch (err) {
      if (err.message.includes('轉錄失敗') || err.message.includes('無法下載')) throw err
    }
  }
}

async function pollForProjectsUpdate(projectsJsonPath, beforeMtime, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    try {
      if (fs.existsSync(projectsJsonPath) && fs.statSync(projectsJsonPath).mtimeMs > beforeMtime) return
    } catch {}
  }
}

// ── Background worker ─────────────────────────────────────────────────────────

export function startTaskWorker() {
  setInterval(async () => {
    try {
      const tasks = readTasks()
      const now = Date.now()
      for (const task of tasks) {
        if (task.status !== 'waiting') continue
        if (inProgressTasks.has(task.id)) continue
        if (!task.autoAdvanceAt || new Date(task.autoAdvanceAt).getTime() > now) continue

        const nextStep = task.currentStep + 1
        if (nextStep > 5) continue

        const taskToRun = { ...task, currentStep: nextStep, data: { ...task.data } }
        runStep(taskToRun).catch(err => console.error('[task-worker] unhandled:', err.message))
      }
    } catch (err) {
      console.error('[task-worker] tick error:', err.message)
    }
  }, 5_000)

  console.log('[task-worker] started')
}
