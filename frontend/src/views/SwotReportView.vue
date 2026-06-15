<template>
  <div class="h-full flex -m-8 overflow-hidden">

    <!-- Left Sidebar: report list -->
    <div
      :class="sidebarOpen ? 'w-64' : 'w-0'"
      class="shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 transition-all duration-200 overflow-hidden"
    >
      <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 shrink-0 gap-2">
        <span class="text-sm font-bold text-slate-700 dark:text-slate-300 truncate">{{ projectName || projectSlug }}</span>
        <div class="flex items-center gap-1 shrink-0">
          <button
            @click="startAnalysis"
            :disabled="isAnalyzing"
            :class="isAnalyzing ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-700'"
            class="bg-emerald-600 text-white px-2 py-1 rounded text-xs font-bold flex items-center gap-1 transition-colors"
            title="執行新一輪 SWOT 分析"
          >
            <BarChart2 v-if="!isAnalyzing" class="w-3 h-3" />
            <Loader2 v-else class="w-3 h-3 animate-spin" />
            新分析
          </button>
          <button @click="fetchReports" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600" title="重新整理">
            <RefreshCw :class="isLoadingList ? 'animate-spin' : ''" class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto py-2">
        <div v-if="isLoadingList" class="flex items-center justify-center py-12 text-slate-400">
          <Loader2 class="w-5 h-5 animate-spin" />
        </div>
        <div v-else-if="reports.length === 0" class="px-4 py-6 text-center text-xs text-slate-400">
          尚無 SWOT 報告<br>
          <span class="text-slate-300">點擊「新 SWOT 分析」開始</span>
        </div>
        <button
          v-for="r in reports"
          :key="r.name"
          @click="loadReport(r.name)"
          :class="currentName === r.name
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-l-2 border-blue-500'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-l-2 border-transparent'"
          class="w-full text-left px-4 py-2.5 transition-colors"
        >
          <div class="text-sm font-medium">SWOT 分析</div>
          <div class="text-[10px] text-slate-400 mt-0.5 font-mono">{{ r.displayDate }}</div>
        </button>
      </div>
    </div>

    <!-- Main area -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">

      <!-- Toolbar -->
      <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 bg-slate-50 dark:bg-slate-900 shrink-0">
        <div class="flex items-center gap-1">
          <button @click="sidebarOpen = !sidebarOpen" :class="sidebarOpen ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all" title="切換報告清單">
            <PanelLeft class="w-4 h-4" />
          </button>
          <template v-if="currentName">
            <div class="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1"></div>
            <button @click="mode = 'split'" :class="mode === 'split' ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all" title="分割檢視">
              <Columns2 class="w-4 h-4" />
            </button>
            <button @click="mode = 'edit'" :class="mode === 'edit' ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all" title="編輯模式">
              <PenTool class="w-4 h-4" />
            </button>
            <button @click="mode = 'preview'" :class="mode === 'preview' ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all" title="預覽模式">
              <Eye class="w-4 h-4" />
            </button>
          </template>
        </div>

        <!-- Title -->
        <div class="flex-1 flex justify-center">
          <span v-if="isAnalyzing" class="flex items-center gap-2 text-sm font-medium text-amber-500">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            AI 分析中，請稍候...
          </span>
          <span v-else-if="currentName" class="text-sm font-medium text-slate-500 truncate px-4">{{ currentName }}.md</span>
          <span v-else class="text-sm text-slate-400">← 從左側選擇報告</span>
        </div>

        <div class="flex items-center gap-2">
          <template v-if="currentName">
            <div class="flex items-center gap-1.5 text-xs">
              <span v-if="saveSuccess" class="flex items-center gap-1 text-green-500">
                <Check class="w-3 h-3" /> 已儲存
              </span>
              <span v-else-if="isDirty" class="text-amber-500">未儲存</span>
              <span v-else class="flex items-center gap-1 text-slate-400">
                <span class="w-2 h-2 rounded-full bg-green-400"></span> 已同步
              </span>
            </div>
            <div class="flex gap-1">
              <button
                @click="saveFile"
                :disabled="!isDirty || isSaving"
                :class="!isDirty ? 'opacity-40 cursor-not-allowed' : 'hover:bg-blue-700'"
                class="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 transition-colors"
              >
                <Loader2 v-if="isSaving" class="w-3.5 h-3.5 animate-spin" />
                <Save v-else class="w-3.5 h-3.5" />
                儲存
              </button>
              <button @click="exportFile" class="bg-slate-200 dark:bg-slate-800 px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors">
                <Download class="w-3.5 h-3.5" /> 匯出
              </button>
              <button @click="confirmDelete" class="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 transition-colors">
                <Trash2 class="w-3.5 h-3.5" /> 刪除
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- Content area -->
      <div class="flex-1 flex overflow-hidden">

        <!-- Analyzing progress -->
        <div v-if="isAnalyzing && !currentName" class="flex-1 flex flex-col items-center justify-center gap-5">
          <div class="flex flex-col items-center gap-3">
            <div class="w-16 h-16 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
              <BarChart2 class="w-8 h-8 text-emerald-500 animate-pulse" />
            </div>
            <p class="text-base font-semibold text-slate-700 dark:text-slate-300">正在進行 SWOT 分析</p>
            <p class="text-sm text-slate-400 max-w-xs text-center">
              AI 正透過網路蒐集外部資料，執行完整 SWOT、競品與產業趨勢分析，通常需要 1–3 分鐘
            </p>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>分析完成後將自動載入報告</span>
          </div>
        </div>

        <!-- Empty state -->
        <div v-else-if="!currentName" class="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
          <BarChart2 class="w-12 h-12 opacity-20" />
          <p class="text-sm">從左側選擇一份 SWOT 報告，或點擊「新 SWOT 分析」</p>
        </div>

        <!-- Loading file -->
        <div v-else-if="isLoadingFile" class="flex-1 flex items-center justify-center text-slate-400">
          <Loader2 class="w-6 h-6 animate-spin" />
        </div>

        <!-- Editor panes -->
        <template v-else>
          <div v-if="mode !== 'preview'" class="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">
            <textarea
              v-model="fileContent"
              spellcheck="false"
              class="flex-1 w-full bg-[#1e1e1e] text-slate-200 p-6 font-mono text-sm resize-none outline-none leading-relaxed overflow-y-auto"
              placeholder="SWOT 分析報告..."
            ></textarea>
          </div>
          <div v-if="mode !== 'edit'" class="flex-1 overflow-y-auto bg-white dark:bg-slate-950">
            <article
              class="max-w-3xl mx-auto px-8 py-10 prose-slate text-slate-800 dark:text-slate-200"
              v-html="renderedMarkdown"
            ></article>
          </div>
        </template>

      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  Columns2, PenTool, Eye, Save, Download, Trash2, Loader2,
  PanelLeft, RefreshCw, Check, BarChart2
} from 'lucide-vue-next'

