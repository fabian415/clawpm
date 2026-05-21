import { query } from '../db.js'

export async function createTeam(name) {
  const teamId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const workspaceFolder = `team-${teamId.split('_')[1]}`
  const { rows } = await query(
    `INSERT INTO teams (id, name, workspace_folder, created_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING *`,
    [teamId, name, workspaceFolder],
  )
  return rows[0]
}

export async function getTeam(teamId) {
  const { rows } = await query('SELECT * FROM teams WHERE id = $1', [teamId])
  return rows[0] ?? null
}

export async function listTeams() {
  const { rows } = await query('SELECT id, name FROM teams ORDER BY created_at')
  return rows
}

export async function completeTeamSetup(teamId, config) {
  const setupConfig = {
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? null,
    model: config.model,
    workspaceFolder: config.workspaceFolder,
  }
  const { rows } = await query(
    `UPDATE teams
     SET setup_completed = true,
         setup_completed_at = NOW(),
         setup_config = $2,
         workspace_folder = $3
     WHERE id = $1
     RETURNING *`,
    [teamId, setupConfig, config.workspaceFolder],
  )
  if (rows.length === 0) throw new Error('Team 不存在')
  return rows[0]
}

export async function resetTeamSetup(teamId) {
  const { rows } = await query(
    `UPDATE teams
     SET setup_completed = false,
         setup_completed_at = NULL,
         setup_config = NULL
     WHERE id = $1
     RETURNING *`,
    [teamId],
  )
  if (rows.length === 0) throw new Error('Team 不存在')
  return rows[0]
}

export async function getWorkspaceFolder(teamId) {
  const team = await getTeam(teamId)
  return team?.setup_config?.workspaceFolder || team?.workspace_folder || null
}

export async function deleteTeam(teamId) {
  await query('DELETE FROM teams WHERE id = $1', [teamId])
}
