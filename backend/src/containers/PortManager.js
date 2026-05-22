import { query } from '../db.js'

function getPortRangeStart() { return parseInt(process.env.OPENCLAW_PORT_RANGE_START || '18800') }
function getPortRangeEnd()   { return parseInt(process.env.OPENCLAW_PORT_RANGE_END   || '19799') }

/**
 * Allocate a gateway+bridge port pair for a user.
 * Returns existing allocation if already assigned.
 */
export async function allocatePorts(userId) {
  const { rows: existing } = await query(
    'SELECT gateway_port, bridge_port, allocated_at FROM port_allocations WHERE user_id = $1',
    [userId],
  )
  if (existing.length > 0) {
    return {
      gatewayPort: existing[0].gateway_port,
      bridgePort: existing[0].bridge_port,
      allocatedAt: existing[0].allocated_at,
    }
  }

  const { rows: used } = await query(
    'SELECT gateway_port, bridge_port FROM port_allocations',
  )
  const usedPorts = new Set(used.flatMap(r => [r.gateway_port, r.bridge_port]))

  for (let port = getPortRangeStart(); port < getPortRangeEnd(); port += 2) {
    if (!usedPorts.has(port) && !usedPorts.has(port + 1)) {
      const { rows } = await query(
        `INSERT INTO port_allocations (user_id, gateway_port, bridge_port)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET gateway_port = EXCLUDED.gateway_port,
               bridge_port  = EXCLUDED.bridge_port,
               allocated_at = NOW()
         RETURNING gateway_port, bridge_port, allocated_at`,
        [userId, port, port + 1],
      )
      return {
        gatewayPort: rows[0].gateway_port,
        bridgePort: rows[0].bridge_port,
        allocatedAt: rows[0].allocated_at,
      }
    }
  }

  throw new Error(`No available ports in range ${getPortRangeStart()}-${getPortRangeEnd()}`)
}

/** Free the port pair allocated to a user. */
export async function releasePorts(userId) {
  const { rowCount } = await query('DELETE FROM port_allocations WHERE user_id = $1', [userId])
  return rowCount > 0
}

/** Return all current allocations as { userId: { gatewayPort, bridgePort } }. */
export async function listPorts() {
  const { rows } = await query('SELECT user_id, gateway_port, bridge_port, allocated_at FROM port_allocations')
  return Object.fromEntries(rows.map(r => [r.user_id, {
    gatewayPort: r.gateway_port,
    bridgePort: r.bridge_port,
    allocatedAt: r.allocated_at,
  }]))
}

/** Return ports for a specific user, or null if not allocated. */
export async function getPortsForUser(userId) {
  const { rows } = await query(
    'SELECT gateway_port, bridge_port, allocated_at FROM port_allocations WHERE user_id = $1',
    [userId],
  )
  if (rows.length === 0) return null
  return {
    gatewayPort: rows[0].gateway_port,
    bridgePort: rows[0].bridge_port,
    allocatedAt: rows[0].allocated_at,
  }
}
