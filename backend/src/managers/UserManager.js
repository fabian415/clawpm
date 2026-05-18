import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query } from '../db.js'
import { createTeam, getTeam, completeTeamSetup } from './TeamManager.js'

function getSecret() {
  return process.env.JWT_SECRET || 'clawpm-dev-secret-change-in-production'
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: '7d' })
}

// Migrate legacy users (no team_id) to a default Team on startup
export async function migrateUsers() {
  const { rows: legacyUsers } = await query(
    `SELECT * FROM users WHERE team_id IS NULL`,
  )
  if (legacyUsers.length === 0) return

  for (const user of legacyUsers) {
    const teamName = (user.name || user.email.split('@')[0]) + ' 的團隊'
    const team = await createTeam(teamName)
    await query(
      `UPDATE users SET team_id = $1, role = 'admin' WHERE id = $2`,
      [team.id, user.id],
    )
  }

  console.log(`[UserManager] Migrated ${legacyUsers.length} legacy user(s) to teams.`)
}

export async function registerTeam(teamName, email, password) {
  const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.length > 0) throw new Error('此電子郵件已被註冊')

  const hashed = await bcrypt.hash(password, 10)
  const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const name = email.split('@')[0]

  const team = await createTeam(teamName)

  await query(
    `INSERT INTO users (id, email, name, password_hash, role, team_id, created_at)
     VALUES ($1, $2, $3, $4, 'admin', $5, NOW())`,
    [userId, email, name, hashed, team.id],
  )

  const token = signToken({ userId, email, name, role: 'admin', teamId: team.id })
  return { userId, email, name, role: 'admin', teamId: team.id, teamName: team.name, setupCompleted: false, token }
}

export async function login(email, password, teamId) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email])
  const user = rows[0]
  if (!user) throw new Error('帳號或密碼錯誤')

  if (teamId && user.team_id !== teamId) throw new Error('帳號或密碼錯誤')

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw new Error('帳號或密碼錯誤')

  const name = user.name ?? email.split('@')[0]
  const role = user.role ?? 'admin'
  const resolvedTeamId = user.team_id

  const team = resolvedTeamId ? await getTeam(resolvedTeamId) : null
  const setupCompleted = team?.setup_completed ?? false

  const token = signToken({ userId: user.id, email, name, role, teamId: resolvedTeamId })
  return { userId: user.id, email, name, role, teamId: resolvedTeamId, teamName: team?.name ?? null, setupCompleted, token }
}

export function verifyToken(token) {
  return jwt.verify(token, getSecret())
}

export async function getUserById(userId) {
  const { rows } = await query(
    'SELECT id, email, name, role, team_id, created_at FROM users WHERE id = $1',
    [userId],
  )
  return rows[0] ?? null
}

export async function createMember(adminId, email, password, name) {
  const admin = await getUserById(adminId)
  if (!admin) throw new Error('管理員不存在')
  if (admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.length > 0) throw new Error('此電子郵件已被註冊')

  const hashed = await bcrypt.hash(password, 10)
  const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const memberName = name || email.split('@')[0]

  const { rows } = await query(
    `INSERT INTO users (id, email, name, password_hash, role, team_id, created_at)
     VALUES ($1, $2, $3, $4, 'user', $5, NOW())
     RETURNING id, email, name, role, team_id, created_at`,
    [userId, email, memberName, hashed, admin.team_id],
  )
  return rows[0]
}

export async function setMemberRole(adminId, targetUserId, role) {
  if (!['admin', 'user'].includes(role)) throw new Error('無效的角色')

  const admin = await getUserById(adminId)
  if (!admin || admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  if (role === 'user' && targetUserId === adminId) throw new Error('無法降級自己的帳號')

  const { rows } = await query(
    `UPDATE users SET role = $1
     WHERE id = $2 AND team_id = $3
     RETURNING id, email, name, role, team_id, created_at`,
    [role, targetUserId, admin.team_id],
  )
  if (rows.length === 0) throw new Error('用戶不存在或不屬於此 Team')
  return rows[0]
}

export async function listMembers(adminId) {
  const admin = await getUserById(adminId)
  if (!admin) throw new Error('用戶不存在')
  if (admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  const { rows } = await query(
    'SELECT id, email, name, role, team_id, created_at FROM users WHERE team_id = $1 ORDER BY created_at',
    [admin.team_id],
  )
  return rows
}

export async function deleteMember(adminId, memberId) {
  if (adminId === memberId) throw new Error('無法刪除自己')

  const admin = await getUserById(adminId)
  if (!admin || admin.role !== 'admin') throw new Error('此操作需要 Admin 權限')

  const { rowCount } = await query(
    'DELETE FROM users WHERE id = $1 AND team_id = $2',
    [memberId, admin.team_id],
  )
  if (rowCount === 0) throw new Error('用戶不存在或不屬於此 Team')
}
