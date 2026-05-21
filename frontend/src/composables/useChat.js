import { ref, watch, onUnmounted } from 'vue'

export function useChat() {
  const isOpen = ref(false)
  const messages = ref([])
  const streamingMessages = ref([]) // in-flight messages, always rendered at bottom
  const unreadCount = ref(0)
  const isConnected = ref(false)
  const isLoading = ref(false)
  const sessionKey = ref(null)
  const sessions = ref([])
  const sessionsLoading = ref(false)

  let ws = null
  let reconnectTimer = null
  // Map from messageId → reactive message proxy (supports concurrent streams).
  const streamingMsgs = new Map()

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
      // Flush any cut-short streaming messages into the completed list.
      for (const m of streamingMessages.value) {
        m.isStreaming = false
        if (m.content || m.events?.length) messages.value.push({ ...m })
      }
      streamingMessages.value = []
      streamingMsgs.clear()
      isLoading.value = false
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

      case 'message_start': {
        isLoading.value = true
        const newMsg = {
          id: msg.messageId,
          role: 'assistant',
          content: '',
          events: [],
          timestamp: new Date().toISOString(),
          isStreaming: true,
        }
        streamingMessages.value.push(newMsg)
        // Keep reference to the reactive proxy so we can mutate it later.
        streamingMsgs.set(msg.messageId, streamingMessages.value[streamingMessages.value.length - 1])
        break
      }

      case 'chunk': {
        const target = msg.messageId
          ? streamingMsgs.get(msg.messageId)
          : streamingMsgs.size > 0 ? streamingMsgs.values().next().value : null
        if (target) target.content += msg.text
        break
      }

      case 'process_entries': {
        if (streamingMsgs.size > 0 && Array.isArray(msg.entries)) {
          const last = [...streamingMsgs.values()].at(-1)
          if (last) last.events = msg.entries
        }
        break
      }

      case 'message_complete': {
        const completing = msg.messageId
          ? streamingMsgs.get(msg.messageId)
          : streamingMsgs.size > 0 ? streamingMsgs.values().next().value : null

        if (completing) {
          if (!completing.content && msg.message?.content) {
            completing.content = msg.message.content
          }
          if (msg.message?.events?.length) completing.events = msg.message.events

          // Always remove from the streaming list first.
          const sIdx = streamingMessages.value.findIndex(m => m.id === completing.id)
          if (sIdx !== -1) streamingMessages.value.splice(sIdx, 1)

          if (completing.content || completing.events?.length) {
            // Settle the completed message into the history list.
            messages.value.push({
              id: completing.id,
              role: completing.role,
              content: completing.content,
              events: completing.events,
              timestamp: completing.timestamp,
              isStreaming: false,
            })
            if (!isOpen.value) unreadCount.value++
          }
          // If nothing to display, the bubble is simply dropped.

          streamingMsgs.delete(msg.messageId ?? completing.id)
        }

        if (streamingMsgs.size === 0) isLoading.value = false
        break
      }

      case 'error':
        isLoading.value = false
        streamingMessages.value = []
        streamingMsgs.clear()
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

  function replaceOptimistic(serverMsg) {
    const idx = messages.value.findLastIndex(m => m.role === 'user' && m._optimistic)
    if (idx !== -1) {
      messages.value[idx] = normalizeStoredMsg(serverMsg)
    }
  }

  function sendMessage(content) {
    const text = content?.trim()
    if (!text || !isConnected.value) return

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
    streamingMessages.value = []
    streamingMsgs.clear()
    unreadCount.value = 0
  }

  function setSession(sk) {
    if (ws?.readyState === WebSocket.OPEN && sk) {
      ws.send(JSON.stringify({ type: 'set_session', sessionKey: sk }))
      messages.value = []
      streamingMessages.value = []
      streamingMsgs.clear()
      unreadCount.value = 0
    }
  }

  async function fetchSessionHistory(sessionId) {
    try {
      const token = localStorage.getItem('clawpm_token')
      const res = await fetch(`/api/chat/sessions/${sessionId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      const data = await res.json()
      return (data.messages ?? []).map(m => ({ ...m, events: m.events ?? [], isStreaming: false }))
    } catch {
      return []
    }
  }

  async function switchSession(session) {
    const sk = session?.sessionKey ?? (typeof session === 'string' ? session : null)
    setSession(sk)
    if (session?.sessionId) {
      messages.value = await fetchSessionHistory(session.sessionId)
    }
  }

  async function fetchSessions() {
    sessionsLoading.value = true
    try {
      const token = localStorage.getItem('clawpm_token')
      const res = await fetch('/api/chat/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      sessions.value = data.sessions ?? []
    } catch {
      sessions.value = []
    } finally {
      sessionsLoading.value = false
    }
  }

  async function deleteSession(sessionId) {
    const token = localStorage.getItem('clawpm_token')
    const res = await fetch(`/api/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || '刪除失敗')
    }
    sessions.value = sessions.value.filter(s => s.sessionId !== sessionId)
    return true
  }

  async function deleteAllSessions() {
    const token = localStorage.getItem('clawpm_token')
    const res = await fetch('/api/chat/sessions', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || '刪除失敗')
    }
    sessions.value = []
    return true
  }

  async function fetchTrajectory(sessionId) {
    const token = localStorage.getItem('clawpm_token')
    const res = await fetch(`/api/chat/sessions/${sessionId}/trajectory`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { lines: [], exists: false }
    return await res.json()
  }

  async function fetchRaw(sessionId) {
    const token = localStorage.getItem('clawpm_token')
    const res = await fetch(`/api/chat/sessions/${sessionId}/raw`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { lines: [], exists: false }
    return await res.json()
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

  watch(unreadCount, (n) => {
    const base = document.title.replace(/^\(\d+\)\s*/, '')
    document.title = n > 0 ? `(${n}) ${base}` : base
  })

  return {
    isOpen, messages, streamingMessages, unreadCount, isConnected, isLoading, sessionKey,
    sessions, sessionsLoading,
    connect, disconnect, sendMessage, openPanel, closePanel, newSession, setSession, switchSession,
    fetchSessions, deleteSession, deleteAllSessions, fetchTrajectory, fetchRaw,
  }
}
