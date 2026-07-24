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
            :class="isAnalyzing ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'"
            class="bg-blue-600 text-white px-2 py-1 rounded text-xs font-bold flex items-center gap-1 transition-colors"
            title="產出新一篇技術分享文章"
          >
            <Code2 v-if="!isAnalyzing" class="w-3 h-3" />
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
          尚無技術分享文章<br>
          <span class="text-slate-300">點擊「新分析」開始</span>
        </div>
        <template v-for="r in reports" :key="r.name">
          <button
            @click="loadReport(r.name)"
            :class="currentName === r.name && docType === 'tech'
              ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-l-2 border-blue-500'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-l-2 border-transparent'"
            class="w-full text-left px-4 py-2.5 transition-colors"
          >
            <div class="text-sm font-medium">技術分享</div>
            <div class="text-[10px] text-slate-400 mt-0.5 font-mono">{{ r.displayDate }}</div>
          </button>

          <!-- Nested: blog drafts derived from this tech article -->
          <div v-if="currentName === r.name" class="pl-3 pb-1">
            <div v-if="isLoadingBlogList" class="flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-400">
              <Loader2 class="w-3 h-3 animate-spin" /> 讀取草稿中...
            </div>
            <button
              v-for="b in blogDrafts"
              :key="b.name"
              @click="loadBlogDraft(b.name, 'zh')"
              :class="docType === 'blog' && activeBlogName === b.name
                ? 'bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 border-l-2 border-violet-500'
                : 'text-slate-500 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 border-l-2 border-transparent'"
              class="w-full text-left pl-3 pr-2 py-1.5 transition-colors rounded-r"
            >
              <div class="flex items-center gap-1.5 text-xs font-medium">
                <Newspaper class="w-3 h-3 shrink-0" />
                <span class="truncate">部落格草稿</span>
                <Loader2 v-if="!b.ready && !b.error" class="w-3 h-3 animate-spin shrink-0 text-amber-500" />
                <AlertCircle v-else-if="b.error" class="w-3 h-3 shrink-0 text-red-500" />
                <span v-if="b.published" class="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" title="已發布">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>已發布
                </span>
              </div>
              <div class="text-[10px] text-slate-400 mt-0.5 font-mono pl-4.5">{{ b.displayDate }}</div>
            </button>
          </div>
        </template>
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
          <template v-if="docType === 'blog' && activeBlogName">
            <div class="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1"></div>
            <button @click="switchBlogLang('zh')" :class="activeLang === 'zh' ? 'bg-white dark:bg-slate-700 shadow-sm text-violet-600 dark:text-violet-300' : 'text-slate-500'" class="px-2 py-1 rounded-md text-xs font-bold transition-all">中文</button>
            <button @click="switchBlogLang('en')" :class="activeLang === 'en' ? 'bg-white dark:bg-slate-700 shadow-sm text-violet-600 dark:text-violet-300' : 'text-slate-500'" class="px-2 py-1 rounded-md text-xs font-bold transition-all">EN</button>
          </template>
        </div>

        <!-- Title -->
        <div class="flex-1 flex justify-center">
          <span v-if="isAnalyzing" class="flex items-center gap-2 text-sm font-medium text-amber-500">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            AI 分析中，請稍候...
          </span>
          <span v-else-if="isConvertingBlog" class="flex items-center gap-2 text-sm font-medium text-violet-500">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            AI 正在轉換為部落格文章...
          </span>
          <span v-else-if="docType === 'blog' && activeBlogName" class="text-sm font-medium text-slate-500 truncate px-4">部落格草稿 · {{ activeBlogName }}</span>
          <span v-else-if="currentName" class="text-sm font-medium text-slate-500 truncate px-4">{{ currentName }}.md</span>
          <span v-else class="text-sm text-slate-400">← 從左側選擇文章</span>
        </div>

        <div class="flex items-center gap-2">
          <template v-if="docType === 'blog' && activeBlogName">
            <button @click="backToTech" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 transition-colors" title="返回技術文章">
              <ArrowLeft class="w-4 h-4" />
            </button>
          </template>
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
                v-if="docType === 'tech'"
                @click="startBlogConversion"
                :disabled="isConvertingBlog"
                :class="isConvertingBlog ? 'opacity-50 cursor-not-allowed' : 'hover:bg-violet-700'"
                class="bg-violet-600 text-white px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 transition-colors"
                title="用這篇技術文章產生一份部落格草稿"
              >
                <Loader2 v-if="isConvertingBlog" class="w-3.5 h-3.5 animate-spin" />
                <Newspaper v-else class="w-3.5 h-3.5" />
                轉換成部落格文章
                <span v-if="blogDrafts.length" class="bg-white/20 rounded-full px-1.5 text-[10px]">{{ blogDrafts.length }}</span>
              </button>
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
              <button
                v-if="docType === 'blog' && activeBlogName"
                @click="activeBlogDraft?.published ? unpublishBlog() : publishBlog()"
                :disabled="isPublishing || !activeBlogDraft?.ready"
                :class="[
                  (isPublishing || !activeBlogDraft?.ready) ? 'opacity-50 cursor-not-allowed' : '',
                  activeBlogDraft?.published
                    ? 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700'
                    : 'bg-emerald-600 text-white hover:bg-emerald-700',
                ]"
                class="px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 transition-colors"
                :title="activeBlogDraft?.published ? '從部落格下架這篇文章' : '發布這篇文章到部落格'"
              >
                <Loader2 v-if="isPublishing" class="w-3.5 h-3.5 animate-spin" />
                <Globe v-else class="w-3.5 h-3.5" />
                {{ activeBlogDraft?.published ? '取消發布' : '發布' }}
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

        <!-- Analyzing progress (tech article) -->
        <div v-if="isAnalyzing && !currentName" class="flex-1 flex flex-col items-center justify-center gap-5">
          <div class="flex flex-col items-center gap-3">
            <div class="w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center">
              <Code2 class="w-8 h-8 text-blue-500 animate-pulse" />
            </div>
            <p class="text-base font-semibold text-slate-700 dark:text-slate-300">正在整理技術分享文章</p>
            <p class="text-sm text-slate-400 max-w-xs text-center">
              AI 正整理技術架構、搜尋業界資料與對比做法，產出可對外發表的技術部落格文章，通常需要 1–3 分鐘
            </p>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>文章完成後將自動載入</span>
          </div>
        </div>

        <!-- Converting progress (blog draft) -->
        <div v-else-if="isConvertingBlog && !activeBlogName" class="flex-1 flex flex-col items-center justify-center gap-5">
          <div class="flex flex-col items-center gap-3">
            <div class="w-16 h-16 rounded-full bg-violet-50 dark:bg-violet-900/20 flex items-center justify-center">
              <Newspaper class="w-8 h-8 text-violet-500 animate-pulse" />
            </div>
            <p class="text-base font-semibold text-slate-700 dark:text-slate-300">正在轉換成部落格文章</p>
            <p class="text-sm text-slate-400 max-w-xs text-center">
              AI 正改寫成部落格語氣、翻譯成英文、產生分類標籤與封面圖，通常需要 1–3 分鐘
            </p>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>草稿完成後將自動載入</span>
          </div>
        </div>

        <!-- Empty state -->
        <div v-else-if="!currentName" class="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
          <Code2 class="w-12 h-12 opacity-20" />
          <p class="text-sm">從左側選擇一篇技術文章，或點擊「新分析」</p>
        </div>

        <!-- Loading file -->
        <div v-else-if="isLoadingFile" class="flex-1 flex items-center justify-center text-slate-400">
          <Loader2 class="w-6 h-6 animate-spin" />
        </div>

        <!-- Editor panes -->
        <template v-else>
          <div v-if="mode !== 'preview'" class="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">
            <textarea
              v-model="activeContent"
              spellcheck="false"
              class="flex-1 w-full bg-[#1e1e1e] text-slate-200 p-6 font-mono text-sm resize-none outline-none leading-relaxed overflow-y-auto"
              :placeholder="docType === 'blog' ? '部落格文章草稿...' : '技術分享文章...'"
            ></textarea>
          </div>
          <div v-if="mode !== 'edit'" class="flex-1 overflow-y-auto bg-white dark:bg-slate-950">
            <div class="flex justify-center gap-10 px-8 py-10 max-w-6xl mx-auto">
              <article class="max-w-3xl w-full min-w-0 prose-slate text-slate-800 dark:text-slate-200">
                <img
                  v-if="docType === 'blog' && activeBlogName"
                  :src="resolveImageUrl('feature.png')"
                  alt="封面圖"
                  class="w-full rounded-lg border border-slate-200 dark:border-slate-700 mb-6 object-cover"
                  loading="lazy"
                >
                <div v-html="renderedMarkdown"></div>
              </article>
              <aside v-if="mode === 'preview' && tocItems.length" class="hidden xl:block w-56 shrink-0">
                <nav class="sticky top-10 space-y-1.5 text-sm max-h-[calc(100vh-8rem)] overflow-y-auto">
                  <div class="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">目錄</div>
                  <a
                    v-for="item in tocItems"
                    :key="item.id"
                    :href="`#${item.id}`"
                    @click.prevent="scrollToHeading(item.id)"
                    :class="item.level === 3
                      ? 'pl-3 text-slate-400 dark:text-slate-500 text-xs'
                      : 'text-slate-600 dark:text-slate-300 font-medium'"
                    class="block py-0.5 hover:text-blue-500 dark:hover:text-blue-400 transition-colors truncate"
                  >{{ item.text }}</a>
                </nav>
              </aside>
            </div>
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
  PanelLeft, RefreshCw, Check, Code2, Newspaper, ArrowLeft, AlertCircle, Globe
} from 'lucide-vue-next'

