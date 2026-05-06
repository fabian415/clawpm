#!/usr/bin/env node
/**
 * ClawPM M3 CLI Test Tool
 *
 * Usage:
 *   node cli-test.js <command> [args]
 *
 * Commands:
 *   provision <userId>   Initialize workspace + start container + pair device
 *   status    <userId>   Show container status
 *   start     <userId>   Start a stopped container
 *   stop      <userId>   Stop a running container
 *   restart   <userId>   Stop then start a container
 *   destroy   <userId>   Stop + remove container + release ports
 *   pair      <userId>   Run device pairing only (container must already be running)
 *   exec      <userId> <cmd...>  Run a command inside the container
 *   workspace <userId>   Show workspace paths
 *   ports                List all port allocations
 *   list                 List all ClawPM-managed containers
 *   image                Check if the OpenClaw image exists locally
 *   pull                 Pull the OpenClaw image from the registry
 *   config    <userId>   Show saved container config (deviceId, token, etc.)
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

// ── Resolve .env from same directory ────────────────────────────────────────
// (dotenv/config above loads .env from cwd; also try the backend dir)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

import { allocatePorts, releasePorts, listPorts, getPortsForUser } from './src/containers/PortManager.js'
import { initializeWorkspace, getUserPaths, workspaceExists } from './src/containers/WorkspaceManager.js'
import {
  createAndStartContainer,
  getContainerStatus,
  startContainer,
  stopContainer,
  destroyContainer,
  listManagedContainers,
  execInContainer,
  waitForHealthy,
  pullImage,
  imageExists,
} from './src/containers/ContainerManager.js'
import {
  pairDevice,
  saveContainerConfig,
  getContainerConfig,
  listContainerConfigs,
} from './src/containers/DevicePairer.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`) }
function warn(msg) { console.log(`${YELLOW}⚠${RESET} ${msg}`) }
function fail(msg) { console.error(`${RED}✗${RESET} ${msg}`) }
function info(msg) { console.log(`${CYAN}→${RESET} ${msg}`) }
function header(msg) { console.log(`\n${BOLD}${msg}${RESET}`) }

function askQuestion(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(prompt, answer => { rl.close(); resolve(answer.trim()) }))
}

async function promptLlmConfig() {
  console.log(`\n${BOLD}LLM Provider 設定${RESET}`)
  console.log(`  ${CYAN}1${RESET}  Gemini (Google)`)
  console.log(`  ${CYAN}2${RESET}  Custom Provider (OpenAI-compatible)`)

  let choice
  while (!choice) {
    const raw = await askQuestion('請選擇 (1/2): ')
    if (raw === '1' || raw === '2') choice = raw
    else warn('請輸入 1 或 2')
  }

  if (choice === '1') {
    let apiKey
    while (!apiKey) {
      apiKey = await askQuestion('請輸入 GEMINI_API_KEY: ')
      if (!apiKey) warn('GEMINI_API_KEY 不能為空')
    }
    return { provider: 'gemini', geminiApiKey: apiKey }
  }

  let baseUrl
  while (!baseUrl) {
    baseUrl = await askQuestion('請輸入 Base URL (e.g. https://xxx.cognitiveservices.azure.com/openai/v1): ')
    if (!baseUrl) warn('Base URL 不能為空')
  }
  let apiKey
  while (!apiKey) {
    apiKey = await askQuestion('請輸入 API Key: ')
    if (!apiKey) warn('API Key 不能為空')
  }
  let modelId
  while (!modelId) {
    modelId = await askQuestion('請輸入 Model ID (例如 gpt-4o): ')
    if (!modelId) warn('Model ID 不能為空')
  }
  return { provider: 'custom', baseUrl, apiKey, modelId }
}

function buildOpenClawConfigForProvider(gatewayToken, llmConfig, { hostPort } = {}) {
  const allowedOrigins = [
    'http://localhost:18789',
    'http://127.0.0.1:18789',
  ]
  if (hostPort && hostPort !== 18789) {
    allowedOrigins.push(`http://localhost:${hostPort}`)
    allowedOrigins.push(`http://127.0.0.1:${hostPort}`)
  }

  const gateway = {
    mode: 'local',
    auth: { mode: 'token', token: gatewayToken },
    port: 18789,
    bind: 'lan',
    tailscale: { mode: 'off', resetOnExit: false },
    controlUi: { allowInsecureAuth: true, allowedOrigins },
    nodes: {
      denyCommands: [
        'camera.snap', 'camera.clip', 'screen.record',
        'contacts.add', 'calendar.add', 'reminders.add',
        'sms.send', 'sms.search',
      ],
    },
  }

  if (llmConfig.provider === 'gemini') {
    return {
      agents: {
        defaults: {
          workspace: '/home/node/.openclaw/workspace',
          sandbox: { mode: 'off' },
          models: { 'google/gemini-2.5-flash': {} },
          model: { primary: 'google/gemini-2.5-flash' },
        },
      },
      gateway,
      session: { dmScope: 'per-channel-peer' },
      tools: { profile: 'coding' },
    }
  }

  const { baseUrl, apiKey, modelId } = llmConfig
  const modelRef = `custom/${modelId}`
  return {
    agents: {
      defaults: {
        workspace: '/home/node/.openclaw/workspace',
        model: { primary: modelRef },
        models: { [modelRef]: {} },
      },
    },
    models: {
      mode: 'merge',
      providers: {
        custom: {
          baseUrl,
          apiKey,
          api: 'openai-completions',
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    gateway,
    session: { dmScope: 'per-channel-peer' },
    tools: { profile: 'coding' },
  }
}

function applyEnvKey(envPath, key, value) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const line = `${key}=${value}`
  const regex = new RegExp(`^${key}=.*$`, 'm')
  content = regex.test(content) ? content.replace(regex, line) : content + `\n${line}`
  fs.writeFileSync(envPath, content, 'utf8')
}

function printStatus(status) {
  if (!status.exists) {
    fail(`Container does not exist: ${status.name}`)
    return
  }

  const runningLabel = status.running ? `${GREEN}running${RESET}` : `${RED}stopped${RESET}`
  const healthLabel = status.health
    ? (status.health === 'healthy' ? `${GREEN}healthy${RESET}` : `${YELLOW}${status.health}${RESET}`)
    : 'N/A'

  console.log(`  ID:          ${status.id}`)
  console.log(`  Name:        ${status.name}`)
  console.log(`  Image:       ${status.image}`)
  console.log(`  State:       ${runningLabel} (${status.status})`)
  console.log(`  Health:      ${healthLabel}`)
  console.log(`  Gateway:     localhost:${status.gatewayPort || '?'}`)
  console.log(`  Bridge:      localhost:${status.bridgePort || '?'}`)
  console.log(`  Started at:  ${status.startedAt}`)
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function cmdProvision(userId) {
  header(`Provisioning OpenClaw container for user: ${userId}`)

  // 0. Prompt for LLM provider
  const llmConfig = await promptLlmConfig()

  // 1. Allocate ports
  info('Allocating ports...')
  const ports = allocatePorts(userId)
  ok(`Ports allocated — gateway: ${ports.gatewayPort}, bridge: ${ports.bridgePort}`)

  // 2. Initialize workspace (pass hostPort so allowedOrigins is correct)
  info('Initializing workspace...')
  const { paths, gatewayToken, skillsCopied, warnings } = initializeWorkspace(userId, { hostPort: ports.gatewayPort })
  ok(`Workspace ready: ${paths.base}`)
  ok(`Gateway token:  ${gatewayToken.slice(0, 8)}...`)
  if (skillsCopied.length > 0) ok(`Skills copied: ${skillsCopied.join(', ')}`)
  for (const w of warnings) warn(w)

  // 3. Apply LLM config to openclaw.json (always overwrite at provision time)
  const openclawConfig = buildOpenClawConfigForProvider(gatewayToken, llmConfig, { hostPort: ports.gatewayPort })
  fs.writeFileSync(paths.openclawJson, JSON.stringify(openclawConfig, null, 2), 'utf8')
  if (llmConfig.provider === 'gemini') {
    ok('LLM provider: Gemini (google/gemini-2.5-flash)')
    applyEnvKey(path.join(paths.config, '.env'), 'GEMINI_API_KEY', llmConfig.geminiApiKey)
    ok('GEMINI_API_KEY written to config/.env')
  }
  else {
    ok(`LLM provider: Custom (custom/${llmConfig.modelId}) → ${llmConfig.baseUrl}`)
  }

  // 4. Check if container already exists
  const existing = await getContainerStatus(userId)
  if (existing.exists) {
    warn(`Container already exists (${existing.status}). Skipping create.`)
    if (!existing.running) {
      info('Starting existing container...')
      await startContainer(userId)
      ok('Container started.')
    }
  }
  else {
    // 5. Check image
    info(`Checking for image: ${process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'}`)
    const hasImage = await imageExists()
    if (!hasImage) {
      warn('Image not found locally. Pulling from registry (this may take a while)...')
      await pullImage((event) => {
        if (event.status && event.id) process.stdout.write(`\r  ${event.status}: ${event.id} ${event.progress || ''}     `)
        else if (event.status) process.stdout.write(`\r  ${event.status}     `)
      })
      process.stdout.write('\n')
      ok('Image pulled.')
    }
    else {
      ok('Image found locally.')
    }

    // 6. Create and start container
    info('Creating and starting container...')
    const containerId = await createAndStartContainer(userId, {
      gatewayPort: ports.gatewayPort,
      bridgePort: ports.bridgePort,
      workspaceDir: paths.workspace,
      configDir: paths.config,
      gatewayToken,
    })
    ok(`Container started: ${containerId}`)

    // Save basic config
    saveContainerConfig(userId, {
      containerId,
      gatewayPort: ports.gatewayPort,
      bridgePort: ports.bridgePort,
      gatewayToken,
      workspacePath: paths.workspace,
      provisionedAt: new Date().toISOString(),
    })
  }

  // 7. Device pairing (optional — skip on failure so provision still completes)
  info('Starting device pairing (waiting for healthy gateway)...')
  try {
    const { deviceId, operatorToken } = await pairDevice(userId, { healthTimeoutMs: 90_000 })
    ok(`Device paired — ID: ${deviceId}`)
    ok(`Operator token: ${operatorToken.slice(0, 8)}...`)
  }
  catch (error) {
    warn(`Device pairing failed (can retry with: node cli-test.js pair ${userId})`)
    warn(`  Reason: ${error.message}`)
  }

  header('Provision complete.')
  const finalStatus = await getContainerStatus(userId)
  printStatus(finalStatus)

  // Print connection info so the user knows how to access the dashboard
  const savedConfig = getContainerConfig(userId)
  const gPort = finalStatus.gatewayPort || savedConfig?.gatewayPort
  const gToken = savedConfig?.gatewayToken

  console.log(`\n${BOLD}─── 連線資訊 ───────────────────────────────────────${RESET}`)
  console.log(`  Dashboard URL : ${CYAN}http://localhost:${gPort}${RESET}`)
  console.log(`  WebSocket URL : ${CYAN}ws://localhost:${gPort}${RESET}`)
  console.log(`  Gateway Token : ${YELLOW}${gToken || '(未找到，執行 config 查看)'}${RESET}`)
  console.log(`${'─'.repeat(52)}`)
}

async function cmdStatus(userId) {
  header(`Container status for user: ${userId}`)
  const status = await getContainerStatus(userId)
  printStatus(status)

  const config = getContainerConfig(userId)
  if (config) {
    console.log(`\n  Device ID:   ${config.deviceId || 'not paired'}`)
    console.log(`  Token:       ${config.operatorToken ? config.operatorToken.slice(0, 8) + '...' : 'not paired'}`)
    console.log(`  Paired at:   ${config.pairedAt || 'N/A'}`)
  }
}

async function cmdStart(userId) {
  header(`Starting container for user: ${userId}`)
  const status = await getContainerStatus(userId)
  if (!status.exists) { fail('Container does not exist. Run: provision first.'); return }
  if (status.running) { warn('Container is already running.'); return }

  await startContainer(userId)
  ok('Container started.')
}

async function cmdStop(userId) {
  header(`Stopping container for user: ${userId}`)
  const status = await getContainerStatus(userId)
  if (!status.exists) { fail('Container does not exist.'); return }
  if (!status.running) { warn('Container is already stopped.'); return }

  await stopContainer(userId)
  ok('Container stopped.')
}

async function cmdRestart(userId) {
  header(`Restarting container for user: ${userId}`)
  const status = await getContainerStatus(userId)
  if (!status.exists) { fail('Container does not exist.'); return }

  if (status.running) {
    info('Stopping...')
    await stopContainer(userId)
    ok('Stopped.')
  }

  info('Starting...')
  await startContainer(userId)
  ok('Container restarted.')
}

async function cmdDestroy(userId) {
  header(`Destroying container for user: ${userId}`)
  const status = await getContainerStatus(userId)

  if (!status.exists) {
    warn('Container does not exist, cleaning up port allocation...')
  }
  else {
    info('Removing container...')
    await destroyContainer(userId)
    ok('Container removed.')
  }

  const released = releasePorts(userId)
  if (released) ok('Ports released.')

  console.log(`\n${YELLOW}Note: Workspace files NOT deleted. Remove manually if needed:${RESET}`)
  const paths = getUserPaths(userId)
  console.log(`  ${paths.base}`)
}

async function cmdPair(userId) {
  header(`Device pairing for user: ${userId}`)
  const { deviceId, operatorToken } = await pairDevice(userId)
  ok(`Device ID:      ${deviceId}`)
  ok(`Operator token: ${operatorToken}`)
}

async function cmdExec(userId, cmd) {
  if (cmd.length === 0) { fail('Provide a command, e.g.: exec testuser node dist/index.js --version'); return }
  header(`Exec in container for user: ${userId}`)
  info(`Command: ${cmd.join(' ')}`)
  const { stdout, stderr } = await execInContainer(userId, cmd)
  if (stdout) console.log(stdout)
  if (stderr) console.error(stderr)
}

async function cmdWorkspace(userId) {
  header(`Workspace paths for user: ${userId}`)
  const paths = getUserPaths(userId)
  const exists = workspaceExists(userId)

  console.log(`  Exists: ${exists ? `${GREEN}yes${RESET}` : `${RED}no${RESET}`}`)
  for (const [key, value] of Object.entries(paths)) {
    console.log(`  ${key.padEnd(20)} ${value}`)
  }
}

async function cmdPorts() {
  header('Port allocations')
  const allocs = listPorts()
  const entries = Object.entries(allocs)

  if (entries.length === 0) {
    info('No ports allocated.')
    return
  }

  console.log(`  ${'User ID'.padEnd(24)} ${'Gateway'.padEnd(10)} Bridge`)
  console.log(`  ${'-'.repeat(50)}`)
  for (const [userId, { gatewayPort, bridgePort }] of entries) {
    console.log(`  ${userId.padEnd(24)} ${String(gatewayPort).padEnd(10)} ${bridgePort}`)
  }
}

async function cmdList() {
  header('ClawPM-managed containers')
  const containers = await listManagedContainers()

  if (containers.length === 0) {
    info('No containers found.')
    return
  }

  console.log(`  ${'User ID'.padEnd(20)} ${'Container ID'.padEnd(14)} ${'Status'.padEnd(20)} Running`)
  console.log(`  ${'-'.repeat(70)}`)
  for (const c of containers) {
    const runLabel = c.running ? `${GREEN}yes${RESET}` : `${RED}no${RESET} `
    console.log(`  ${c.userId.padEnd(20)} ${c.containerId.padEnd(14)} ${c.status.padEnd(20)} ${runLabel}`)
  }
}

async function cmdImage() {
  header('OpenClaw image check')
  const image = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'
  info(`Image: ${image}`)
  const exists = await imageExists()
  if (exists) ok('Image exists locally.')
  else warn('Image NOT found locally. Run: node cli-test.js pull')
}

async function cmdPull() {
  header('Pulling OpenClaw image')
  const image = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'
  info(`Image: ${image}`)

  await pullImage((event) => {
    if (event.status && event.id) {
      process.stdout.write(`\r  ${event.status}: ${event.id} ${event.progress || ''}          `)
    }
    else if (event.status) {
      process.stdout.write(`\r  ${event.status}                                    `)
    }
  })
  process.stdout.write('\n')
  ok('Image pulled successfully.')
}

async function cmdConfig(userId) {
  header(`Container config for user: ${userId}`)
  const config = getContainerConfig(userId)

  if (!config) {
    info('No config found. Container may not have been provisioned.')
    return
  }

  for (const [key, value] of Object.entries(config)) {
    const display = key === 'operatorToken' && value
      ? value.slice(0, 12) + '...'
      : value
    console.log(`  ${key.padEnd(20)} ${display}`)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv

const COMMANDS = {
  provision: () => cmdProvision(args[0]),
  status:    () => cmdStatus(args[0]),
  start:     () => cmdStart(args[0]),
  stop:      () => cmdStop(args[0]),
  restart:   () => cmdRestart(args[0]),
  destroy:   () => cmdDestroy(args[0]),
  pair:      () => cmdPair(args[0]),
  exec:      () => cmdExec(args[0], args.slice(1)),
  workspace: () => cmdWorkspace(args[0]),
  ports:     () => cmdPorts(),
  list:      () => cmdList(),
  image:     () => cmdImage(),
  pull:      () => cmdPull(),
  config:    () => cmdConfig(args[0]),
}

if (!command || !COMMANDS[command]) {
  console.log(`
${BOLD}ClawPM M3 — OpenClaw Container Manager CLI${RESET}

Usage: node cli-test.js <command> [userId]

Commands:
  ${CYAN}provision${RESET} <userId>         Full setup: workspace + container + device pairing
  ${CYAN}status${RESET}    <userId>         Show container status
  ${CYAN}start${RESET}     <userId>         Start a stopped container
  ${CYAN}stop${RESET}      <userId>         Stop a running container
  ${CYAN}restart${RESET}   <userId>         Stop then start
  ${CYAN}destroy${RESET}   <userId>         Remove container + release ports
  ${CYAN}pair${RESET}      <userId>         Device pairing (container must be running)
  ${CYAN}exec${RESET}      <userId> <cmd>   Exec command inside container
  ${CYAN}workspace${RESET} <userId>         Show workspace paths
  ${CYAN}ports${RESET}                      List port allocations
  ${CYAN}list${RESET}                       List all ClawPM containers
  ${CYAN}image${RESET}                      Check if image exists locally
  ${CYAN}pull${RESET}                       Pull OpenClaw image
  ${CYAN}config${RESET}    <userId>         Show saved container config

Examples:
  node cli-test.js provision user001
  node cli-test.js status user001
  node cli-test.js exec user001 node dist/index.js --version
  node cli-test.js exec user001 node dist/index.js devices list
  node cli-test.js ports
  node cli-test.js list
  node cli-test.js destroy user001
`)
  process.exit(0)
}

const needsUserId = ['provision', 'status', 'start', 'stop', 'restart', 'destroy', 'pair', 'exec', 'workspace', 'config']
if (needsUserId.includes(command) && !args[0]) {
  fail(`Command '${command}' requires a userId argument.`)
  process.exit(1)
}

try {
  await COMMANDS[command]()
}
catch (error) {
  fail(error.message)
  if (process.env.DEBUG) console.error(error)
  process.exit(1)
}
