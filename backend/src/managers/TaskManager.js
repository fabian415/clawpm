import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '../db.js'
import { getWorkspaceFolder } from './TeamManager.js'
import { getUserPaths } from '../containers/WorkspaceManager.js'
import { getClientForUser, makeScopedSessionKey, sendAndStream } from './OpenClawClient.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTAINER_WORKSPACE = '/home/node/.openclaw/workspace'
const CONTAINER_INSIGHTS_DIR = `${CONTAINER_WORKSPACE}/project-insights`
const AUTO_ADVANCE_DELAY_MS = 10_000
const MAX_TERMS = 30

const inProgressTasks = new Set()

// ── Persistence ───────────────────────────────────────────────────────────────

function rowToTask(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    createdByUserId: row.created_by_user_id,
    provisionUserId: row.provision_user_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    meetingDate: row.meeting_date instanceof Date
      ? `${row.meeting_date.getFullYear()}-${String(row.meeting_date.getMonth() + 1).padStart(2, '0')}-${String(row.meeting_date.getDate()).padStart(2, '0')}`
      : row.meeting_date,
    audioFileName: row.audio_file_name,
    currentStep: row.current_step,
    status: row.status,
    autoAdvanceAt: row.auto_advance_at instanceof Date ? row.auto_advance_at.toISOString() : row.auto_advance_at,
    errorStep: row.error_step,
    errorMessage: row.error_message,
    stepStatuses: row.step_statuses,
    data: row.data,
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createTask({ teamId, createdByUserId, provisionUserId, meetingDate, audioFileName, data: initialData = {} }) {
  const autoAdvanceAt = new Date(Date.now() + AUTO_ADVANCE_DELAY_MS)
  const stepStatuses = { 1: 'done', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending' }
  const data = {
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
  }

  const { rows } = await query(
    `INSERT INTO tasks
       (team_id, created_by_user_id, provision_user_id, meeting_date, audio_file_name,
        current_step, status, auto_advance_at, step_statuses, data)
     VALUES ($1, $2, $3, $4, $5, 1, 'waiting', $6, $7, $8)
     RETURNING *`,
    [
      teamId, createdByUserId, provisionUserId,
      meetingDate || new Date().toISOString().slice(0, 10),
      audioFileName || '',
      autoAdvanceAt,
      stepStatuses,
      data,
    ],
  )
  return rowToTask(rows[0])
}

export async function getTask(id) {
  const { rows } = await query('SELECT * FROM tasks WHERE id = $1', [id])
  return rows[0] ? rowToTask(rows[0]) : null
}

export async function listTasksForTeam(teamId) {
  const { rows } = await query(
    'SELECT * FROM tasks WHERE team_id = $1 ORDER BY created_at DESC',
    [teamId],
  )
  return rows.map(rowToTask)
}

export async function updateTask(id, updates) {
  const sets = []
  const vals = []
  let i = 1

  const colMap = {
    teamId: 'team_id',
    createdByUserId: 'created_by_user_id',
    provisionUserId: 'provision_user_id',
    meetingDate: 'meeting_date',
    audioFileName: 'audio_file_name',
    currentStep: 'current_step',
    status: 'status',
    autoAdvanceAt: 'auto_advance_at',
    errorStep: 'error_step',
    errorMessage: 'error_message',
    stepStatuses: 'step_statuses',
  }

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      sets.push(`${col} = $${i++}`)
      vals.push(updates[key])
    }
  }

  if (updates.data) {
    // Shallow-merge JSONB data field
    sets.push(`data = data || $${i++}`)
    vals.push(updates.data)
  }

  if (sets.length === 0) return getTask(id)

  vals.push(id)
  const { rows } = await query(
    `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals,
  )
  return rows[0] ? rowToTask(rows[0]) : null
}

export async function deleteTask(id) {
  const { rowCount } = await query('DELETE FROM tasks WHERE id = $1', [id])
  return rowCount > 0
}

export async function pauseTask(id) {
  return updateTask(id, { status: 'paused', autoAdvanceAt: null })
}

export async function resumeTask(id) {
  return updateTask(id, { status: 'waiting', autoAdvanceAt: new Date(Date.now() + AUTO_ADVANCE_DELAY_MS).toISOString() })
}

export async function retryTask(id) {
  const task = await getTask(id)
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

async function setError(taskId, step, message) {
  await updateTask(taskId, { status: 'error', errorStep: step, errorMessage: message, autoAdvanceAt: null })
}

async function completeStep(taskId, completedStep, dataUpdates = {}) {
  const current = await getTask(taskId)
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

// sendAndStream() resolves even when the LLM never produced a response (e.g. gateway
// timeout, bad API key/model config) — it just calls onUpdate({ lastAssistantMsg: null, done: true })
// so callers can detect the failure themselves. The step runners below all passed a no-op
// callback and ignored that signal, so a non-responding LLM looked identical to success:
// the step would "complete" with no actual output. This wrapper makes that failure explicit.
export async function sendAndStreamOrThrow(client, sessionKey, message) {
  let lastMsg = null
  await sendAndStream(client, sessionKey, message, (update) => {
    if (update?.lastAssistantMsg) lastMsg = update.lastAssistantMsg
  })
  if (!lastMsg) {
    throw new Error('LLM 未回應（逾時或連線失敗），請確認 LLM API 金鑰與模型設定是否正確')
  }
  return lastMsg
}

async function runStep(task) {
  const { id, currentStep, provisionUserId } = task
  inProgressTasks.add(id)
  await updateTask(id, { status: 'running', autoAdvanceAt: null })

  try {
    const paths = getUserPaths(provisionUserId)
    if (currentStep === 2) await runExtractionStep(task, paths)
    else if (currentStep === 3) await runTranscriptionStep(task, paths)
    else if (currentStep === 4) await runMeetingNotesStep(task, paths)
    else if (currentStep === 5) await runInsightsStep(task, paths)
  } catch (err) {
    console.error(`[task-worker] step ${currentStep} error for task ${id}:`, err.message)
    await setError(id, currentStep, err.message)
  } finally {
    inProgressTasks.delete(id)
  }
}

async function runExtractionStep(task, paths) {
  const { id, data } = task
  const docs = (data.uploadedDocPaths || []).filter(d => d.remotePath && !d.error)

  if (docs.length === 0) {
    await completeStep(id, 2, {})
    return
  }

  const sourceDoc = docs[0]
  const sourcePath = sourceDoc.remotePath
  const originalName = sourceDoc.name
  const allowedPrefix = `/${task.provisionUserId}/workspace/`

  if (!sourcePath?.startsWith(allowedPrefix)) {
    await completeStep(id, 2, {})
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

  await updateTask(id, { data: { extractionOutputPath: outputPath } })

  const client = getClientForUser(task.provisionUserId)
  await sendAndStreamOrThrow(client, sessionKey, prompt)

  const relPath = outputPath.slice(CONTAINER_WORKSPACE.length)
  const hostPath = path.join(paths.workspace, relPath)
  const tags = await pollForCsvTags(hostPath, 60_000, 3_000)

  await completeStep(id, 2, { extractionOutputPath: outputPath, tags })
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
    await updateTask(id, { data: { transcriptJobId: jobId, transcriptContainerPath: transcriptOutputPath } })
  }

  const content = await pollWhisperXJobDirect(jobId, whisperxBase, whisperxHeaders, outputHostPath)
  await completeStep(id, 3, { transcriptJobId: jobId, transcriptContainerPath: transcriptOutputPath, transcriptRawContent: content })
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

  await updateTask(id, { data: { meetingNotesOutputPath: notesOutputContainerPath } })

  const client = getClientForUser(task.provisionUserId)
  await sendAndStreamOrThrow(client, sessionKey, prompt)

  const relPath = notesOutputContainerPath.slice(CONTAINER_WORKSPACE.length)
  const hostPath = path.join(paths.workspace, relPath)
  const content = await pollForFile(hostPath, 120_000, 5_000)

  await completeStep(id, 4, { meetingNotesOutputPath: notesOutputContainerPath, meetingNotesContent: content })
}

const INSIGHTS_SHRINK_WARN_RATIO = 0.15
const INSIGHTS_SHRINK_MIN_CHARS = 500

function projectMarkdownHostPath(workspaceHostPath, slug) {
  return path.join(workspaceHostPath, 'project-insights', `${slug}.md`)
}

function countBullets(content) {
  return (content.match(/^[ \t]*[-*]\s+/gm) || []).length
}

export function readProjectMarkdownSnapshot(workspaceHostPath, slug) {
  const hostPath = projectMarkdownHostPath(workspaceHostPath, slug)
  try {
    const content = fs.readFileSync(hostPath, 'utf8')
    return { hostPath, content, length: content.length, bulletCount: countBullets(content) }
  } catch {
    return null
  }
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
      .map(p => ({ name: p.name, slug: p.slug || p.id, description: p.description || '' }))
  } catch {}

  // 在觸發 skill 前先讀出每個既有專案目前的 Markdown 快照（只在後端本地比對用，不塞進 prompt，
  // 避免把整份舊內容重複攤進輸入 token），事後用來偵測內容是否被誤刪而非增量合併。
  const beforeSnapshots = {}
  for (const p of knownProjects) {
    const snap = readProjectMarkdownSnapshot(paths.workspace, p.slug)
    if (snap) beforeSnapshots[p.slug] = snap
  }

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
    )
  }

  await updateTask(id, { data: { insightsOutputDir: CONTAINER_INSIGHTS_DIR, insightsBeforeMtime: beforeMtime, existingProjectIds } })

  const client = getClientForUser(task.provisionUserId)
  await sendAndStreamOrThrow(client, sessionKey, parts.join('\n'))

  await pollForProjectsUpdate(projectsJsonHostPath, beforeMtime, 120_000, 10_000)

  const sizeChecks = await checkInsightsRegression(client, sessionKey, paths.workspace, beforeSnapshots)
  await ensureProjectDescriptions(client, sessionKey, paths.workspace)

  await completeStep(id, 5, { insightsSizeChecks: sizeChecks })
}

// SKILL.md 已經要求 agent 自己維護 projects.json 的 description 欄位，但這是埋在一長串指示裡的一條，
// 容易被忽略。這裡做最後一道保險：跑完主要工作後，檢查有沒有專案的 description 還是空的，
// 有的話在同一個 session 裡（agent 已經讀過相關 markdown，不需要重新給內容）追加一輪明確要求。
export async function ensureProjectDescriptions(client, sessionKey, workspaceHostPath) {
  const projectsJsonPath = path.join(workspaceHostPath, 'project-insights', 'reviewer', 'projects.json')

  const readProjects = () => {
    try { return JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8')).projects || [] } catch { return [] }
  }

  const missing = readProjects().filter(p => !p.description || !String(p.description).trim())
  if (missing.length === 0) return

  const followUp = [
    '以下專案目前在 reviewer/projects.json 裡沒有 description（或是空字串）：',
    ...missing.map(p => `- ${p.name || p.slug}（${(p.slug || p.id)}.md）`),
    '',
    '請讀取每個專案對應的 Markdown 內容，幫忙寫一個 1-3 句話的描述（範疇、核心技術領域、關鍵字），' +
      '寫回 projects.json 對應的 description 欄位。這個欄位會被記錄分發、補充圖片分類建議拿來判斷內容歸屬，請盡量具體。',
  ].join('\n')

  try {
    await sendAndStreamOrThrow(client, sessionKey, followUp)
  } catch (err) {
    console.warn('[insights] description backfill follow-up failed, leaving as-is:', err.message)
    return
  }

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await sleep(5_000)
    if (readProjects().every(p => p.description && String(p.description).trim())) return
  }
}

// 比較更新前後每個既有專案 Markdown 的長度／bullet 數，
// 若大幅縮水（疑似誤刪舊內容而非增量合併），在同一個 session 裡追加一輪要求修正，
// 不直接判定整個 task 失敗，避免擋住自動化流程。
export async function checkInsightsRegression(client, sessionKey, workspaceHostPath, beforeSnapshots) {
  const shrunk = []
  const results = []

  for (const [slug, before] of Object.entries(beforeSnapshots)) {
    const after = readProjectMarkdownSnapshot(workspaceHostPath, slug)
    if (!after) continue
    const shrinkRatio = before.length > 0 ? (before.length - after.length) / before.length : 0
    const isShrunk = before.length >= INSIGHTS_SHRINK_MIN_CHARS && shrinkRatio >= INSIGHTS_SHRINK_WARN_RATIO
    results.push({
      slug,
      beforeLength: before.length, afterLength: after.length,
      beforeBullets: before.bulletCount, afterBullets: after.bulletCount,
      flaggedShrink: isShrunk,
    })
    if (isShrunk) shrunk.push({ slug, before, after })
  }

  if (shrunk.length === 0) return results

  const followUp = [
    '偵測到以下專案 Markdown 在這次更新後內容明顯變短，違反「增量寫作鐵則」（現狀型章節不可整節覆寫或刪除舊 bullet，只能加註取代標記）：',
    '',
    ...shrunk.map(s =>
      `- ${s.slug}.md：${s.before.length} → ${s.after.length} 字（bullet 數 ${s.before.bulletCount} → ${s.after.bulletCount}）`,
    ),
    '',
    '請重新檢查這些檔案：比對更新前版本（你剛才讀過／附在前一則訊息裡的內容），找出消失的 bullet，' +
      '若該事實仍然有效或只是被新事實延伸，請補回原文字並依規則加註取代標記，不要整段刪除。確認後再次完成 Step 5.5 自查並重新寫檔。',
  ].join('\n')

  // 這是針對已經大致成功的更新做的補救動作，不應該讓它的失敗（例如 LLM 沒回應）
  // 反過來讓整個本來已經成功的 insights step 被標記成失敗。
  try {
    await sendAndStreamOrThrow(client, sessionKey, followUp)
  } catch (err) {
    console.warn('[insights regression] follow-up correction failed, leaving as-is:', err.message)
    return results
  }

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await sleep(5_000)
    let stillShrunk = false
    for (const r of results) {
      if (!r.flaggedShrink) continue
      const after = readProjectMarkdownSnapshot(workspaceHostPath, r.slug)
      if (!after) continue
      r.afterLength = after.length
      r.afterBullets = after.bulletCount
      const ratio = beforeSnapshots[r.slug].length > 0
        ? (beforeSnapshots[r.slug].length - after.length) / beforeSnapshots[r.slug].length
        : 0
      r.flaggedShrink = ratio >= INSIGHTS_SHRINK_WARN_RATIO
      if (r.flaggedShrink) stillShrunk = true
    }
    if (!stillShrunk) break
  }

  return results
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
  throw new Error('等待 projects.json 更新超時，LLM 可能已回應但未實際完成寫入')
}

// ── Background worker ─────────────────────────────────────────────────────────

export function startTaskWorker() {
  setInterval(async () => {
    try {
      const now = new Date()
      const { rows } = await query(
        `SELECT * FROM tasks
         WHERE status = 'waiting'
           AND auto_advance_at IS NOT NULL
           AND auto_advance_at <= $1`,
        [now],
      )

      for (const row of rows) {
        const task = rowToTask(row)
        if (inProgressTasks.has(task.id)) continue

        const nextStep = task.currentStep + 1
        if (nextStep > 5) continue

        const taskToRun = { ...task, currentStep: nextStep }
        runStep(taskToRun).catch(err => console.error('[task-worker] unhandled:', err.message))
      }
    } catch (err) {
      console.error('[task-worker] tick error:', err.message)
    }
  }, 5_000)

  console.log('[task-worker] started')
}