const props = defineProps({
  projectSlug: { type: String, required: true },
  projectName: { type: String, default: '' },
})

const emit = defineEmits(['swot-analysis-ready'])

const mode = ref('preview')
const sidebarOpen = ref(true)

const reports = ref([])
const isLoadingList = ref(false)

const currentName = ref('')
const fileContent = ref('')
const originalContent = ref('')
const isLoadingFile = ref(false)
const isSaving = ref(false)
const saveSuccess = ref(false)
let saveSuccessTimer = null

const isAnalyzing = ref(false)
let pollTimer = null
let pendingFilename = ref('')

const isDirty = computed(() => fileContent.value !== originalContent.value)

// ── API helpers ────────────────────────────────────────────────────────────────

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchReports() {
  isLoadingList.value = true
  try {
    const res = await fetch(`/api/swot/list?slug=${encodeURIComponent(props.projectSlug)}`, { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    reports.value = data.reports || []
  } catch (err) {
    console.error('[swot] list error:', err.message)
  } finally {
    isLoadingList.value = false
  }
}

async function loadReport(name) {
  if (isDirty.value) {
    if (!confirm('目前有未儲存的變更，確定要切換嗎？')) return
  }
  isLoadingFile.value = true
  currentName.value = name
  fileContent.value = ''
  originalContent.value = ''
  try {
    const res = await fetch(
      `/api/swot/file?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(name)}`,
      { headers: authHeaders() }
    )
    if (!res.ok) throw new Error('載入失敗')
    const data = await res.json()
    fileContent.value = data.content || ''
    originalContent.value = data.content || ''
  } catch (err) {
    console.error('[swot] load error:', err.message)
    fileContent.value = `# SWOT 報告\n\n載入失敗：${err.message}`
    originalContent.value = fileContent.value
  } finally {
    isLoadingFile.value = false
  }
}

async function saveFile() {
  if (!currentName.value || isSaving.value) return
  isSaving.value = true
  clearTimeout(saveSuccessTimer)
  saveSuccess.value = false
  try {
    const res = await fetch('/api/swot/file', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: props.projectSlug, name: currentName.value, content: fileContent.value }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '儲存失敗')
    }
    originalContent.value = fileContent.value
    saveSuccess.value = true
    saveSuccessTimer = setTimeout(() => { saveSuccess.value = false }, 3000)
  } catch (err) {
    console.error('[swot] save error:', err.message)
    alert(`儲存失敗：${err.message}`)
  } finally {
    isSaving.value = false
  }
}

