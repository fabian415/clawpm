import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { copyDirRecursive, SKILL_NAMES } from '../containers/WorkspaceManager.js'

const DRAFTS_DIRNAME = '.skill-drafts'

// ── Slug / path safety ───────────────────────────────────────────────────────

export function slugValid(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,49}$/.test(s)
}

export function isProtectedSkill(slug) {
  return SKILL_NAMES.includes(slug)
}

/** Resolves `slug` under `baseDir` and ensures the result cannot escape it. */
function resolveInside(baseDir, slug) {
  if (!slugValid(slug)) return null
  const resolved = path.resolve(baseDir, slug)
  const base = path.resolve(baseDir) + path.sep
  if (!resolved.startsWith(base)) return null
  return resolved
}

// ── Frontmatter ───────────────────────────────────────────────────────────────

/**
 * Lightweight parser for the single-line `key: value` frontmatter used by
 * every skill in this repo. Not a general YAML parser — deliberately so,
 * since no YAML dependency exists in this project and skill frontmatter
 * only ever needs `name` and `description` as flat strings.
 */
export function parseFrontmatter(content) {
  if (typeof content !== 'string') return null
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_]+):\s?(.*)$/)
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  return fields
}

export function hasValidFrontmatter(content) {
  const fm = parseFrontmatter(content)
  return !!(fm && fm.name && fm.description)
}

// ── Skills CRUD ───────────────────────────────────────────────────────────────

export function listSkills(paths) {
  const skillsDir = paths.skills
  if (!fs.existsSync(skillsDir)) return []

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== DRAFTS_DIRNAME)
    .map((e) => {
      const skillMdPath = path.join(skillsDir, e.name, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) return null
      let fm = null
      try { fm = parseFrontmatter(fs.readFileSync(skillMdPath, 'utf8')) } catch { fm = null }
      let mtime = 0
      try { mtime = fs.statSync(skillMdPath).mtimeMs } catch {}
      return {
        slug: e.name,
        name: fm?.name || e.name,
        description: fm?.description || '',
        protected: isProtectedSkill(e.name),
        mtime,
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.protected === b.protected ? a.slug.localeCompare(b.slug) : a.protected ? -1 : 1))
}

export function readSkill(paths, slug) {
  const dir = resolveInside(paths.skills, slug)
  if (!dir) return null
  const skillMdPath = path.join(dir, 'SKILL.md')
  if (!fs.existsSync(skillMdPath)) return null
  return {
    slug,
    content: fs.readFileSync(skillMdPath, 'utf8'),
    protected: isProtectedSkill(slug),
  }
}

export function createSkill(paths, slug, content) {
  if (isProtectedSkill(slug)) throw new Error('技能名稱與系統範本衝突')
  const dir = resolveInside(paths.skills, slug)
  if (!dir) throw new Error('無效的技能識別碼')
  if (fs.existsSync(dir)) throw new Error('技能已存在')
  if (!hasValidFrontmatter(content)) throw new Error('SKILL.md 缺少必要的 name/description frontmatter')

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
  return { slug }
}

export function updateSkill(paths, slug, content) {
  if (isProtectedSkill(slug)) throw new Error('系統範本技能不可編輯，請先複製為自訂技能')
  const dir = resolveInside(paths.skills, slug)
  if (!dir || !fs.existsSync(dir)) throw new Error('技能不存在')
  if (!hasValidFrontmatter(content)) throw new Error('SKILL.md 缺少必要的 name/description frontmatter')

  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
  return { slug }
}

export function deleteSkill(paths, slug) {
  if (isProtectedSkill(slug)) throw new Error('系統範本技能不可刪除')
  const dir = resolveInside(paths.skills, slug)
  if (!dir || !fs.existsSync(dir)) throw new Error('技能不存在')

  fs.rmSync(dir, { recursive: true, force: true })
}

export function cloneSkill(paths, sourceSlug, newSlug, newName) {
  if (isProtectedSkill(newSlug)) throw new Error('技能名稱與系統範本衝突')
  const srcDir = resolveInside(paths.skills, sourceSlug)
  const destDir = resolveInside(paths.skills, newSlug)
  if (!srcDir || !fs.existsSync(srcDir)) throw new Error('來源技能不存在')
  if (!destDir) throw new Error('無效的技能識別碼')
  if (fs.existsSync(destDir)) throw new Error('技能已存在')

  copyDirRecursive(srcDir, destDir)

  const skillMdPath = path.join(destDir, 'SKILL.md')
  let content = fs.readFileSync(skillMdPath, 'utf8')
  content = content.replace(/^(---\r?\n[\s\S]*?name:\s?).*$/m, `$1${newSlug}`)
  if (newName && newName.trim()) {
    content = content.replace(/^(description:\s?)/m, `description: [${newName.trim()}] `)
  }
  fs.writeFileSync(skillMdPath, content, 'utf8')

  return { slug: newSlug }
}

// ── AI-generated drafts ───────────────────────────────────────────────────────

function draftsDir(paths) {
  return path.join(paths.workspace, DRAFTS_DIRNAME)
}

function draftPath(paths, draftId) {
  if (typeof draftId !== 'string' || !/^[a-f0-9]{16,40}$/.test(draftId)) return null
  return path.join(draftsDir(paths), `${draftId}.md`)
}

export function createDraftId(paths) {
  const dir = draftsDir(paths)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return randomBytes(12).toString('hex')
}

export function readDraft(paths, draftId) {
  const p = draftPath(paths, draftId)
  if (!p || !fs.existsSync(p)) return { ready: false, content: null }
  return { ready: true, content: fs.readFileSync(p, 'utf8') }
}

export function deleteDraft(paths, draftId) {
  const p = draftPath(paths, draftId)
  if (p && fs.existsSync(p)) fs.rmSync(p, { force: true })
}

export function draftContainerPath(draftId) {
  return `${DRAFTS_DIRNAME}/${draftId}.md`
}
