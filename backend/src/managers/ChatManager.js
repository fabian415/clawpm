import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHAT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'chats.json')

function loadDb() {
  try { return JSON.parse(fs.readFileSync(CHAT_DB_PATH, 'utf8')) }
  catch { return { conversations: {} } }
}

function saveDb(db) {
  const dir = path.dirname(CHAT_DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CHAT_DB_PATH, JSON.stringify(db, null, 2))
}

export function getHistory(userId, limit = 100) {
  const conv = loadDb().conversations[userId] || []
  return conv.slice(-limit)
}

export function appendMessage(userId, msg) {
  const db = loadDb()
  if (!db.conversations[userId]) db.conversations[userId] = []
  db.conversations[userId].push(msg)
  if (db.conversations[userId].length > 300) {
    db.conversations[userId] = db.conversations[userId].slice(-300)
  }
  saveDb(db)
  return msg
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
