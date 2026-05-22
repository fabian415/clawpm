<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 dark:text-white">會話紀錄</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">點選 session 即時追蹤 JSONL 輸出</p>
      </div>
      <div class="flex gap-2">
        <button
          @click="refreshSessions"
          :disabled="sessionsLoading"
          class="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
        >
          <RefreshCw class="w-4 h-4" :class="sessionsLoading ? 'animate-spin' : ''" />
          重新整理
        </button>
        <button
          v-if="sessions.length > 0"
          @click="confirmDeleteAll = true"
          class="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
        >
          <Trash2 class="w-4 h-4" />
          全部刪除
        </button>
      </div>
    </div>

    <!-- Main 3-pane layout -->
    <div class="flex-1 flex gap-3 min-h-0 overflow-hidden">

      <!-- Left: Session list (collapsible) -->
      <div
        class="shrink-0 flex flex-col bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden transition-all duration-300"
        :class="listCollapsed ? 'w-9' : 'w-60'"
      >
        <!-- Header row with collapse toggle -->
        <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 shrink-0" :class="listCollapsed ? 'px-1.5 py-2.5' : 'px-3 py-2.5'">
          <span v-if="!listCollapsed" class="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            {{ sessions.length }} Sessions
          </span>
          <button
            @click="listCollapsed = !listCollapsed"
            class="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            :title="listCollapsed ? '展開列表' : '收折列表'"
          >
            <PanelLeftClose v-if="!listCollapsed" class="w-3.5 h-3.5" />
            <PanelLeftOpen v-else class="w-3.5 h-3.5" />
          </button>
        </div>

        <!-- Session items (hidden when collapsed) -->
        <div v-show="!listCollapsed" class="flex-1 overflow-y-auto">
          <div v-if="sessionsLoading && sessions.length === 0" class="flex justify-center py-8 text-slate-400">
            <Loader2 class="w-4 h-4 animate-spin" />
          </div>
          <div v-else-if="sessions.length === 0" class="px-3 py-6 text-center text-xs text-slate-400">
            尚無 session
          </div>
          <div
            v-for="s in sessions"
            :key="s.sessionId"
            @click="selectSession(s)"
            class="group flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-slate-50 dark:border-slate-800/50 last:border-0 transition-colors"
            :class="selectedSession?.sessionId === s.sessionId
              ? 'bg-blue-50 dark:bg-blue-900/20'
              : 'hover:bg-slate-50 dark:hover:bg-slate-800/30'"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <div class="text-xs font-semibold truncate" :class="selectedSession?.sessionId === s.sessionId ? 'text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-200'">
                  {{ s.sessionKey ? shortKey(s.sessionKey) : s.sessionId.slice(0,8)+'…' }}
                </div>
                <span
                  v-if="s.sessionKey && s.sessionKey === props.currentSessionKey"
                  class="shrink-0 w-1.5 h-1.5 rounded-full bg-green-400"
                  title="目前聊天中的 session"
                />
              </div>
              <div class="text-[10px] text-slate-400 mt-0.5 flex gap-1.5">
                <span>{{ formatDate(s.lastModified) }}</span>
                <span>·</span>
                <span>{{ formatSize(s.size) }}</span>
              </div>
            </div>
            <button
              @click.stop="deleteOne(s.sessionId)"
              class="shrink-0 p-1 rounded text-slate-300 dark:text-slate-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all mt-0.5"
              title="刪除"
            >
              <Trash2 class="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      <!-- Right: Two tail panels -->
      <div class="flex-1 flex flex-col gap-3 min-w-0 overflow-hidden">

        <!-- Empty state -->
        <div v-if="!selectedSession" class="flex-1 flex items-center justify-center rounded-xl border border-dashed border-slate-200 dark:border-slate-700 text-slate-400 text-sm">
          {{ listCollapsed ? '← 展開左側列表選擇 session' : '← 點選左側 session 開始追蹤' }}
        </div>

        <template v-else>
          <!-- Panel: .jsonl -->
          <TailPane
            :title="`${selectedSession.sessionId.slice(0,8)}.jsonl`"
            :lines="jsonlLines"
            :loading="jsonlLoading"
            :auto-scroll="jsonlAutoScroll"
            :has-new="jsonlHasNew"
            @scroll-toggle="jsonlAutoScroll = $event"
            @scroll-to-bottom="scrollPaneToBottom('jsonl')"
            ref="jsonlPane"
            class="flex-1 min-h-0"
          />

          <!-- Panel: .trajectory.jsonl -->
          <TailPane
            :title="`${selectedSession.sessionId.slice(0,8)}.trajectory.jsonl`"
            :lines="trajectoryLines"
            :loading="trajectoryLoading"
            :auto-scroll="trajectoryAutoScroll"
            :has-new="trajectoryHasNew"
            @scroll-toggle="trajectoryAutoScroll = $event"
            @scroll-to-bottom="scrollPaneToBottom('trajectory')"
            ref="trajectoryPane"
            class="flex-1 min-h-0"
          />
        </template>
      </div>
    </div>
  </div>

  <!-- Confirm delete all -->
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="confirmDeleteAll" class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" @click.self="confirmDeleteAll = false">
        <div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-sm p-6">
          <div class="w-12 h-12 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4 mx-auto">
            <Trash2 class="w-6 h-6 text-red-500" />
          </div>
          <h3 class="text-lg font-bold text-center text-slate-800 dark:text-slate-200 mb-2">確認全部刪除？</h3>
          <p class="text-sm text-center text-slate-500 dark:text-slate-400 mb-6">
            將刪除所有 {{ sessions.length }} 個 session，此操作無法復原。
          </p>
          <div class="flex gap-3">
            <button @click="confirmDeleteAll = false" class="flex-1 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-sm font-medium">取消</button>
            <button @click="doDeleteAll" :disabled="deleting" class="flex-1 px-4 py-2 rounded-xl bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 text-sm font-medium">{{ deleting ? '刪除中…' : '確認刪除' }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, onUnmounted, onMounted, nextTick, defineComponent, h } from 'vue'
