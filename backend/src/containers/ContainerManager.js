import Docker from 'dockerode'

const getImage = () => process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:2026.4.22'

// Build dockerode client — supports Unix socket and Windows named pipe
function buildDockerClient() {
  const rawSocket = process.env.DOCKER_SOCKET_PATH?.trim()

  if (rawSocket) {
    // npipe:////./pipe/dockerDesktopLinuxEngine  →  //./pipe/dockerDesktopLinuxEngine
    const socketPath = rawSocket.startsWith('npipe://')
      ? rawSocket.slice('npipe://'.length)
      : rawSocket
    return new Docker({ socketPath })
  }

  // Dockerode auto-detects DOCKER_HOST env var and OS defaults
  return new Docker()
}

const docker = buildDockerClient()

export function getContainerName(userId) {
  return `clawpm-openclaw-${userId}`
}

/**
 * Create and start a per-user OpenClaw gateway container.
 *
 * @param {string} userId
 * @param {{ gatewayPort: number, bridgePort: number, workspaceDir: string, configDir: string, gatewayToken?: string }} options
 */
export async function createAndStartContainer(userId, { gatewayPort, bridgePort, workspaceDir, configDir, gatewayToken }) {
  const containerName = getContainerName(userId)

  const env = [
    `HOME=/home/node`,
    `TERM=xterm-256color`,
  ]
  if (gatewayToken) env.push(`OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`)

  const container = await docker.createContainer({
    name: containerName,
    Image: getImage(),
    Env: env,
    ExposedPorts: {
      '18789/tcp': {},
      '18790/tcp': {},
    },
    HostConfig: {
      PortBindings: {
        '18789/tcp': [{ HostPort: String(gatewayPort) }],
        '18790/tcp': [{ HostPort: String(bridgePort) }],
      },
      Binds: [
        `${configDir}:/home/node/.openclaw`,
        `${workspaceDir}:/home/node/.openclaw/workspace`,
      ],
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Cmd: ['node', 'dist/index.js', 'gateway', '--bind', 'lan', '--port', '18789'],
    Healthcheck: {
      Test: [
        'CMD',
        'node',
        '-e',
        "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      Interval: 15_000_000_000,  // 15s between checks
      Timeout: 5_000_000_000,
      Retries: 3,
      StartPeriod: 150_000_000_000,  // 150s grace — gateway takes ~100s to start
    },
  })

  await container.start()
  return container.id
}

/**
 * Get detailed status for a user's container.
 * Returns { exists: false } if the container does not exist.
 */
export async function getContainerStatus(userId) {
  const containerName = getContainerName(userId)

  try {
    const container = docker.getContainer(containerName)
    const info = await container.inspect()

    const portBindings = info.HostConfig?.PortBindings || {}
    const gatewayPort = portBindings['18789/tcp']?.[0]?.HostPort
    const bridgePort = portBindings['18790/tcp']?.[0]?.HostPort

    return {
      exists: true,
      id: info.Id.slice(0, 12),
      name: containerName,
      image: info.Config.Image,
      status: info.State.Status,        // running, exited, paused, etc.
      running: info.State.Running,
      health: info.State.Health?.Status || null,  // healthy, unhealthy, starting
      startedAt: info.State.StartedAt,
      gatewayPort: gatewayPort ? parseInt(gatewayPort) : null,
      bridgePort: bridgePort ? parseInt(bridgePort) : null,
    }
  }
  catch (error) {
    if (error.statusCode === 404) return { exists: false, name: containerName }
    throw error
  }
}

/** Start an existing (stopped) container. */
export async function startContainer(userId) {
  const container = docker.getContainer(getContainerName(userId))
  await container.start()
}

/** Stop a running container (SIGTERM + 10s grace). */
export async function stopContainer(userId) {
  const container = docker.getContainer(getContainerName(userId))
  await container.stop({ t: 10 })
}

/** Stop and remove the container. Ignores stop errors (container may already be stopped). */
export async function destroyContainer(userId) {
  const containerName = getContainerName(userId)
  const container = docker.getContainer(containerName)

  try { await container.stop({ t: 5 }) } catch {}
  await container.remove()
}

/**
 * List all ClawPM-managed containers (name starts with `clawpm-openclaw-`).
 * Returns array of { userId, containerId, status, running }.
 */
export async function listManagedContainers() {
  const containers = await docker.listContainers({ all: true })
  const prefix = 'clawpm-openclaw-'

  return containers
    .filter(c => c.Names.some(n => n.replace(/^\//, '').startsWith(prefix)))
    .map((c) => {
      const name = c.Names[0].replace(/^\//, '')
      const userId = name.slice(prefix.length)
      return {
        userId,
        containerId: c.Id.slice(0, 12),
        name,
        image: c.Image,
        status: c.Status,
        running: c.State === 'running',
      }
    })
}

/**
 * Execute a command inside a running container.
 * Returns stdout as a string.
 */
export async function execInContainer(userId, cmd) {
  const container = docker.getContainer(getContainerName(userId))

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  })

  return new Promise((resolve, reject) => {
    exec.start({}, (error, stream) => {
      if (error) return reject(error)

      let stdout = ''
      let stderr = ''

      // Docker multiplexed stream: 8-byte header (stream type + length) before each chunk
      stream.on('data', (chunk) => {
        if (chunk.length < 8) return
        const streamType = chunk[0]  // 1 = stdout, 2 = stderr
        const payload = chunk.slice(8).toString('utf8')
        if (streamType === 1) stdout += payload
        else stderr += payload
      })

      stream.on('end', () => resolve({ stdout: stdout.trim(), stderr: stderr.trim() }))
      stream.on('error', reject)
    })
  })
}

/**
 * Wait until the container's healthcheck status becomes 'healthy'.
 * Polls every 3 seconds; throws if not healthy within timeoutMs.
 */
export async function waitForHealthy(userId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const status = await getContainerStatus(userId)

    if (!status.exists) throw new Error(`Container for user ${userId} does not exist`)
    if (!status.running) throw new Error(`Container for user ${userId} stopped unexpectedly`)
    if (status.health === 'healthy') return status

    await new Promise(resolve => setTimeout(resolve, 3000))
  }

  throw new Error(`Container for user ${userId} did not become healthy within ${timeoutMs / 1000}s`)
}

/** Pull the OpenClaw image from the registry, streaming progress to a callback. */
export async function pullImage(onProgress) {
  return new Promise((resolve, reject) => {
    docker.pull(getImage(), (error, stream) => {
      if (error) return reject(error)

      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err)
        resolve(output)
      }, (event) => {
        if (onProgress && event.status) onProgress(event)
      })
    })
  })
}

/** Check whether the OpenClaw image exists locally. */
export async function imageExists() {
  try {
    await docker.getImage(getImage()).inspect()
    return true
  }
  catch {
    return false
  }
}
