import fs from 'fs'
import path from 'path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const USERS_DB_PATH = path.resolve(__dirname, '../../data/users.json')

function getSecret() {
  return process.env.JWT_SECRET || 'clawpm-dev-secret-change-in-production'
}

function readUsers() {
  if (!fs.existsSync(USERS_DB_PATH)) return { users: [] }
  return JSON.parse(fs.readFileSync(USERS_DB_PATH, 'utf-8'))
}

function writeUsers(data) {
  fs.writeFileSync(USERS_DB_PATH, JSON.stringify(data, null, 2))
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: '7d' })
}

export async function register(email, password) {
  const db = readUsers()
  if (db.users.find(u => u.email === email)) {
    throw new Error('此電子郵件已被註冊')
  }
  const hashed = await bcrypt.hash(password, 10)
  const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const name = email.split('@')[0]
  const user = { id: userId, email, name, password: hashed, createdAt: new Date().toISOString() }
  db.users.push(user)
  writeUsers(db)
  const token = signToken({ userId, email, name })
  return { userId, email, name, setupCompleted: false, token }
}

export async function login(email, password) {
  const db = readUsers()
  const user = db.users.find(u => u.email === email)
  if (!user) throw new Error('帳號或密碼錯誤')
  const valid = await bcrypt.compare(password, user.password)
  if (!valid) throw new Error('帳號或密碼錯誤')
  const name = user.name ?? email.split('@')[0]
  const token = signToken({ userId: user.id, email, name })
  return { userId: user.id, email, name, setupCompleted: user.setupCompleted ?? false, token }
}

export function verifyToken(token) {
  return jwt.verify(token, getSecret())
}

export function getUserById(userId) {
  const db = readUsers()
  const user = db.users.find(u => u.id === userId)
  if (!user) return null
  const { password: _, ...safe } = user
  return safe
}

export function completeSetup(userId, config) {
  const db = readUsers()
  const user = db.users.find(u => u.id === userId)
  if (!user) throw new Error('用戶不存在')
  user.setupCompleted = true
  user.setupCompletedAt = new Date().toISOString()
  user.setupConfig = {
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? null,
    model: config.model,
    workspaceFolder: config.workspaceFolder
  }
  writeUsers(db)
  return getUserById(userId)
}

export function resetSetup(userId) {
  const db = readUsers()
  const user = db.users.find(u => u.id === userId)
  if (!user) throw new Error('User not found')

  user.setupCompleted = false
  delete user.setupCompletedAt
  delete user.setupConfig

  writeUsers(db)
  return getUserById(userId)
}
