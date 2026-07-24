import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import simpleGit from 'simple-git'

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 1500

// 讀 process.env 要在呼叫當下才做，不能是 module 頂層 const：
// server.js 的 import 全部跑完才會執行 dotenv.config()，module 頂層此時讀到的還是空字串。
function branch() {
  return process.env.AZURE_DEVOPS_BRANCH || 'main'
}

function authUrl() {
  const repoUrl = process.env.AZURE_DEVOPS_REPO_URL || ''
  const pat = process.env.AZURE_DEVOPS_PAT || ''
  if (!repoUrl) throw new Error('AZURE_DEVOPS_REPO_URL 未設定')
  if (!pat) throw new Error('AZURE_DEVOPS_PAT 未設定')
  const u = new URL(repoUrl)
  // Azure DevOps PAT-over-HTTPS：PAT 當 username、不帶密碼。
  // 曾試過「username 留空、PAT 當密碼」，git 認證失敗後會卡在互動式憑證詢問（無終端機環境下整個 hang 住），
  // 用 git ls-remote 實測過，PAT 當 username 才會直接成功。
  u.username = encodeURIComponent(pat)
  u.password = ''
  return u.toString()
}

function tmpCloneDir() {
  return path.join(os.tmpdir(), `clawpm-blog-publish-${randomBytes(8).toString('hex')}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// 全新 clone → 執行 fn(git, repoDir) → 無論成功失敗都清掉暫存目錄。
async function withFreshClone(fn) {
  const dir = tmpCloneDir()
  try {
    // GIT_TERMINAL_PROMPT=0：認證失敗就直接報錯，不要卡在互動式憑證詢問（server 環境沒有終端機可回應）。
    // 只加這一個變數就好，其餘沿用 spawn 預設繼承的 process.env；把整個 process.env 灌進 .env()
    // 會連 GIT_EDITOR 之類的變數也一併帶入，觸發 simple-git 的 allowUnsafeEditor 安全防呆而失敗。
    const git = simpleGit({ timeout: { block: 120000 } }).env('GIT_TERMINAL_PROMPT', '0')
    await git.clone(authUrl(), dir, ['--depth', '1', '--branch', branch(), '--single-branch'])
    const repoGit = simpleGit(dir).env('GIT_TERMINAL_PROMPT', '0')
    return await fn(repoGit, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// push 失敗（例如 remote 有新 commit）就整個重新 clone 再試一次，
// 而不是在舊 clone 裡 pull 合併 — 每次嘗試都是完整重來。
async function publishRetryable(fn) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await withFreshClone(fn)
    } catch (err) {
      lastErr = err
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastErr
}

function writeFiles(baseDir, files) {
  fs.mkdirSync(baseDir, { recursive: true })
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(baseDir, filename), content)
  }
}

// files: { filename: Buffer|string }
export async function publishDraft({ postFolder, files }) {
  return publishRetryable(async (git, repoDir) => {
    const postDir = path.join(repoDir, 'content', 'posts', postFolder)
    writeFiles(postDir, files)
    await git.add(['-A'])
    const status = await git.status()
    if (status.staged.length === 0 && status.created.length === 0) {
      return { commit: null, alreadyPublished: true }
    }
    await git.commit(`Publish blog: ${postFolder}`)
    await git.push('origin', branch())
    const log = await git.log({ maxCount: 1 })
    return { commit: log.latest?.hash || null, alreadyPublished: false }
  })
}

export async function unpublishDraft({ postFolder }) {
  return publishRetryable(async (git, repoDir) => {
    const postDir = path.join(repoDir, 'content', 'posts', postFolder)
    if (!fs.existsSync(postDir)) {
      return { commit: null, alreadyRemoved: true }
    }
    fs.rmSync(postDir, { recursive: true, force: true })
    await git.add(['-A'])
    await git.commit(`Unpublish blog: ${postFolder}`)
    await git.push('origin', branch())
    const log = await git.log({ maxCount: 1 })
    return { commit: log.latest?.hash || null, alreadyRemoved: false }
  })
}
