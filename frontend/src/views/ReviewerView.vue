<template>
  <div class="h-full flex -m-8 overflow-hidden">

    <!-- Left Sidebar: Project browser -->
    <div
      :class="sidebarOpen ? 'w-64' : 'w-0'"
      class="shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 transition-all duration-200 overflow-hidden"
    >
      <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 shrink-0">
        <span class="text-sm font-bold text-slate-700 dark:text-slate-300">專案知識庫</span>
        <button @click="fetchProjectList" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600" title="重新整理">
          <RefreshCw :class="isLoadingList ? 'animate-spin' : ''" class="w-3.5 h-3.5" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto py-2">
        <div v-if="isLoadingList" class="flex items-center justify-center py-12 text-slate-400">
          <Loader2 class="w-5 h-5 animate-spin" />
        </div>
        <template v-else>
          <!-- Overview entry (always first) -->
          <button
            @click="selectOverview"
            :class="currentSlug === '__overview__'
              ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-l-2 border-blue-500'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-l-2 border-transparent'"
            class="w-full text-left px-4 py-2.5 transition-colors flex items-center gap-2"
          >
            <LayoutDashboard class="w-3.5 h-3.5 shrink-0 opacity-60" />
            <span class="text-sm font-medium">專案總覽</span>
          </button>
          <div class="h-px bg-slate-200 dark:bg-slate-700 mx-3 my-1"></div>

          <div v-if="projectFiles.length === 0" class="px-4 py-6 text-center text-xs text-slate-400">
            尚無專案檔案<br>
            <span class="text-slate-300">完成工作流程 Step 5<br>後將自動建立</span>
          </div>
          <button
            v-for="f in projectFiles"
            :key="f.slug"
            @click="loadProject(f.slug)"
            :class="currentSlug === f.slug
              ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-l-2 border-blue-500'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-l-2 border-transparent'"
            class="w-full text-left px-4 py-2.5 transition-colors"
          >
            <div class="flex items-center justify-between gap-2 min-w-0">
              <span class="text-sm font-medium truncate">{{ f.title }}</span>
              <span v-if="f.maturity" :class="maturityClass(f.maturity)" class="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0">
                {{ maturityShort(f.maturity) }}
              </span>
            </div>
            <div v-if="f.lastUpdated" class="text-[10px] text-slate-400 mt-0.5">{{ f.lastUpdated }}</div>
          </button>
        </template>
      </div>

      <!-- Host path indicator -->
      <div v-if="hostInsightsPath" class="px-3 py-2 border-t border-slate-200 dark:border-slate-800 shrink-0">
        <p class="text-[9px] text-slate-400 font-mono break-all leading-tight">{{ hostInsightsPath }}</p>
      </div>
    </div>

    <!-- Main area -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">

      <!-- Toolbar -->
      <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 bg-slate-50 dark:bg-slate-900 shrink-0">
        <div class="flex items-center gap-1">
          <button @click="sidebarOpen = !sidebarOpen" :class="sidebarOpen ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all" title="切換專案清單">
            <PanelLeft class="w-4 h-4" />
          </button>
          <template v-if="currentSlug !== '__overview__'">
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
          <span v-if="currentSlug === '__overview__'" class="text-sm font-medium text-slate-500">專案洞察總覽</span>
          <span v-else-if="currentSlug" class="text-sm font-medium text-slate-500 truncate px-4">{{ currentTitle || currentSlug }}.md</span>
          <span v-else class="text-sm text-slate-400">← 從左側選擇專案</span>
        </div>

        <div class="flex items-center gap-2">
          <template v-if="currentSlug !== '__overview__'">
            <div class="flex items-center gap-1.5 text-xs">
              <span v-if="saveSuccess" class="flex items-center gap-1 text-green-500">
                <Check class="w-3 h-3" /> 已儲存
              </span>
              <span v-else-if="isDirty" class="text-amber-500">未儲存</span>
              <span v-else-if="currentSlug" class="flex items-center gap-1 text-slate-400">
                <span class="w-2 h-2 rounded-full bg-green-400"></span> 已同步
              </span>
            </div>
            <div class="flex gap-1">
              <button
                @click="saveFile"
                :disabled="!currentSlug || isSaving || !isDirty"
                :class="!currentSlug || !isDirty ? 'opacity-40 cursor-not-allowed' : 'hover:bg-blue-700'"
                class="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 transition-colors"
              >
                <Loader2 v-if="isSaving" class="w-3.5 h-3.5 animate-spin" />
                <Save v-else class="w-3.5 h-3.5" />
                儲存
              </button>
              <button @click="exportFile" :disabled="!currentSlug" :class="!currentSlug ? 'opacity-40 cursor-not-allowed' : ''" class="bg-slate-200 dark:bg-slate-800 px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5">
                <Download class="w-3.5 h-3.5" /> 匯出
              </button>
              <button @click="copyContent" :disabled="!currentSlug" :class="!currentSlug ? 'opacity-40 cursor-not-allowed' : ''" class="bg-slate-200 dark:bg-slate-800 px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5">
                <Copy class="w-3.5 h-3.5" /> 複製
              </button>
            </div>
          </template>
          <!-- Overview toolbar: just a refresh button -->
          <template v-else>
            <button @click="fetchProjectList" class="bg-slate-200 dark:bg-slate-800 px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors">
              <RefreshCw :class="isLoadingList ? 'animate-spin' : ''" class="w-3.5 h-3.5" />
              重新整理
            </button>
          </template>
        </div>
      </div>

      <!-- Content area -->
      <div class="flex-1 flex overflow-hidden">

        <!-- Overview table -->
        <div v-if="currentSlug === '__overview__'" class="flex-1 overflow-y-auto p-8 bg-white dark:bg-slate-950">
          <div v-if="overviewProjects.length === 0" class="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
            <LayoutDashboard class="w-12 h-12 opacity-20" />
            <p class="text-sm">尚無專案資料</p>
            <p class="text-xs text-slate-300">完成工作流程 Step 5 後將自動建立</p>
          </div>
          <template v-else>
            <div class="flex items-center justify-between mb-6">
              <h2 class="text-xl font-bold text-slate-800 dark:text-slate-200">專案洞察總覽</h2>
              <span class="text-xs text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">{{ overviewProjects.length }} 個專案</span>
            </div>
            <table class="w-full text-sm border-collapse">
              <thead>
                <tr class="border-b-2 border-slate-200 dark:border-slate-700">
                  <th class="text-left pb-3 pr-6 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">專案名稱</th>
                  <th class="text-left pb-3 pr-6 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">目前階段</th>
                  <th class="text-left pb-3 pr-6 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">成熟度</th>
                  <th class="text-left pb-3 pr-6 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">最後更新</th>
                  <th class="text-left pb-3 font-semibold text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">來源檔案</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in overviewProjects"
                  :key="p.slug"
                  @click="loadProject(p.slug)"
                  class="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-900/60 cursor-pointer transition-colors group"
                >
                  <td class="py-4 pr-6">
                    <span class="font-semibold text-slate-800 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{{ p.name }}</span>
                  </td>
                  <td class="py-4 pr-6">
                    <span class="text-slate-600 dark:text-slate-400">{{ p.stage || '—' }}</span>
                  </td>
                  <td class="py-4 pr-6">
                    <span v-if="p.readiness" :class="maturityClass(p.readiness)" class="text-xs font-bold px-2.5 py-1 rounded-full">
                      {{ p.readiness }}
                    </span>
                    <span v-else class="text-slate-300">—</span>
                  </td>
                  <td class="py-4 pr-6">
                    <span class="text-slate-500 dark:text-slate-400 text-xs font-mono">{{ p.lastUpdated || '—' }}</span>
                  </td>
                  <td class="py-4">
                    <div v-if="p.sources?.length" class="flex flex-col gap-1">
                      <span
                        v-for="src in p.sources"
                        :key="src"
                        class="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded truncate max-w-xs"
                        :title="src"
                      >{{ src.split('/').pop() }}</span>
                    </div>
                    <span v-else class="text-slate-300">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <!-- No file selected -->
        <div v-else-if="!currentSlug" class="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
          <FileText class="w-12 h-12 opacity-30" />
          <p class="text-sm">從左側選擇一個專案開始編輯</p>
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
              placeholder="開始輸入 Markdown..."
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
  Columns2, PenTool, Eye, Save, Download, Copy, Loader2, FileText,
  PanelLeft, RefreshCw, Check, LayoutDashboard
} from 'lucide-vue-next'

