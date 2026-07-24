<template>
  <div class="h-full flex -m-8 overflow-hidden">

    <!-- Level 1: skill picker -->
    <div v-if="!selectedSkillSlug" class="flex-1 overflow-y-auto p-8 bg-white dark:bg-slate-950">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-xl font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
            <Wand2 class="w-5 h-5 text-pink-500" /> 自訂技能 — {{ projectName || projectSlug }}
          </h2>
          <p class="text-sm text-slate-400 mt-1">選擇一個技能，檢視或產出這個專案的相關報告</p>
        </div>
        <button @click="fetchSkills" class="bg-slate-100 dark:bg-slate-800 p-2 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600" title="重新整理">
          <RefreshCw :class="isLoadingSkills ? 'animate-spin' : ''" class="w-4 h-4" />
        </button>
      </div>

      <div v-if="isLoadingSkills" class="flex items-center justify-center py-20 text-slate-400">
        <Loader2 class="w-6 h-6 animate-spin" />
      </div>
      <div v-else-if="skills.length === 0" class="flex flex-col items-center justify-center h-64 gap-3 text-slate-400">
        <Wand2 class="w-12 h-12 opacity-20" />
        <p class="text-sm">尚無可用技能，請先至「技能管理」建立</p>
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <button
          v-for="s in skills" :key="s.slug"
          @click="selectSkill(s.slug)"
          class="text-left bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 hover:border-pink-300 dark:hover:border-pink-800 hover:shadow-md transition-all"
        >
          <div class="flex items-center gap-2 mb-1">
            <h3 class="font-bold truncate">{{ s.name }}</h3>
            <span
              :class="s.protected ? 'bg-slate-100 dark:bg-slate-800 text-slate-500' : 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-300'"
              class="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0"
            >
              {{ s.protected ? '系統範本' : '自訂' }}
            </span>
          </div>
          <p class="text-xs text-slate-400 font-mono mb-2">{{ s.slug }}</p>
          <p class="text-sm text-slate-500 dark:text-slate-400 line-clamp-3">{{ s.description || '（無說明）' }}</p>
        </button>
      </div>
    </div>

    <!-- Level 2: report browser for the selected skill -->
    <template v-else>
      <div
        :class="sidebarOpen ? 'w-64' : 'w-0'"
        class="shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 transition-all duration-200 overflow-hidden"
      >
        <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 shrink-0 gap-2">
          <button @click="backToSkillPicker" class="flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 shrink-0">
            <ChevronLeft class="w-3.5 h-3.5" /> 換技能
          </button>
        </div>
        <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div class="text-sm font-bold text-slate-700 dark:text-slate-300 truncate">{{ selectedSkill?.name || selectedSkillSlug }}</div>
          <div class="flex items-center gap-1 mt-2">
            <button
              @click="startRun"
              :disabled="isRunning"
              :class="isRunning ? 'opacity-50 cursor-not-allowed' : 'hover:bg-pink-700'"
              class="bg-pink-600 text-white px-2 py-1 rounded text-xs font-bold flex items-center gap-1 transition-colors"
              title="針對此專案執行一次此技能"
            >
              <Play v-if="!isRunning" class="w-3 h-3" />
              <Loader2 v-else class="w-3 h-3 animate-spin" />
              新執行
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
            尚無執行紀錄<br>
            <span class="text-slate-300">點擊「新執行」開始</span>
          </div>
          <button
            v-for="r in reports"
            :key="r.name"
            @click="loadReport(r.name)"
            :class="currentName === r.name
              ? 'bg-pink-50 dark:bg-pink-900/20 text-pink-700 dark:text-pink-300 border-l-2 border-pink-500'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-l-2 border-transparent'"
            class="w-full text-left px-4 py-2.5 transition-colors"
          >
            <div class="text-sm font-medium">執行結果</div>
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

          <div class="flex-1 flex justify-center">
            <span v-if="isRunning" class="flex items-center gap-2 text-sm font-medium text-amber-500">
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              AI 執行中，請稍候...
            </span>
            <span v-else-if="currentName" class="text-sm font-medium text-slate-500 truncate px-4">{{ currentName }}.md</span>
            <span v-else class="text-sm text-slate-400">← 從左側選擇執行結果</span>
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
                  :class="!isDirty ? 'opacity-40 cursor-not-allowed' : 'hover:bg-pink-700'"
                  class="bg-pink-600 text-white px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 transition-colors"
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

          <div v-if="isRunning && !currentName" class="flex-1 flex flex-col items-center justify-center gap-5">
            <div class="flex flex-col items-center gap-3">
              <div class="w-16 h-16 rounded-full bg-pink-50 dark:bg-pink-900/20 flex items-center justify-center">
                <Wand2 class="w-8 h-8 text-pink-500 animate-pulse" />
              </div>
              <p class="text-base font-semibold text-slate-700 dark:text-slate-300">AI 執行中</p>
              <p class="text-sm text-slate-400 max-w-xs text-center">
                可以打開聊天面板查看即時進度，完成後將自動載入結果
              </p>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>執行完成後將自動載入</span>
            </div>
          </div>

          <div v-else-if="!currentName" class="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
            <FileText class="w-12 h-12 opacity-20" />
            <p class="text-sm">從左側選擇一筆執行結果，或點擊「新執行」</p>
          </div>

          <div v-else-if="isLoadingFile" class="flex-1 flex items-center justify-center text-slate-400">
            <Loader2 class="w-6 h-6 animate-spin" />
          </div>

          <template v-else>
            <div v-if="mode !== 'preview'" class="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">
              <textarea
                v-model="fileContent"
                spellcheck="false"
                class="flex-1 w-full bg-[#1e1e1e] text-slate-200 p-6 font-mono text-sm resize-none outline-none leading-relaxed overflow-y-auto"
                placeholder="執行結果內容..."
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
    </template>

  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  Columns2, PenTool, Eye, Save, Download, Trash2, Loader2,
  PanelLeft, RefreshCw, Check, FileText, Wand2, ChevronLeft, Play,
} from 'lucide-vue-next'