function exportFile() {
  if (!currentName.value) return
  const blob = new Blob([fileContent.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `swot-${props.projectSlug}-${currentName.value}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function confirmDelete() {
  if (!currentName.value) return
  if (!confirm(`確定要刪除此 SWOT 報告嗎？此動作無法復原。`)) return
  try {
    const res = await fetch(
      `/api/swot/file?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(currentName.value)}`,
      { method: 'DELETE', headers: authHeaders() }
    )
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '刪除失敗')
    }
    currentName.value = ''
    fileContent.value = ''
    originalContent.value = ''
    await fetchReports()
  } catch (err) {
    console.error('[swot] delete error:', err.message)
    alert(`刪除失敗：${err.message}`)
  }
}

// ── SWOT Analysis trigger ──────────────────────────────────────────────────────

async function startAnalysis() {
  if (isAnalyzing.value) return
  isAnalyzing.value = true
  pendingFilename.value = ''
  currentName.value = ''
  fileContent.value = ''
  originalContent.value = ''

  try {
    const res = await fetch('/api/swot/analyze', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectSlug: props.projectSlug, projectName: props.projectName }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '啟動分析失敗')
    }
    const data = await res.json()
    pendingFilename.value = data.filename

    emit('swot-analysis-ready', {
      sessionKey: data.sessionKey,
      prompt: data.prompt,
      newSession: true,
    })

    startPolling(data.filename)
  } catch (err) {
    console.error('[swot] analyze error:', err.message)
    alert(`啟動 SWOT 分析失敗：${err.message}`)
    isAnalyzing.value = false
  }
}

function startPolling(filename) {
  clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(
        `/api/swot/result?slug=${encodeURIComponent(props.projectSlug)}&filename=${encodeURIComponent(filename)}`,
        { headers: authHeaders() }
      )
      if (!res.ok) return
      const data = await res.json()
      if (data.ready) {
        clearInterval(pollTimer)
        isAnalyzing.value = false
        await fetchReports()
        await loadReport(filename)
      }
    } catch {}
  }, 3000)
}

// ── Keyboard shortcut: Ctrl+S / Cmd+S ────────────────────────────────────────

function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (isDirty.value) saveFile()
  }
}

// ── Markdown renderer (reused from ReviewerView) ──────────────────────────────

function escapeHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineMd(t) {
  return escapeHtml(t)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-xs font-mono text-blue-600 dark:text-blue-400">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-blue-500 hover:underline">$1</a>')
}

const renderedMarkdown = computed(() => {
  const text = fileContent.value
  if (!text) return '<p class="text-slate-400 italic">（尚無內容）</p>'

  const lines = text.split('\n')
  const out = []
  let inCode = false
  let codeLines = []
  let listItems = []
  let listType = ''
  let pending = null

  const flushPending = () => {
    if (!pending) return
    const htmlContent = pending.parts.map(p => inlineMd(p)).join('<br>')
    const lvl = pending.level || 0
    const marginClass = lvl === 0 ? '' : lvl === 1 ? 'ml-5' : 'ml-10'

    if (pending.type === 'cb') {
      listItems.push(`<li class="flex items-start gap-2 ${marginClass}"><input type="checkbox" ${pending.checked ? 'checked' : ''} disabled class="mt-1 rounded accent-blue-500 shrink-0"><span class="${pending.checked ? 'line-through text-slate-400' : ''}">${htmlContent}</span></li>`)
    } else if (pending.type === 'ol') {
      listItems.push(`<li class="flex items-start gap-2 ${marginClass}"><span class="text-blue-500 font-bold min-w-[1.5rem] shrink-0">${pending.num}.</span><span class="flex-1 min-w-0">${htmlContent}</span></li>`)
    } else if (lvl === 0) {
      listItems.push(`<li class="flex items-start gap-1.5"><span class="text-blue-500 font-bold shrink-0 mt-px select-none">•</span><span class="flex-1 min-w-0">${htmlContent}</span></li>`)
    } else if (lvl === 1) {
      listItems.push(`<li class="flex items-start gap-1.5 ml-5"><span class="text-slate-400 shrink-0 mt-0.5 text-xs select-none">–</span><span class="flex-1 min-w-0 text-slate-500 dark:text-slate-400 text-sm">${htmlContent}</span></li>`)
    } else {
      listItems.push(`<li class="flex items-start gap-1.5 ml-10"><span class="text-slate-300 shrink-0 mt-0.5 text-xs select-none">·</span><span class="flex-1 min-w-0 text-slate-400 dark:text-slate-500 text-sm">${htmlContent}</span></li>`)
    }
    pending = null
  }

  const flushList = () => {
    flushPending()
    if (!listItems.length) return
    const tag = listType === 'ol' ? 'ol' : 'ul'
    out.push(`<${tag} class="list-none pl-0 space-y-1 mb-4">${listItems.join('')}</${tag}>`)
    listItems = []
    listType = ''
  }

  // Table rendering
  const isTableRow = line => /^\s*\|/.test(line)
  let inTable = false
  let tableRows = []

  const flushTable = () => {
    if (!tableRows.length) return
    const rows = tableRows.filter(r => !/^\s*\|[-:| ]+\|\s*$/.test(r))
    const headerRow = rows[0]
    const bodyRows = rows.slice(1)
    const parseRow = row => row.split('|').slice(1, -1).map(c => c.trim())
    const headers = parseRow(headerRow)
    const thead = `<thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500 text-xs uppercase tracking-wider"><tr>${headers.map(h => `<th class="px-4 py-2 text-left font-semibold">${inlineMd(h)}</th>`).join('')}</tr></thead>`
    const tbody = `<tbody class="divide-y divide-slate-100 dark:divide-slate-800">${bodyRows.map(r => `<tr class="hover:bg-slate-50 dark:hover:bg-slate-900/40">${parseRow(r).map(c => `<td class="px-4 py-2 text-sm">${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
    out.push(`<div class="overflow-x-auto mb-4"><table class="w-full text-left border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">${thead}${tbody}</table></div>`)
    tableRows = []
    inTable = false
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        flushTable()
        out.push(`<pre class="bg-slate-900 dark:bg-slate-800 text-slate-200 rounded-lg p-4 text-xs font-mono overflow-x-auto mb-4 whitespace-pre-wrap">${escapeHtml(codeLines.join('\n'))}</pre>`)
        codeLines = []; inCode = false
      } else { flushList(); flushTable(); inCode = true }
      continue
    }
    if (inCode) { codeLines.push(line); continue }

    if (isTableRow(line)) {
      if (!inTable) { flushList(); inTable = true }
      tableRows.push(line)
      continue
    } else if (inTable) {
      flushTable()
    }

    if (!line.trim()) { flushList(); continue }
    if (line.startsWith('# ')) { flushList(); out.push(`<h1 class="text-2xl font-bold mt-6 mb-3 pb-2 border-b border-slate-200 dark:border-slate-700">${inlineMd(line.slice(2))}</h1>`); continue }
    if (line.startsWith('## ')) { flushList(); out.push(`<h2 class="text-xl font-bold mt-6 mb-2 text-slate-800 dark:text-slate-200">${inlineMd(line.slice(3))}</h2>`); continue }
    if (line.startsWith('### ')) { flushList(); out.push(`<h3 class="text-base font-bold mt-5 mb-1.5 text-slate-700 dark:text-slate-300">${inlineMd(line.slice(4))}</h3>`); continue }
    if (line.startsWith('#### ')) { flushList(); out.push(`<h4 class="text-sm font-bold mt-4 mb-1 text-slate-600 dark:text-slate-400">${inlineMd(line.slice(5))}</h4>`); continue }
    if (line === '---') { flushList(); out.push('<hr class="border-slate-200 dark:border-slate-700 my-4">'); continue }
    if (line.startsWith('> ')) { flushList(); out.push(`<blockquote class="border-l-4 border-blue-300 pl-4 py-1 my-2 text-slate-500 dark:text-slate-400 italic text-sm">${inlineMd(line.slice(2))}</blockquote>`); continue }

    const trimmed = line.trimStart()
    const indentSpaces = line.length - trimmed.length
    const indentLevel = Math.floor(indentSpaces / 2)
    const isIndented = line !== trimmed
    const isListMarker = /^[-*+] /.test(trimmed) || /^[-*]\s+\[/.test(trimmed) || /^\d+\. /.test(trimmed)
    if (isIndented && pending && !isListMarker) { pending.parts.push(trimmed); continue }

    const cbMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s*(.+)$/)
    if (cbMatch) { flushPending(); pending = { type: 'cb', level: indentLevel, checked: cbMatch[1].toLowerCase() === 'x', parts: [cbMatch[2]] }; listType = 'ul'; continue }
    const bulletMatch = trimmed.match(/^[-*+] (.+)$/)
    if (bulletMatch) { flushPending(); pending = { type: 'ul', level: indentLevel, parts: [bulletMatch[1]] }; listType = 'ul'; continue }
    const numMatch = trimmed.match(/^(\d+)\. (.+)$/)
    if (numMatch) { flushPending(); pending = { type: 'ol', level: indentLevel, num: numMatch[1], parts: [numMatch[2]] }; listType = 'ol'; continue }

    flushList()
    out.push(`<p class="mb-3 leading-relaxed text-slate-700 dark:text-slate-300">${inlineMd(line)}</p>`)
  }
  flushList()
  flushTable()
  return out.join('\n')
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────

watch(() => props.projectSlug, async (slug) => {
  if (!slug) return
  currentName.value = ''
  fileContent.value = ''
  originalContent.value = ''
  isAnalyzing.value = false
  clearInterval(pollTimer)
  await fetchReports()
  if (reports.value.length > 0) loadReport(reports.value[0].name)
})

onMounted(async () => {
  await fetchReports()
  if (reports.value.length > 0) loadReport(reports.value[0].name)
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  clearInterval(pollTimer)
  clearTimeout(saveSuccessTimer)
})
</script>