const props = defineProps({
  initialSlug: { type: String, default: null }
})

const mode = ref('split')
const sidebarOpen = ref(true)

// Project list state
const projectFiles = ref([])
const overviewProjects = ref([])
const hostInsightsPath = ref('')
const isLoadingList = ref(false)

// Current file state
const currentSlug = ref('__overview__')
const currentTitle = ref('')
const fileContent = ref('')
const originalContent = ref('')
const isLoadingFile = ref(false)
const isSaving = ref(false)
const saveSuccess = ref(false)
let saveSuccessTimer = null

const isDirty = computed(() => fileContent.value !== originalContent.value)

function selectOverview() {
  if (isDirty.value && currentSlug.value && currentSlug.value !== '__overview__') {
    if (!confirm('目前有未儲存的變更，確定要切換嗎？')) return
  }
  currentSlug.value = '__overview__'
  currentTitle.value = ''
  fileContent.value = ''
  originalContent.value = ''
}

// ── API helpers ───────────────────────────────────────────────────────────────

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchProjectList() {
  isLoadingList.value = true
  try {
    const res = await fetch('/api/project-insights/list', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    projectFiles.value = data.files || []
    overviewProjects.value = data.projects || []
    hostInsightsPath.value = data.hostPath || ''
  } catch (err) {
    console.error('[reviewer] list error:', err.message)
  } finally {
    isLoadingList.value = false
  }
}

async function loadProject(slug) {
  if (isDirty.value && currentSlug.value && currentSlug.value !== '__overview__') {
    if (!confirm('目前有未儲存的變更，確定要切換專案嗎？')) return
  }
  isLoadingFile.value = true
  currentSlug.value = slug
  currentTitle.value = projectFiles.value.find(f => f.slug === slug)?.title || slug
  fileContent.value = ''
  originalContent.value = ''

  try {
    const res = await fetch(`/api/project-insights/file?name=${encodeURIComponent(slug)}`, { headers: authHeaders() })
    if (!res.ok) throw new Error('載入失敗')
    const data = await res.json()
    fileContent.value = data.content || ''
    originalContent.value = data.content || ''
  } catch (err) {
    console.error('[reviewer] load error:', err.message)
    fileContent.value = `# ${slug}\n\n讀取檔案失敗：${err.message}`
    originalContent.value = fileContent.value
  } finally {
    isLoadingFile.value = false
  }
}

async function saveFile() {
  if (!currentSlug.value || isSaving.value) return
  isSaving.value = true
  clearTimeout(saveSuccessTimer)
  saveSuccess.value = false

  try {
    const res = await fetch('/api/project-insights/file', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: currentSlug.value, content: fileContent.value }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '儲存失敗')
    }
    originalContent.value = fileContent.value
    saveSuccess.value = true
    saveSuccessTimer = setTimeout(() => { saveSuccess.value = false }, 3000)
    fetchProjectList()
  } catch (err) {
    console.error('[reviewer] save error:', err.message)
    alert(`儲存失敗：${err.message}`)
  } finally {
    isSaving.value = false
  }
}

