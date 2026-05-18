import { randomUUID } from 'node:crypto'
import { query } from '../db.js'

const MAX_HISTORY = 100
const RETENTION_HOURS = 24

export async function getHistory(userId, limit = 100) {
  const { rows } = await query(
    `SELECT id, user_id, role, content, timestamp, extra
     FROM (
       SELECT * FROM chat_messages
       WHERE user_id = $1
         AND timestamp >= NOW() - INTERVAL '${RETENTION_HOURS} hours'
       ORDER BY timestamp DESC
       LIMIT $2
     ) sub
     ORDER BY timestamp ASC`,
    [userId, Math.min(limit, MAX_HISTORY)],
  )
  return rows.map(rowToMsg)
}

export async function appendMessage(userId, msg) {
  const id = msg.id || randomUUID()
  const ts = msg.timestamp ? new Date(msg.timestamp) : new Date()
  const { role, content, ...extra } = msg
  delete extra.id
  delete extra.timestamp

  await query(
    `INSERT INTO chat_messages (id, user_id, role, content, timestamp, extra)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, role, content, ts, extra],
  )

  await query(
    `DELETE FROM chat_messages
     WHERE user_id = $1
       AND timestamp < NOW() - INTERVAL '${RETENTION_HOURS} hours'`,
    [userId],
  )

  return { ...msg, id, timestamp: ts.toISOString() }
}

export function createMessage(role, content, extra = {}) {
  return {
    id: randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  }
}

function rowToMsg(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
    ...row.extra,
  }
}
