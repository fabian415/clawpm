import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WORKSPACE_BASE = process.env.CLAWPM_WORKSPACE_BASE
  || path.join(os.homedir(), '.openclaw', 'users')
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'
const OPENCLAW_VERSION = OPENCLAW_IMAGE.split(':').pop() || '2026.4.22'

const SKILLS_SOURCE = process.env.OPENCLAW_SKILLS_SOURCE_PATH
  || path.join(__dirname, '..', '..', '..', 'skills')


const SKILL_NAMES = [
  'meeting-transcription',
  'meeting-proper-noun-extractor',
  'project-insight-synthesizer',
]

/**
 * Returns all relevant paths for a user's workspace.
 * These are HOST paths used for Docker volume mounts and file operations.
 */
export function getUserPaths(userId) {
  const base = path.join(WORKSPACE_BASE, userId)
  return {
    base,
    config: path.join(base, 'config'),
    openclawJson: path.join(base, 'config', 'openclaw.json'),
    workspace: path.join(base, 'workspace'),
    skills: path.join(base, 'workspace', 'skills'),
    ftpData: path.join(base, 'workspace', 'ftp_data'),
    properNounInput: path.join(base, 'workspace', 'ftp_data', 'proper-noun-imports', 'input'),
    properNounOutput: path.join(base, 'workspace', 'ftp_data', 'proper-noun-imports', 'output'),
    media: path.join(base, 'workspace', 'ftp_data', 'media'),
    // The container mounts config/ to /home/node/.openclaw, so the gateway
    // writes its approved device identity under config/identity on the host.
    identity: path.join(base, 'config', 'identity'),
    workspaceEnv: path.join(base, 'workspace', '.env'),
  }
}

/**
 * Build the openclaw.json config for a per-user gateway container.
 * Generates a unique random token if none provided.
 * Reference structure: deployment/openclaw.json
 */
export function buildOpenClawConfig({ gatewayToken, hostPort } = {}) {
  const token = gatewayToken || randomBytes(32).toString('hex')

  const allowedOrigins = [
    'http://localhost:18789',
    'http://127.0.0.1:18789',
  ]
  if (hostPort && hostPort !== 18789) {
    allowedOrigins.push(`http://localhost:${hostPort}`)
    allowedOrigins.push(`http://127.0.0.1:${hostPort}`)
  }

  return {
    agents: {
      defaults: {
        workspace: '/home/node/.openclaw/workspace',
        sandbox: { mode: 'off' },
        models: { 'google/gemini-2.5-flash': {} },
        model: { primary: 'google/gemini-2.5-flash' },
      },
    },
    gateway: {
      mode: 'local',
      auth: {
        mode: 'token',
        token,
      },
      port: 18789,
      bind: 'lan',
      tailscale: { mode: 'off', resetOnExit: false },
      controlUi: {
        allowInsecureAuth: true,
        allowedOrigins,
      },
      nodes: {
        denyCommands: [
          'camera.snap', 'camera.clip', 'screen.record',
          'contacts.add', 'calendar.add', 'reminders.add',
          'sms.send', 'sms.search',
        ],
      },
    },
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

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return false
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    }
    else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
  return true
}

/**
 * Initialize the per-user workspace directory structure.
 * Idempotent: safe to call even if workspace already exists.
 *
 * @param {string} userId
 * @param {{ hostPort?: number }} options  hostPort = the host-mapped gateway port (added to allowedOrigins)
 * Returns { paths, gatewayToken, skillsCopied[], warnings[] }
 */
export function initializeWorkspace(userId, { hostPort } = {}) {
  const paths = getUserPaths(userId)
  const warnings = []
  const skillsCopied = []

  // Create all directories (skip file-path entries)
  const dirKeys = ['base', 'config', 'workspace', 'skills', 'ftpData', 'properNounInput', 'properNounOutput', 'media', 'identity']
  for (const key of dirKeys) {
    if (!fs.existsSync(paths[key])) fs.mkdirSync(paths[key], { recursive: true })
  }

  // Create openclaw.json in config dir (skip if already exists — preserve existing token)
  let gatewayToken
  if (fs.existsSync(paths.openclawJson)) {
    try {
      const existing = JSON.parse(fs.readFileSync(paths.openclawJson, 'utf8'))
      gatewayToken = existing?.gateway?.auth?.token
    }
    catch {
      warnings.push('Could not read existing openclaw.json — token may be lost')
    }
  }

  if (!gatewayToken) {
    const config = buildOpenClawConfig({ hostPort })
    gatewayToken = config.gateway.auth.token
    fs.writeFileSync(paths.openclawJson, JSON.stringify(config, null, 2), 'utf8')
  }

  // Copy skills from source
  for (const skill of SKILL_NAMES) {
    const src = path.join(SKILLS_SOURCE, skill)
    const dest = path.join(paths.skills, skill)
    if (copyDirRecursive(src, dest)) {
      skillsCopied.push(skill)
    }
    else {
      warnings.push(`Skill source not found: ${src}`)
    }
  }

  // Create config/.env (maps to ~/.openclaw/.env inside container — API keys written here by provision)
  const configEnvPath = path.join(paths.config, '.env')
  if (!fs.existsSync(configEnvPath)) {
    const configEnvContent = `# OpenClaw gateway env — user: ${userId}\n# Maps to ~/.openclaw/.env inside the container\n`
    fs.writeFileSync(configEnvPath, configEnvContent, 'utf8')
  }

  // Create workspace .env (empty placeholder, skip if already exists)
  if (!fs.existsSync(paths.workspaceEnv)) {
    const envContent = `# ClawPM user workspace — user: ${userId}\n# Generated: ${new Date().toISOString()}\n`
    fs.writeFileSync(paths.workspaceEnv, envContent, 'utf8')
  }

  return { paths, gatewayToken, skillsCopied, warnings }
}

/** Returns true if the user's workspace base directory exists. */
export function workspaceExists(userId) {
  return fs.existsSync(getUserPaths(userId).base)
}

/**
 * Update specific keys in the user's workspace .env file.
 * Only keys in ALLOWED_KEYS are accepted.
 */
const ALLOWED_ENV_KEYS = new Set([
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'WHISPER_MODEL',
  'EMAIL_RECIPIENTS',
])

export function updateWorkspaceEnv(userId, updates) {
  const paths = getUserPaths(userId)
  if (!fs.existsSync(paths.workspaceEnv)) {
    throw new Error(`Workspace .env not found for user: ${userId}`)
  }

  const rejected = Object.keys(updates).filter(k => !ALLOWED_ENV_KEYS.has(k))
  if (rejected.length > 0) {
    throw new Error(`Keys not allowed for update: ${rejected.join(', ')}`)
  }

  let content = fs.readFileSync(paths.workspaceEnv, 'utf8')

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`
    const regex = new RegExp(`^${key}=.*$`, 'm')
    if (regex.test(content)) {
      content = content.replace(regex, line)
    }
    else {
      content += `\n${line}`
    }
  }

  fs.writeFileSync(paths.workspaceEnv, content, 'utf8')
  return Object.keys(updates)
}

export { ALLOWED_ENV_KEYS }