const props = defineProps({
  projectSlug: { type: String, required: true },
  projectName: { type: String, default: '' },
})

const emit = defineEmits(['tech-analysis-ready'])

const mode = ref('preview')
const sidebarOpen = ref(true)
const docType = ref('tech') // 'tech' | 'blog'

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

// ── Blog draft state ──────────────────────────────────────────────────────
const blogDrafts = ref([])
const isLoadingBlogList = ref(false)
const activeBlogName = ref('')
const activeLang = ref('zh')
const blogContent = ref('')
const blogOriginalContent = ref('')
const isConvertingBlog = ref(false)
let blogPollTimer = null
const isPublishing = ref(false)

const activeBlogDraft = computed(() => blogDrafts.value.find(d => d.name === activeBlogName.value) || null)

const activeContent = computed({
  get: () => docType.value === 'blog' ? blogContent.value : fileContent.value,
  set: (v) => { if (docType.value === 'blog') blogContent.value = v; else fileContent.value = v },
})

const isDirty = computed(() => docType.value === 'blog'
  ? blogContent.value !== blogOriginalContent.value
  : fileContent.value !== originalContent.value)

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchReports() {
  isLoadingList.value = true
  try {
    const res = await fetch(`/api/tech/list?slug=${encodeURIComponent(props.projectSlug)}`, { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    reports.value = data.reports || []
  } catch (err) {
    console.error('[tech] list error:', err.message)
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
  docType.value = 'tech'
  resetBlogState()
  try {
    const res = await fetch(
      `/api/tech/file?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(name)}`,
      { headers: authHeaders() }
    )
    if (!res.ok) throw new Error('載入失敗')
    const data = await res.json()
    fileContent.value = data.content || ''
    originalContent.value = data.content || ''
  } catch (err) {
    console.error('[tech] load error:', err.message)
    fileContent.value = `# 技術分享文章\n\n載入失敗：${err.message}`
    originalContent.value = fileContent.value
  } finally {
    isLoadingFile.value = false
  }
  fetchBlogDrafts(name)
}

async function saveFile() {
  if (!currentName.value || isSaving.value) return
  if (docType.value === 'blog') return saveBlogFile()
  isSaving.value = true
  clearTimeout(saveSuccessTimer)
  saveSuccess.value = false
  try {
    const res = await fetch('/api/tech/file', {
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
    console.error('[tech] save error:', err.message)
    alert(`儲存失敗：${err.message}`)
  } finally {
    isSaving.value = false
  }
}

function exportFile() {
  if (!currentName.value) return
  if (docType.value === 'blog') return exportBlogFile()
  const blob = new Blob([fileContent.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `tech-${props.projectSlug}-${currentName.value}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function confirmDelete() {
  if (!currentName.value) return
  if (docType.value === 'blog') return confirmDeleteBlog()
  if (!confirm('確定要刪除此技術分享文章嗎？此動作無法復原。')) return
  try {
    const res = await fetch(
      `/api/tech/file?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(currentName.value)}`,
      { method: 'DELETE', headers: authHeaders() }
    )
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '刪除失敗')
    }
    currentName.value = ''
    fileContent.value = ''
    originalContent.value = ''
    resetBlogState()
    await fetchReports()
  } catch (err) {
    console.error('[tech] delete error:', err.message)
    alert(`刪除失敗：${err.message}`)
  }
}

async function startAnalysis() {
  if (isAnalyzing.value) return
  isAnalyzing.value = true
  pendingFilename.value = ''
  currentName.value = ''
  fileContent.value = ''
  originalContent.value = ''
  resetBlogState()

  try {
    const res = await fetch('/api/tech/analyze', {
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

    emit('tech-analysis-ready', {
      sessionKey: data.sessionKey,
      prompt: data.prompt,
      newSession: true,
    })

    startPolling(data.filename)
  } catch (err) {
    console.error('[tech] analyze error:', err.message)
    alert(`啟動技術分享分析失敗：${err.message}`)
    isAnalyzing.value = false
  }
}

function startPolling(filename) {
  clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(
        `/api/tech/result?slug=${encodeURIComponent(props.projectSlug)}&filename=${encodeURIComponent(filename)}`,
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

// ── Blog draft actions ────────────────────────────────────────────────────

function resetBlogState() {
  clearInterval(blogPollTimer)
  isConvertingBlog.value = false
  blogDrafts.value = []
  activeBlogName.value = ''
  activeLang.value = 'zh'
  blogContent.value = ''
  blogOriginalContent.value = ''
}

async function fetchBlogDrafts(techName) {
  if (!techName) return
  isLoadingBlogList.value = true
  try {
    const res = await fetch(
      `/api/blog/list?slug=${encodeURIComponent(props.projectSlug)}&techName=${encodeURIComponent(techName)}`,
      { headers: authHeaders() }
    )
    if (!res.ok) return
    const data = await res.json()
    blogDrafts.value = data.drafts || []
  } catch (err) {
    console.error('[blog] list error:', err.message)
  } finally {
    isLoadingBlogList.value = false
  }
}

async function loadBlogDraft(name, lang) {
  if (isDirty.value) {
    if (!confirm('目前有未儲存的變更，確定要切換嗎？')) return
  }
  docType.value = 'blog'
  activeBlogName.value = name
  activeLang.value = lang
  isLoadingFile.value = true
  blogContent.value = ''
  blogOriginalContent.value = ''
  try {
    const res = await fetch(
      `/api/blog/file?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(name)}&lang=${lang}`,
      { headers: authHeaders() }
    )
    if (!res.ok) throw new Error('載入失敗')
    const data = await res.json()
    blogContent.value = data.content || ''
    blogOriginalContent.value = data.content || ''
  } catch (err) {
    console.error('[blog] load error:', err.message)
    blogContent.value = `# 部落格草稿\n\n載入失敗：${err.message}`
    blogOriginalContent.value = blogContent.value
  } finally {
    isLoadingFile.value = false
  }
}

async function switchBlogLang(lang) {
  if (lang === activeLang.value) return
  await loadBlogDraft(activeBlogName.value, lang)
}

function backToTech() {
  if (isDirty.value) {
    if (!confirm('目前有未儲存的變更，確定要切換嗎？')) return
  }
  docType.value = 'tech'
  activeBlogName.value = ''
  blogContent.value = ''
  blogOriginalContent.value = ''
}

async function saveBlogFile() {
  if (!activeBlogName.value || isSaving.value) return
  isSaving.value = true
  clearTimeout(saveSuccessTimer)
  saveSuccess.value = false
  try {
    const res = await fetch('/api/blog/file', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: props.projectSlug, name: activeBlogName.value, lang: activeLang.value, content: blogContent.value }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '儲存失敗')
    }
    blogOriginalContent.value = blogContent.value
    saveSuccess.value = true
    saveSuccessTimer = setTimeout(() => { saveSuccess.value = false }, 3000)
  } catch (err) {
    console.error('[blog] save error:', err.message)
    alert(`儲存失敗：${err.message}`)
  } finally {
    isSaving.value = false
  }
}

function exportBlogFile() {
  if (!activeBlogName.value) return
  const blob = new Blob([blogContent.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `blog-${props.projectSlug}-${activeBlogName.value}.${activeLang.value === 'en' ? 'en.md' : 'md'}`
  a.click()
  URL.revokeObjectURL(url)
}

async function confirmDeleteBlog() {
  if (!activeBlogName.value) return
  if (!confirm('確定要刪除此部落格草稿嗎？此動作無法復原。')) return
  try {
    const res = await fetch(
      `/api/blog/file?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(activeBlogName.value)}`,
      { method: 'DELETE', headers: authHeaders() }
    )
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '刪除失敗')
    }
    const techName = currentName.value
    backToTech()
    await fetchBlogDrafts(techName)
  } catch (err) {
    console.error('[blog] delete error:', err.message)
    alert(`刪除失敗：${err.message}`)
  }
}

async function startBlogConversion() {
  if (isConvertingBlog.value || !currentName.value) return
  isConvertingBlog.value = true
  docType.value = 'blog'
  activeBlogName.value = ''
  blogContent.value = ''
  blogOriginalContent.value = ''

  try {
    const res = await fetch('/api/blog/rewrite', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: props.projectSlug, techName: currentName.value }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '啟動轉換失敗')
    }
    const data = await res.json()
    startBlogPolling(data.name)
    fetchBlogDrafts(currentName.value)
  } catch (err) {
    console.error('[blog] rewrite error:', err.message)
    alert(`啟動部落格轉換失敗：${err.message}`)
    isConvertingBlog.value = false
    docType.value = 'tech'
  }
}

