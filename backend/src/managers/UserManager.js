import fs from 'fs'
import path from 'path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { fileURLToPath } from 'url'
import { createTeam, getTeam, completeTeamSetup } from './TeamManager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.CLAWPM_DATA_DIR || path.resolve(__dirname, '../../data')
const USERS_DB_PATH = path.join(DATA_DIR, 'users.json')

function getSecret() {
  return process.env.JWT_SECRET || 'clawpm-dev-secret-change-in-production'
}

function readUsers() {
  if (!fs.existsSync(USERS_DB_PATH)) return { users: [] }
  return JSON.parse(fs.readFileSync(USERS_DB_PATH, 'utf-8'))
}

function writeUsers(data) {
  fs.mkdirSync(path.dirname(USERS_DB_PATH), { recursive: true })
  fs.writeFileSync(USERS_DB_PATH, JSON.stringify(data, null, 2))
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: '7d' })
}

// Migrate legacy users (no teamId/role) to a default Team on startup
export function migrateUsers() {
  const db = readUsers()
  const legacyUsers = db.users.filter(u => !u.teamId)
  if (legacyUsers.length === 0) return

  for (const user of legacyUsers) {
    const teamName = (user.name || user.email.split('@')[0]) + ' 的團隊'
    const team = createTeam(teamName)

    if (user.setupCompleted && user.setupConfig) {
      completeTeamSetup(team.id, user.setupConfig)
    }

    user.teamId = team.id
    user.role = 'admin'
  }

  writeUsers(db)
  console.log(`[UserManager] Migrated ${legacyUsers.length} legacy user(s) to teams.`)
}

export async function registerTeam(teamName, email, password) {
  const db = readUsers()
  if (db.users.find(u => u.email === email)) {
    throw new Error('此電子郵件已被註冊')
  }
  const hashed = await bcrypt.hash(password, 10)
  const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const name = email.split('@')[0]

  const team = createTeam(teamName)

  const user = {
    id: userId,
    email,
    name,
    password: hashed,
    role: 'admin',
    teamId: team.id,
    createdAt: new Date().toISOString()
  }
  db.users.push(user)
  writeUsers(db)

  const token = signToken({ userId, email, name, role: 'admin', teamId: team.id })
  return { userId, email, name, role: 'admin', teamId: team.id, setupCompleted: false, token }
}

export async function login(email, password, teamId) {
  const db = readUsers()
  let user = db.users.find(u => u.email === email)
  if (!user) throw new Error('帳號或密碼錯誤')

  if (teamId && user.teamId !== teamId) throw new Error('帳號或密碼錯誤')

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) throw new Error('帳號或密碼錯誤')

  const name = user.name ?? email.split('@')[0]
  const role = user.role ?? 'admin'
  const resolvedTeamId = user.teamId

  const team = resolvedTeamId ? getTeam(resolvedTeamId) : null
  const setupCompleted = team?.setupCompleted ?? user.setupCompleted ?? false

  const token = signToken({ userId: user.id, email, name, role, teamId: resolvedTeamId })
  return { userId: user.id, email, name, role, teamId: resolvedTeamId, setupCompleted, token }
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

export async function createMember(adminId, email, password, name) {
  const admin = getUserById(adminId)
  if (!admin) throw new Error('管理員不存在')
  if (admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  const db = readUsers()
  if (db.users.find(u => u.email === email)) {
    throw new Error('此電子郵件已被註冊')
  }

  const hashed = await bcrypt.hash(password, 10)
  const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const memberName = name || email.split('@')[0]

  const user = {
    id: userId,
    email,
    name: memberName,
    password: hashed,
    role: 'user',
    teamId: admin.teamId,
    createdAt: new Date().toISOString()
  }
  db.users.push(user)
  writeUsers(db)

  const { password: _, ...safe } = user
  return safe
}

export function setMemberRole(adminId, targetUserId, role) {
  if (!['admin', 'user'].includes(role)) throw new Error('無效的角色')

  const db = readUsers()
  const admin = db.users.find(u => u.id === adminId)
  if (!admin || admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  const target = db.users.find(u => u.id === targetUserId)
  if (!target) throw new Error('用戶不存在')
  if (target.teamId !== admin.teamId) throw new Error('無法管理其他 Team 的成員')

  if (role === 'user' && target.id === adminId) {
    throw new Error('無法降級自己的帳號')
  }

  target.role = role
  writeUsers(db)
  const { password: _, ...safe } = target
  return safe
}

export function listMembers(adminId) {
  const admin = getUserById(adminId)
  if (!admin) throw new Error('用戶不存在')
  if (admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  const db = readUsers()
  return db.users
    .filter(u => u.teamId === admin.teamId)
    .map(({ password: _, ...safe }) => safe)
}

export function deleteMember(adminId, memberId) {
  if (adminId === memberId) throw new Error('無法刪除自己')

  const db = readUsers()
  const admin = db.users.find(u => u.id === adminId)
  if (!admin || admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  const memberIdx = db.users.findIndex(u => u.id === memberId)
  if (memberIdx === -1) throw new Error('用戶不存在')
  if (db.users[memberIdx].teamId !== admin.teamId) throw new Error('無法管理其他 Team 的成員')

  db.users.splice(memberIdx, 1)
  writeUsers(db)
}
