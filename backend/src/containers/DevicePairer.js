import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execInContainer, waitForHealthy } from './ContainerManager.js'
import { getUserPaths } from './WorkspaceManager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CONTAINER_DB_PATH = process.env.CLAWPM_CONTAINER_DB_PATH
  || path.join(__dirname, '..', '..', 'data', 'containers.json')

// ── Local DB helpers (replaces real DB for CLI testing) ─────────────────────

function loadContainerDb() {
  try {
    return JSON.parse(fs.readFileSync(CONTAINER_DB_PATH, 'utf8'))
  }
  catch {
    return { containers: {} }
  }
}

function saveContainerDb(db) {
  const dir = path.dirname(CONTAINER_DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CONTAINER_DB_PATH, JSON.stringify(db, null, 2))
}

export function saveContainerConfig(userId, config) {
  const db = loadContainerDb()
  db.containers[userId] = { ...db.containers[userId], ...config, updatedAt: new Date().toISOString() }
  saveContainerDb(db)
}

export function getContainerConfig(userId) {
  return loadContainerDb().containers[userId] || null
}

export function deleteContainerConfig(userId) {
  const db = loadContainerDb()
  delete db.containers[userId]
  saveContainerDb(db)
}

export function listContainerConfigs() {
  return loadContainerDb().containers
}

// ── Device identity helpers ──────────────────────────────────────────────────

/**
 * Read the device identity file written by the OpenClaw gateway into the
 * mounted identity directory.  Returns { deviceId, publicKeyPem, privateKeyPem }
 * or null if not yet created.
 */
export function readDeviceIdentity(userId) {
  const paths = getUserPaths(userId)
  const identityFile = path.join(paths.identity, 'device.json')

  try {
    const raw = fs.readFileSync(identityFile, 'utf8')
    const parsed = JSON.parse(raw)

    if (
      typeof parsed?.deviceId === 'string'
      && typeof parsed?.publicKeyPem === 'string'
    ) {
      return parsed
    }
  }
  catch {}

  return null
}

// ── Device pairing via docker exec ──────────────────────────────────────────

/**
 * Run `openclaw devices list --json` inside the gateway container.
 * Returns array of paired device records: [{ deviceId, role, scopes, ... }]
 */
async function listDevices(userId, { gatewayToken } = {}) {
  const cmd = ['node', 'dist/index.js', 'devices', 'list', '--json']
  if (gatewayToken) cmd.push('--token', gatewayToken)

  const { stdout } = await execInContainer(userId, cmd)

  try {
    const parsed = JSON.parse(stdout)
    // Response shape: { pending: [], paired: [{ deviceId, ... }] }
    if (Array.isArray(parsed?.paired)) return parsed.paired
    if (Array.isArray(parsed)) return parsed
  }
  catch {}

  return []
}

/**
 * Run `openclaw devices rotate --device <id> --json` inside the gateway container.
 * Returns the new operator token string, or null on failure.
 */
async function rotateDeviceToken(userId, deviceId, { gatewayToken } = {}) {
  const cmd = [
    'node', 'dist/index.js', 'devices', 'rotate',
    '--device', deviceId,
    '--role', 'operator',
    '--scope', 'operator.read',
    '--scope', 'operator.write',
    '--scope', 'operator.approvals',
    '--json',
  ]
  if (gatewayToken) cmd.push('--token', gatewayToken)

  const { stdout } = await execInContainer(userId, cmd)

  try {
    const parsed = JSON.parse(stdout)
    // Response shape varies; token is typically a top-level string or { token: "..." }
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
    if (typeof parsed?.token === 'string') return parsed.token
    if (typeof parsed?.operatorToken === 'string') return parsed.operatorToken
    if (typeof parsed?.value === 'string') return parsed.value
  }
  catch {
    // Fallback: plain text output
    const token = stdout.trim().split('\n').pop()?.trim()
    if (token && /^[a-f0-9]{32,}$/.test(token)) return token
  }

  return null
}

/**
 * Full device pairing flow for M3-04:
 * 1. Wait for the gateway container to be healthy
 * 2. Read the device identity file that the gateway wrote to the identity mount
 * 3. Run `devices list` inside the container to confirm the device
 * 4. Run `devices rotate` to issue an operator token
 * 5. Persist the token + deviceId to the container config DB
 *
 * Returns { deviceId, operatorToken } or throws on failure.
 */
export async function pairDevice(userId, { healthTimeoutMs = 60_000 } = {}) {
  console.log(`  [DevicePairer] Waiting for container to become healthy...`)
  await waitForHealthy(userId, healthTimeoutMs)

  // Load the gateway token from saved container config (needed to authenticate CLI calls)
  const saved = getContainerConfig(userId)
  const gatewayToken = saved?.gatewayToken

  console.log(`  [DevicePairer] Running 'devices list --json' in container...`)
  const devices = await listDevices(userId, { gatewayToken })
  const deviceId = devices[0]?.deviceId

  if (!deviceId) {
    throw new Error(
      `No paired device found for user ${userId}. `
      + 'The gateway may not have initialized yet — try again in a few seconds.',
    )
  }

  console.log(`  [DevicePairer] Device ID: ${deviceId.slice(0, 16)}...`)
  console.log(`  [DevicePairer] Running 'devices rotate --device ... --json' in container...`)

  const operatorToken = await rotateDeviceToken(userId, deviceId, { gatewayToken })

  if (!operatorToken) {
    throw new Error(`Failed to obtain operator token for device ${deviceId}`)
  }

  saveContainerConfig(userId, {
    deviceId,
    operatorToken,
    pairedAt: new Date().toISOString(),
  })

  console.log(`  [DevicePairer] Operator token obtained and saved.`)
  return { deviceId, operatorToken }
}