function startBlogPolling(name) {
  clearInterval(blogPollTimer)
  blogPollTimer = setInterval(async () => {
    try {
      const res = await fetch(
        `/api/blog/result?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(name)}`,
        { headers: authHeaders() }
      )
      if (!res.ok) return
      const data = await res.json()
      if (data.ready) {
        clearInterval(blogPollTimer)
        isConvertingBlog.value = false
        await fetchBlogDrafts(currentName.value)
        await loadBlogDraft(name, 'zh')
      } else if (data.error) {
        clearInterval(blogPollTimer)
        isConvertingBlog.value = false
        docType.value = 'tech'
        await fetchBlogDrafts(currentName.value)
        alert(`部落格轉換失敗：${data.error}`)
      }
    } catch {}
  }, 3000)
}

async function publishBlog() {
  if (!activeBlogName.value || isPublishing.value) return
  if (!confirm('確定要發布這篇部落格文章嗎？')) return
  isPublishing.value = true
  try {
    const res = await fetch('/api/blog/publish', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: props.projectSlug, name: activeBlogName.value }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '發布失敗')
    }
    await fetchBlogDrafts(currentName.value)
  } catch (err) {
    console.error('[blog] publish error:', err.message)
    alert(`發布失敗：${err.message}`)
  } finally {
    isPublishing.value = false
  }
}

