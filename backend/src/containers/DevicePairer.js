import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '../db.js'
import { execInContainer, waitForHealthy } from './ContainerManager.js'
import { getUserPaths } from './WorkspaceManager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Container config DB helpers ──────────────────────────────────────────────

export async function saveContainerConfig(userId, config) {
  await query(
    `INSERT INTO container_configs (user_id, config, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET config     = container_configs.config || EXCLUDED.config,
           updated_at = NOW()`,
    [userId, config],
  )
}

export async function getContainerConfig(userId) {
  const { rows } = await query(
    'SELECT config FROM container_configs WHERE user_id = $1',
    [userId],
  )
  return rows[0]?.config ?? null
}

export async function deleteContainerConfig(userId) {
  await query('DELETE FROM container_configs WHERE user_id = $1', [userId])
}

export async function listContainerConfigs() {
  const { rows } = await query('SELECT user_id, config FROM container_configs')
  return Object.fromEntries(rows.map(r => [r.user_id, r.config]))
}

// ── Device identity helpers ──────────────────────────────────────────────────

export function readDeviceIdentity(userId) {
  const paths = getUserPaths(userId)
  const identityFiles = [
    path.join(paths.identity, 'device.json'),
    path.join(paths.base, 'identity', 'device.json'),
  ]

  for (const identityFile of identityFiles) {
    try {
      const raw = fs.readFileSync(identityFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (typeof parsed?.deviceId === 'string' && typeof parsed?.publicKeyPem === 'string') {
        return parsed
      }
    } catch {}
  }
  return null
}

// ── Device pairing via docker exec ──────────────────────────────────────────

async function listDevices(userId, { gatewayToken } = {}) {
  const cmd = ['node', 'dist/index.js', 'devices', 'list', '--json']
  if (gatewayToken) cmd.push('--token', gatewayToken)

  const { stdout } = await execInContainer(userId, cmd)
  try {
    const parsed = JSON.parse(stdout)
    if (Array.isArray(parsed?.paired)) return parsed.paired
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}

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
  console.log(`  [DevicePairer] devices rotate stdout: ${stdout.slice(0, 200)}`)
  try {
    const parsed = JSON.parse(stdout)
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
    // try every common key name the gateway might use
    for (const key of ['token', 'operatorToken', 'deviceToken', 'value', 'accessToken', 'secret']) {
      if (typeof parsed?.[key] === 'string' && parsed[key].trim()) return parsed[key].trim()
    }
  } catch {
    // fallback: last non-empty line that looks like a token
    const token = stdout.trim().split('\n').pop()?.trim()
    if (token && /^[A-Za-z0-9+/=_-]{20,}$/.test(token)) return token
  }
  console.error(`  [DevicePairer] Could not parse token from: ${stdout.slice(0, 300)}`)
  return null
}

export async function pairDevice(userId, { healthTimeoutMs = 60_000 } = {}) {
  console.log(`  [DevicePairer] Waiting for container to become healthy...`)
  await waitForHealthy(userId, healthTimeoutMs)

  const saved = await getContainerConfig(userId)
  const gatewayToken = saved?.gatewayToken

  console.log(`  [DevicePairer] Running 'devices list --json' in container...`)
  const devices = await listDevices(userId, { gatewayToken })
  const identity = readDeviceIdentity(userId)
  const identityDevice = identity?.deviceId
    ? devices.find(device => device?.deviceId === identity.deviceId)
    : null
  const deviceId = identityDevice?.deviceId || devices[0]?.deviceId

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

  await saveContainerConfig(userId, {
    deviceId,
    operatorToken,
    pairedAt: new Date().toISOString(),
  })

  console.log(`  [DevicePairer] Operator token obtained and saved.`)
  return { deviceId, operatorToken }
}