import { RefreshCw, Trash2, Loader2, ArrowDown, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'

// ── TailPane inline component ──────────────────────────────────────────────────

const TailPane = defineComponent({
  name: 'TailPane',
  props: {
    title: String,
    lines: { type: Array, default: () => [] },
    loading: Boolean,
    autoScroll: Boolean,
    hasNew: Boolean,
  },
  emits: ['scroll-toggle', 'scroll-to-bottom'],
  setup(props, { emit, expose }) {
    const el = ref(null)
    let userScrolled = false

    function onScroll() {
      if (!el.value) return
      const { scrollTop, scrollHeight, clientHeight } = el.value
      const atBottom = scrollHeight - scrollTop - clientHeight < 60
      if (atBottom && userScrolled) {
        userScrolled = false
        emit('scroll-toggle', true)
      } else if (!atBottom && !userScrolled) {
        userScrolled = true
        emit('scroll-toggle', false)
      }
    }

    function scrollToBottom() {
      nextTick(() => {
        if (el.value) el.value.scrollTop = el.value.scrollHeight
      })
    }

    expose({ scrollToBottom })

    watch(() => props.lines.length, () => {
      if (props.autoScroll) scrollToBottom()
    })

    watch(() => props.autoScroll, (v) => {
      if (v) scrollToBottom()
    })

    function lineColor(line) {
      if (line.raw) return '#94a3b8'
      const role = line.role || line.message?.role || ''
      const type = line.type || line.event || ''
      if (/error|fail/i.test(type) || line.isError) return '#f87171'
      if (role === 'user') return '#60a5fa'
      if (role === 'assistant') return '#34d399'
      if (/tool|function/i.test(role) || /tool/i.test(type)) return '#fbbf24'
      if (/session|trace|metadata/i.test(type)) return '#a78bfa'
      return '#cbd5e1'
    }

    function formatLine(line) {
      if (line.raw) return line.raw
      try {
        const s = JSON.stringify(line)
        return s.length > 500 ? s.slice(0, 500) + ' …' : s
      } catch { return String(line) }
    }

    function lineLabel(line) {
      if (line.raw) return null
      return line.type || line.event || line.role || line.message?.role || null
    }

    function labelColor(line) {
      const c = lineColor(line)
      return c
    }

    return () => h('div', { class: 'flex flex-col overflow-hidden bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs h-full' }, [
      // Header
      h('div', { class: 'flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0 bg-slate-900 rounded-t-xl' }, [
        h('div', { class: 'flex items-center gap-2' }, [
          h('span', { class: 'w-2 h-2 rounded-full bg-green-400 animate-pulse' }),
          h('span', { class: 'text-slate-300 font-semibold tracking-tight' }, props.title),
          props.loading && h('span', { class: 'text-slate-500 ml-1' }, '載入中…'),
        ]),
        h('div', { class: 'flex items-center gap-2' }, [
          h('span', { class: 'text-slate-500' }, `${props.lines.length} 行`),
          !props.autoScroll && props.hasNew && h('button', {
            onClick: () => emit('scroll-to-bottom'),
            class: 'flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600 text-white text-[10px] hover:bg-blue-500 transition-colors'
          }, [
            h(ArrowDown, { class: 'w-3 h-3' }),
            '新內容'
          ]),
        ]),
      ]),
      // Content
      h('div', {
        ref: el,
        onScroll,
        class: 'flex-1 overflow-y-auto px-0 py-1 min-h-0',
        style: 'scrollbar-width: thin; scrollbar-color: #334155 transparent;'
      },
        props.lines.length === 0 && !props.loading
          ? [h('div', { class: 'flex items-center justify-center h-full text-slate-600 text-xs' }, '無資料')]
          : props.lines.map((line, idx) => {
              const label = lineLabel(line)
              const color = lineColor(line)
              return h('div', {
                key: idx,
                class: 'flex gap-2 px-3 py-0.5 hover:bg-slate-900/50 transition-colors leading-5',
              }, [
                h('span', { class: 'text-slate-600 select-none w-8 shrink-0 text-right' }, idx + 1),
                label && h('span', {
                  class: 'shrink-0 px-1 rounded text-[9px] font-bold uppercase tracking-wide self-start mt-0.5',
                  style: `color: ${color}; background: ${color}22`
                }, label),
                h('span', {
                  class: 'break-all whitespace-pre-wrap',
                  style: `color: ${color}`
                }, formatLine(line)),
              ])
            })
      ),
    ])
  }
})

// ── SessionsView logic ─────────────────────────────────────────────────────────

const props = defineProps({
  fetchSessions: { type: Function, required: true },
  deleteSession: { type: Function, required: true },
  deleteAllSessions: { type: Function, required: true },
  fetchTrajectory: { type: Function, required: true },
  fetchRaw: { type: Function, required: true },
  sessions: { type: Array, default: () => [] },
  sessionsLoading: { type: Boolean, default: false },
  currentSessionKey: { type: String, default: null },
})

const emit = defineEmits(['toast', 'select-session'])

const confirmDeleteAll = ref(false)
const deleting = ref(false)
const listCollapsed = ref(false)

const selectedSession = ref(null)

const jsonlLines = ref([])
const jsonlLoading = ref(false)
const jsonlAutoScroll = ref(true)
const jsonlHasNew = ref(false)
const jsonlPane = ref(null)

const trajectoryLines = ref([])
const trajectoryLoading = ref(false)
const trajectoryAutoScroll = ref(true)
const trajectoryHasNew = ref(false)
const trajectoryPane = ref(null)

let pollTimer = null

async function refreshSessions() {
  await props.fetchSessions()
}

async function selectSession(s) {
  selectedSession.value = s
  jsonlLines.value = []
  trajectoryLines.value = []
  jsonlAutoScroll.value = true
  trajectoryAutoScroll.value = true
  jsonlHasNew.value = false
  trajectoryHasNew.value = false
  clearInterval(pollTimer)
  await pollBoth()
  pollTimer = setInterval(pollBoth, 2000)
  // 通知 App.vue 切換聊天 session
  emit('select-session', s)
}

async function pollBoth() {
  if (!selectedSession.value) return
  const id = selectedSession.value.sessionId

  const [rawResult, trajResult] = await Promise.all([
    props.fetchRaw(id).catch(() => ({ lines: [], exists: false })),
    props.fetchTrajectory(id).catch(() => ({ lines: [], exists: false })),
  ])

  if (rawResult.lines.length !== jsonlLines.value.length) {
    if (!jsonlAutoScroll.value && rawResult.lines.length > jsonlLines.value.length) {
      jsonlHasNew.value = true
    }
    jsonlLines.value = rawResult.lines
  }

  if (trajResult.lines.length !== trajectoryLines.value.length) {
    if (!trajectoryAutoScroll.value && trajResult.lines.length > trajectoryLines.value.length) {
      trajectoryHasNew.value = true
    }
    trajectoryLines.value = trajResult.lines
  }
}

function scrollPaneToBottom(which) {
  if (which === 'jsonl') {
    jsonlAutoScroll.value = true
    jsonlHasNew.value = false
    jsonlPane.value?.scrollToBottom()
  } else {
    trajectoryAutoScroll.value = true
    trajectoryHasNew.value = false
    trajectoryPane.value?.scrollToBottom()
  }
}

async function deleteOne(sessionId) {
  try {
    await props.deleteSession(sessionId)
    emit('toast', 'Session 已刪除', 'success')
    if (selectedSession.value?.sessionId === sessionId) {
      selectedSession.value = null
      clearInterval(pollTimer)
    }
  } catch (err) {
    emit('toast', err.message || '刪除失敗', 'error')
  }
}

async function doDeleteAll() {
  deleting.value = true
  try {
    await props.deleteAllSessions()
    emit('toast', '所有 session 已刪除', 'success')
    confirmDeleteAll.value = false
    selectedSession.value = null
    clearInterval(pollTimer)
  } catch (err) {
    emit('toast', err.message || '刪除失敗', 'error')
  } finally {
    deleting.value = false
  }
}

function shortKey(key) {
  const parts = key.split(':')
  if (parts.length >= 3) return parts.slice(2).join(':').slice(0, 36)
  return key.slice(0, 36)
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

onMounted(refreshSessions)

onUnmounted(() => clearInterval(pollTimer))
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
