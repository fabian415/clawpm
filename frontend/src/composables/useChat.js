import { ref, watch, onUnmounted } from 'vue'

export function useChat() {
  const isOpen = ref(false)
  const messages = ref([])
  const unreadCount = ref(0)
  const isConnected = ref(false)
  const isLoading = ref(false)
  const sessionKey = ref(null)

  let ws = null
  let reconnectTimer = null
  let streamingMsg = null  // reactive ref inside messages array

  function buildWsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/ws/chat`
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
    const token = localStorage.getItem('clawpm_token')
    if (!token) return

    ws = new WebSocket(buildWsUrl())

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }))
    }

    ws.onmessage = (evt) => {
      try { handleEvent(JSON.parse(evt.data)) } catch {}
    }

    ws.onclose = () => {
      isConnected.value = false
      streamingMsg = null
      scheduleReconnect()
    }

    ws.onerror = () => {
      isConnected.value = false
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 3000)
  }

  function handleEvent(msg) {
    switch (msg.type) {
      case 'auth_ok':
        isConnected.value = true
        sessionKey.value = msg.sessionKey
        messages.value = (msg.history ?? []).map(normalizeStoredMsg)
        break

      case 'auth_error':
        isConnected.value = false
        break

      case 'user_message':
        // Server echoes back the stored user message with its id; update the
        // optimistically-added message in place so we have the real id.
        replaceOptimistic(msg.message)
        break

      case 'message_start':
        isLoading.value = true
        messages.value.push({
          id: msg.messageId,
          role: 'assistant',
          content: '',
          events: [],
          timestamp: new Date().toISOString(),
          isStreaming: true,
        })
        // Keep reference to the reactive proxy (not the plain object we just pushed)
        streamingMsg = messages.value[messages.value.length - 1]
        break

      case 'chunk':
        if (streamingMsg) streamingMsg.content += msg.text
        break

      case 'process_entries':
        if (streamingMsg && Array.isArray(msg.entries)) {
          streamingMsg.events = msg.entries
        }
        break

      case 'message_complete': {
        isLoading.value = false
        if (streamingMsg) {
          streamingMsg.isStreaming = false
          // Use authoritative content from server if stream was empty
          if (!streamingMsg.content && msg.message?.content) {
            streamingMsg.content = msg.message.content
          }
          if (msg.message?.events?.length) streamingMsg.events = msg.message.events
        }
        streamingMsg = null

        if (!isOpen.value) {
          unreadCount.value++
        }
        break
      }

      case 'error':
        isLoading.value = false
        streamingMsg = null
        messages.value.push({
          id: Date.now().toString(),
          role: 'system',
          content: `錯誤：${msg.message}`,
          timestamp: new Date().toISOString(),
          events: [],
          isError: true,
        })
        break

      case 'session_changed':
        sessionKey.value = msg.sessionKey
        break
    }
  }

  function normalizeStoredMsg(m) {
    return {
      ...m,
      events: m.events ?? [],
      isStreaming: false,
    }
  }

  // Replace the optimistic placeholder (no real id yet) with the server-assigned message
  function replaceOptimistic(serverMsg) {
    const idx = messages.value.findLastIndex(m => m.role === 'user' && m._optimistic)
    if (idx !== -1) {
      messages.value[idx] = normalizeStoredMsg(serverMsg)
    }
  }

  function sendMessage(content) {
    const text = content?.trim()
    if (!text || !isConnected.value || isLoading.value) return

    messages.value.push({
      id: `opt-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      events: [],
      _optimistic: true,
    })

    ws.send(JSON.stringify({ type: 'message', content: text }))
  }

  function openPanel() {
    isOpen.value = true
    unreadCount.value = 0
  }

  function closePanel() {
    isOpen.value = false
  }

  function newSession() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'new_session' }))
    }
    messages.value = []
    unreadCount.value = 0
  }

  function disconnect() {
    clearTimeout(reconnectTimer)
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
    isConnected.value = false
  }

  onUnmounted(disconnect)

  // Update <title> badge when unread count changes
  watch(unreadCount, (n) => {
    const base = document.title.replace(/^\(\d+\)\s*/, '')
    document.title = n > 0 ? `(${n}) ${base}` : base
  })

  return {
    isOpen, messages, unreadCount, isConnected, isLoading, sessionKey,
    connect, disconnect, sendMessage, openPanel, closePanel, newSession,
  }
}