function exportFile() {
  if (!currentSlug.value) return
  const blob = new Blob([fileContent.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${currentSlug.value}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function copyContent() {
  if (!currentSlug.value) return
  try { await navigator.clipboard.writeText(fileContent.value) } catch {}
}

// ── Keyboard shortcut: Ctrl+S / Cmd+S ────────────────────────────────────────

function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (isDirty.value) saveFile()
  }
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

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
  // Accumulates parts of a potentially multi-line list item
  let pending = null // { type: 'ul'|'ol'|'cb', parts: string[], checked?: bool, num?: string }

  const flushPending = () => {
    if (!pending) return
    const htmlContent = pending.parts.map(p => inlineMd(p)).join('<br>')
    if (pending.type === 'cb') {
      listItems.push(`<li class="flex items-start gap-2"><input type="checkbox" ${pending.checked ? 'checked' : ''} disabled class="mt-1 rounded accent-blue-500 shrink-0"><span class="${pending.checked ? 'line-through text-slate-400' : ''}">${htmlContent}</span></li>`)
    } else if (pending.type === 'ol') {
      listItems.push(`<li class="flex items-start gap-2"><span class="text-blue-500 font-bold min-w-[1.5rem] shrink-0">${pending.num}.</span><span class="flex-1 min-w-0">${htmlContent}</span></li>`)
    } else {
      listItems.push(`<li class="flex items-start gap-1.5 before:content-['•'] before:text-blue-500 before:font-bold before:shrink-0 before:mt-px"><span class="flex-1 min-w-0">${htmlContent}</span></li>`)
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

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre class="bg-slate-900 dark:bg-slate-800 text-slate-200 rounded-lg p-4 text-xs font-mono overflow-x-auto mb-4 whitespace-pre-wrap">${escapeHtml(codeLines.join('\n'))}</pre>`)
        codeLines = []; inCode = false
      } else { flushList(); inCode = true }
      continue
    }
    if (inCode) { codeLines.push(line); continue }
    if (!line.trim()) { flushList(); continue }
    if (line.startsWith('# ')) { flushList(); out.push(`<h1 class="text-2xl font-bold mt-6 mb-3 pb-2 border-b border-slate-200 dark:border-slate-700">${inlineMd(line.slice(2))}</h1>`); continue }
    if (line.startsWith('## ')) { flushList(); out.push(`<h2 class="text-xl font-bold mt-6 mb-2 text-slate-800 dark:text-slate-200">${inlineMd(line.slice(3))}</h2>`); continue }
    if (line.startsWith('### ')) { flushList(); out.push(`<h3 class="text-base font-bold mt-5 mb-1.5 text-slate-700 dark:text-slate-300">${inlineMd(line.slice(4))}</h3>`); continue }
    if (line.startsWith('#### ')) { flushList(); out.push(`<h4 class="text-sm font-bold mt-4 mb-1 text-slate-600 dark:text-slate-400">${inlineMd(line.slice(5))}</h4>`); continue }
    if (line === '---') { flushList(); out.push('<hr class="border-slate-200 dark:border-slate-700 my-4">'); continue }
    if (line.startsWith('> ')) { flushList(); out.push(`<blockquote class="border-l-4 border-blue-300 pl-4 py-1 my-2 text-slate-500 dark:text-slate-400 italic text-sm">${inlineMd(line.slice(2))}</blockquote>`); continue }

    const trimmed = line.trimStart()
    const isIndented = line !== trimmed

    // Indented non-list line → continuation of current list item
    const isListMarker = /^[-*+] /.test(trimmed) || /^[-*]\s+\[/.test(trimmed) || /^\d+\. /.test(trimmed)
    if (isIndented && pending && !isListMarker) {
      pending.parts.push(trimmed)
      continue
    }

    // Checkbox: match with optional leading whitespace
    const cbMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s*(.+)$/)
    if (cbMatch) {
      flushPending()
      pending = { type: 'cb', checked: cbMatch[1].toLowerCase() === 'x', parts: [cbMatch[2]] }
      listType = 'ul'; continue
    }
    // Bullet: match with optional leading whitespace
    const bulletMatch = trimmed.match(/^[-*+] (.+)$/)
    if (bulletMatch) {
      flushPending()
      pending = { type: 'ul', parts: [bulletMatch[1]] }
      listType = 'ul'; continue
    }
    // Numbered: match with optional leading whitespace
    const numMatch = trimmed.match(/^(\d+)\. (.+)$/)
    if (numMatch) {
      flushPending()
      pending = { type: 'ol', num: numMatch[1], parts: [numMatch[2]] }
      listType = 'ol'; continue
    }

    flushList()
    out.push(`<p class="mb-3 leading-relaxed text-slate-700 dark:text-slate-300">${inlineMd(line)}</p>`)
  }
  flushList()
  return out.join('\n')
})

// ── Maturity helpers ──────────────────────────────────────────────────────────

function maturityClass(m) {
  if (!m) return 'bg-slate-100 dark:bg-slate-800 text-slate-500'
  const v = String(m).toLowerCase()
  if (v.includes('not ready')) return 'bg-slate-200 dark:bg-slate-700 text-slate-500'
  if (v.includes('internal')) return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
  if (v.includes('soft')) return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
  if (v.includes('public')) return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
  return 'bg-slate-100 dark:bg-slate-800 text-slate-400'
}

function maturityShort(m) {
  if (!m) return '?'
  const v = String(m).toLowerCase()
  if (v.includes('not ready')) return 'NR'
  if (v.includes('internal')) return 'INT'
  if (v.includes('soft')) return 'SL'
  if (v.includes('public')) return 'PUB'
  return m.slice(0, 3)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

watch(() => props.initialSlug, (slug) => {
  if (slug) loadProject(slug)
})

onMounted(async () => {
  await fetchProjectList()
  if (props.initialSlug) loadProject(props.initialSlug)
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  clearTimeout(saveSuccessTimer)
})
</script>