const props = defineProps({
  projectSlug: { type: String, required: true },
  projectName: { type: String, default: '' },
  initialSkillSlug: { type: String, default: '' },
  initialReportName: { type: String, default: '' },
})

const emit = defineEmits(['skill-ready'])

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

// ── Level 1: skill picker ──────────────────────────────────────────────────

const skills = ref([])
const isLoadingSkills = ref(false)
const selectedSkillSlug = ref('')
const selectedSkill = computed(() => skills.value.find(s => s.slug === selectedSkillSlug.value) || null)

async function fetchSkills() {
  isLoadingSkills.value = true
  try {
    const res = await fetch('/api/skills', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    skills.value = data.skills || []
  } catch (err) {
    console.error('[custom-skill] fetch skills error:', err.message)
  } finally {
    isLoadingSkills.value = false
  }
}

async function selectSkill(slug, reportName = '') {
  selectedSkillSlug.value = slug
  currentName.value = ''
  fileContent.value = ''
  originalContent.value = ''
  await fetchReports()
  if (reportName) await loadReport(reportName)
}

function backToSkillPicker() {
  clearInterval(pollTimer)
  selectedSkillSlug.value = ''
  reports.value = []
  currentName.value = ''
  fileContent.value = ''
  originalContent.value = ''
  isRunning.value = false
}

// ── Level 2: report browser ──────────────────────────────────────────────────

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

const isRunning = ref(false)
let pollTimer = null

const isDirty = computed(() => fileContent.value !== originalContent.value)

async function fetchReports() {
  if (!selectedSkillSlug.value) return
  isLoadingList.value = true
  try {
    const res = await fetch(
      `/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/runs?projectSlug=${encodeURIComponent(props.projectSlug)}`,
      { headers: authHeaders() }
    )
    if (!res.ok) return
    const data = await res.json()
    reports.value = data.reports || []
  } catch (err) {
    console.error('[custom-skill] fetch reports error:', err.message)
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
      `/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/runs/file?projectSlug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(name)}`,
      { headers: authHeaders() }
    )
    if (!res.ok) throw new Error('載入失敗')
    const data = await res.json()
    fileContent.value = data.content || ''
    originalContent.value = data.content || ''
  } catch (err) {
    console.error('[custom-skill] load error:', err.message)
    fileContent.value = `# 執行結果\n\n載入失敗：${err.message}`
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
    const res = await fetch(`/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/runs/file`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectSlug: props.projectSlug, name: currentName.value, content: fileContent.value }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '儲存失敗')
    }
    originalContent.value = fileContent.value
    saveSuccess.value = true
    saveSuccessTimer = setTimeout(() => { saveSuccess.value = false }, 3000)
  } catch (err) {
    console.error('[custom-skill] save error:', err.message)
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
  a.download = `custom-${selectedSkillSlug.value}-${props.projectSlug}-${currentName.value}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function confirmDelete() {
  if (!currentName.value) return
  if (!confirm('確定要刪除此執行結果嗎？此動作無法復原。')) return
  try {
    const res = await fetch(
      `/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/runs/file?projectSlug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(currentName.value)}`,
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
    console.error('[custom-skill] delete error:', err.message)
    alert(`刪除失敗：${err.message}`)
  }
}

async function startRun() {
  if (isRunning.value || !selectedSkillSlug.value) return
  isRunning.value = true
  currentName.value = ''
  fileContent.value = ''
  originalContent.value = ''

  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/run`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectSlug: props.projectSlug, projectName: props.projectName }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '啟動執行失敗')
    }
    const data = await res.json()

    emit('skill-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startPolling(data.filename)
  } catch (err) {
    console.error('[custom-skill] run error:', err.message)
    alert(`啟動執行失敗：${err.message}`)
    isRunning.value = false
  }
}

