import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEAMS_DB_PATH = path.resolve(__dirname, '../../data/teams.json')

function readTeams() {
  if (!fs.existsSync(TEAMS_DB_PATH)) return { teams: [] }
  return JSON.parse(fs.readFileSync(TEAMS_DB_PATH, 'utf-8'))
}

function writeTeams(data) {
  fs.mkdirSync(path.dirname(TEAMS_DB_PATH), { recursive: true })
  fs.writeFileSync(TEAMS_DB_PATH, JSON.stringify(data, null, 2))
}

export function createTeam(name) {
  const db = readTeams()
  const teamId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const workspaceFolder = `team-${teamId.split('_')[1]}`
  const team = {
    id: teamId,
    name,
    workspaceFolder,
    setupCompleted: false,
    setupConfig: null,
    createdAt: new Date().toISOString()
  }
  db.teams.push(team)
  writeTeams(db)
  return team
}

export function getTeam(teamId) {
  const db = readTeams()
  return db.teams.find(t => t.id === teamId) ?? null
}

export function listTeams() {
  const db = readTeams()
  return db.teams.map(({ id, name }) => ({ id, name }))
}

export function completeTeamSetup(teamId, config) {
  const db = readTeams()
  const team = db.teams.find(t => t.id === teamId)
  if (!team) throw new Error('Team 不存在')
  team.setupCompleted = true
  team.setupCompletedAt = new Date().toISOString()
  team.setupConfig = {
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? null,
    model: config.model,
    workspaceFolder: config.workspaceFolder
  }
  team.workspaceFolder = config.workspaceFolder
  writeTeams(db)
  return team
}

export function resetTeamSetup(teamId) {
  const db = readTeams()
  const team = db.teams.find(t => t.id === teamId)
  if (!team) throw new Error('Team 不存在')
  team.setupCompleted = false
  delete team.setupCompletedAt
  delete team.setupConfig
  writeTeams(db)
  return team
}

export function getWorkspaceFolder(teamId) {
  const team = getTeam(teamId)
  return team?.setupConfig?.workspaceFolder || team?.workspaceFolder || null
}
