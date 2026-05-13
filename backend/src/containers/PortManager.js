import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Read lazily so dotenv.config() in server.js runs first
function getPortRangeStart() { return parseInt(process.env.OPENCLAW_PORT_RANGE_START || '18800') }
function getPortRangeEnd()   { return parseInt(process.env.OPENCLAW_PORT_RANGE_END   || '19799') }
const PORT_DB_PATH = process.env.CLAWPM_PORT_DB_PATH
  || path.join(__dirname, '..', '..', 'data', 'ports.json')

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(PORT_DB_PATH, 'utf8'))
  } catch {
    return { allocations: {} }
  }
}

function saveDb(db) {
  const dir = path.dirname(PORT_DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(PORT_DB_PATH, JSON.stringify(db, null, 2))
}

/**
 * Allocate a gateway+bridge port pair for a user.
 * Returns existing allocation if already assigned.
 */
export function allocatePorts(userId) {
  const db = loadDb()

  if (db.allocations[userId]) {
    return db.allocations[userId]
  }

  const usedPorts = new Set(
    Object.values(db.allocations).flatMap(a => [a.gatewayPort, a.bridgePort]),
  )

  for (let port = getPortRangeStart(); port < getPortRangeEnd(); port += 2) {
    if (!usedPorts.has(port) && !usedPorts.has(port + 1)) {
      const allocation = { gatewayPort: port, bridgePort: port + 1, allocatedAt: new Date().toISOString() }
      db.allocations[userId] = allocation
      saveDb(db)
      return allocation
    }
  }

  throw new Error(`No available ports in range ${getPortRangeStart()}-${getPortRangeEnd()}`)
}

/** Free the port pair allocated to a user. */
export function releasePorts(userId) {
  const db = loadDb()
  const had = Boolean(db.allocations[userId])
  delete db.allocations[userId]
  saveDb(db)
  return had
}

/** Return all current allocations: { userId: { gatewayPort, bridgePort } } */
export function listPorts() {
  return loadDb().allocations
}

/** Return ports for a specific user, or null if not allocated. */
export function getPortsForUser(userId) {
  return loadDb().allocations[userId] || null
}
