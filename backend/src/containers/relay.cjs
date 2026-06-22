'use strict'
const net = require('net')

const LISTEN_PORT = parseInt(process.env.CLAWPM_RELAY_PORT || '18791', 10)
const TARGET_PORT = parseInt(process.env.CLAWPM_RELAY_TARGET_PORT || '18789', 10)

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, '127.0.0.1')
  client.pipe(upstream)
  upstream.pipe(client)
  const cleanup = () => { client.destroy(); upstream.destroy() }
  client.on('error', cleanup)
  upstream.on('error', cleanup)
})

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[clawpm-relay] listening on :${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT}`)
})