async function unpublishBlog() {
  if (!activeBlogName.value || isPublishing.value) return
  if (!confirm('確定要取消發布這篇部落格文章嗎？線上頁面將會被移除。')) return
  isPublishing.value = true
  try {
    const res = await fetch('/api/blog/unpublish', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: props.projectSlug, name: activeBlogName.value }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '取消發布失敗')
    }
    await fetchBlogDrafts(currentName.value)
  } catch (err) {
    console.error('[blog] unpublish error:', err.message)
    alert(`取消發布失敗：${err.message}`)
  } finally {
    isPublishing.value = false
  }
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

function resolveImageUrl(src) {
  if (/^(https?:|data:)/i.test(src)) return src
  const filename = src.trim().split('/').pop()
  const token = localStorage.getItem('clawpm_token') || ''
  if (docType.value === 'blog' && activeBlogName.value) {
    return `/api/blog/asset?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(activeBlogName.value)}&file=${encodeURIComponent(filename)}&token=${encodeURIComponent(token)}`
  }
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
      `<img src="${resolveImageUrl(src)}" alt="${alt.replace(/"/g, '&quot;')}" class="max-w-full rounded-lg border border-slate-200 dark:border-slate-700 my-2" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-blue-500 hover:underline">$1</a>')
}

function formatFrontmatterDate(raw) {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Hugo frontmatter 是給靜態網站產生器讀的 YAML，不是給人看的內文——
// preview 應該像真的部落格文章一樣呈現標題/日期/分類/標籤，而不是原始 YAML。
function extractFrontmatter(text) {
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (!match) return { meta: null, body: text }

  const meta = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    const val = rawVal.trim()
    if (key === 'title') {
      meta.title = val.replace(/^'(.*)'$/, '$1').replace(/''/g, "'")
    } else if (key === 'date') {
      meta.date = val
    } else if (key === 'categories' || key === 'tags') {
      try { meta[key] = JSON.parse(val) } catch { meta[key] = [] }
    } else if (key === 'draft') {
      meta.draft = val === 'true'
    }
  }
  return { meta, body: text.slice(match[0].length) }
}

function renderFrontmatterHeader(meta) {
  if (!meta || !meta.title) return ''
  const pill = (text, cls) => `<span class="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}">${escapeHtml(text)}</span>`
  const metaBits = []
  if (meta.date) metaBits.push(`<span>${formatFrontmatterDate(meta.date)}</span>`)
  if (meta.draft) metaBits.push(`<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">草稿</span>`)
  const metaLine = metaBits.join('<span class="text-slate-300 dark:text-slate-600">·</span>')
  const categoryPills = (meta.categories || []).map(c => pill(c, 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-300')).join('')
  const tagPills = (meta.tags || []).map(t => pill(t, 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400')).join('')

  return `<header class="mb-10 pb-8 border-b border-slate-200 dark:border-slate-700">
    <h1 class="text-4xl font-extrabold text-slate-900 dark:text-slate-100 mb-3 leading-[1.2] tracking-tight">${escapeHtml(meta.title)}</h1>
    <div class="flex flex-wrap items-center gap-2 mb-5 text-sm text-slate-400 dark:text-slate-500">${metaLine}</div>
    <div class="mb-5">
      <div class="text-xs text-slate-400 dark:text-slate-500 mb-1">作者</div>
      <div class="text-base font-bold text-slate-700 dark:text-slate-300">Advantech ESS</div>
    </div>
    <div class="flex flex-wrap gap-1.5">${categoryPills}${tagPills}</div>
  </header>`
}

const renderResult = computed(() => {
  const raw = activeContent.value
  if (!raw) return { html: '<p class="text-slate-400 italic">（尚無內容）</p>', toc: [] }

  const { meta, body } = extractFrontmatter(raw)
  const headerHtml = renderFrontmatterHeader(meta)
  const text = body

  const lines = text.split('\n')
  const out = []
  const toc = []
  let headingSeq = 0
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
    out.push(`<${tag} class="list-none pl-0 space-y-2.5 mb-6 leading-[1.8] text-[15px]">${listItems.join('')}</${tag}>`)
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
    if (line.startsWith('# ')) { flushList(); out.push(`<h1 class="text-2xl font-bold mt-10 mb-4 pb-2 border-b border-slate-200 dark:border-slate-700">${inlineMd(line.slice(2))}</h1>`); continue }
    if (line.startsWith('## ')) {
      flushList()
      const headingText = line.slice(3)
      const id = `heading-${++headingSeq}`
      toc.push({ id, level: 2, text: headingText })
      out.push(`<h2 id="${id}" class="text-2xl font-bold mt-12 mb-4 text-slate-900 dark:text-slate-100 leading-snug scroll-mt-6">${inlineMd(headingText)}</h2>`)
      continue
    }
    if (line.startsWith('### ')) {
      flushList()
      const headingText = line.slice(4)
      const id = `heading-${++headingSeq}`
      toc.push({ id, level: 3, text: headingText })
      out.push(`<h3 id="${id}" class="text-lg font-bold mt-8 mb-3 text-slate-800 dark:text-slate-200 leading-snug scroll-mt-6">${inlineMd(headingText)}</h3>`)
      continue
    }
    if (line.startsWith('#### ')) { flushList(); out.push(`<h4 class="text-base font-bold mt-6 mb-2 text-slate-700 dark:text-slate-300">${inlineMd(line.slice(5))}</h4>`); continue }
    if (line === '---') { flushList(); out.push('<hr class="border-slate-200 dark:border-slate-700 my-10">'); continue }
    if (line.startsWith('>')) {
      flushList()
      const quoted = line.slice(1).replace(/^ /, '')
      out.push(`<blockquote class="border-l-4 border-blue-300 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-900/10 rounded-r-md pl-4 pr-4 py-2 my-6 text-slate-500 dark:text-slate-400 italic text-sm leading-relaxed">${inlineMd(quoted)}</blockquote>`)
      continue
    }

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
    out.push(`<p class="mb-5 leading-[1.9] text-[15px] text-slate-600 dark:text-slate-300">${inlineMd(line)}</p>`)
  }
  flushList()
  flushTable()
  return { html: headerHtml + out.join('\n'), toc }
})

const renderedMarkdown = computed(() => renderResult.value.html)
const tocItems = computed(() => renderResult.value.toc)

function scrollToHeading(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

watch(() => props.projectSlug, async (slug) => {
  if (!slug) return
  currentName.value = ''
  fileContent.value = ''
  originalContent.value = ''
  isAnalyzing.value = false
  docType.value = 'tech'
  resetBlogState()
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
  clearInterval(blogPollTimer)
  clearTimeout(saveSuccessTimer)
})
</script>