function startPolling(filename) {
  clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(
        `/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/runs/result?projectSlug=${encodeURIComponent(props.projectSlug)}&filename=${encodeURIComponent(filename)}`,
        { headers: authHeaders() }
      )
      if (!res.ok) return
      const data = await res.json()
      if (data.ready) {
        clearInterval(pollTimer)
        isRunning.value = false
        await fetchReports()
        await loadReport(filename)
      }
    } catch {}
  }, 3000)
}

function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (isDirty.value) saveFile()
  }
}

function escapeHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function assetUrl(src) {
  if (/^(https?:|data:)/i.test(src)) return src
  const filename = src.trim().split('/').pop()
  const token = localStorage.getItem('clawpm_token') || ''
  return `/api/project-insights/asset?file=${encodeURIComponent(filename)}&token=${encodeURIComponent(token)}`
}

function inlineMd(t) {
  return escapeHtml(t)
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-xs font-mono text-blue-600 dark:text-blue-400">$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
      `<img src="${assetUrl(src)}" alt="${alt.replace(/"/g, '&quot;')}" class="max-w-full rounded-lg border border-slate-200 dark:border-slate-700 my-2" loading="lazy">`)
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
      listItems.push(`<li class="flex items-start gap-2 ${marginClass}"><input type="checkbox" ${pending.checked ? 'checked' : ''} disabled class="mt-1 rounded accent-pink-500 shrink-0"><span class="${pending.checked ? 'line-through text-slate-400' : ''}">${htmlContent}</span></li>`)
    } else if (pending.type === 'ol') {
      listItems.push(`<li class="flex items-start gap-2 ${marginClass}"><span class="text-pink-500 font-bold min-w-[1.5rem] shrink-0">${pending.num}.</span><span class="flex-1 min-w-0">${htmlContent}</span></li>`)
    } else if (lvl === 0) {
      listItems.push(`<li class="flex items-start gap-1.5"><span class="text-pink-500 font-bold shrink-0 mt-px select-none">•</span><span class="flex-1 min-w-0">${htmlContent}</span></li>`)
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
    if (line.startsWith('> ')) { flushList(); out.push(`<blockquote class="border-l-4 border-pink-300 pl-4 py-1 my-2 text-slate-500 dark:text-slate-400 italic text-sm">${inlineMd(line.slice(2))}</blockquote>`); continue }

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

watch(() => props.projectSlug, () => {
  backToSkillPicker()
  fetchSkills()
})

onMounted(async () => {
  await fetchSkills()
  if (props.initialSkillSlug) {
    await selectSkill(props.initialSkillSlug, props.initialReportName)
  }
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  clearInterval(pollTimer)
  clearTimeout(saveSuccessTimer)
})
</script>
