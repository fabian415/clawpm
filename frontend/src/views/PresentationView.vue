<template>
  <div class="h-full flex -m-8 overflow-hidden">

    <!-- Left Sidebar: 歷史簡報清單 -->
    <div
      :class="sidebarOpen ? 'w-64' : 'w-0'"
      class="shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 transition-all duration-200 overflow-hidden"
    >
      <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 shrink-0 gap-2">
        <span class="text-sm font-bold text-slate-700 dark:text-slate-300 truncate">{{ projectName || projectSlug }}</span>
        <button @click="fetchDecks" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600" title="重新整理">
          <RefreshCw :class="isLoadingList ? 'animate-spin' : ''" class="w-3.5 h-3.5" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto py-2">
        <div v-if="isLoadingList" class="flex items-center justify-center py-12 text-slate-400">
          <Loader2 class="w-5 h-5 animate-spin" />
        </div>
        <div v-else-if="decks.length === 0" class="px-4 py-6 text-center text-xs text-slate-400">
          尚無簡報<br>
          <span class="text-slate-300">按「開始規劃」產生第一份</span>
        </div>
        <div
          v-for="d in decks"
          :key="d.name"
          @click="selectDeck(d)"
          :class="currentDeck && currentDeck.name === d.name
            ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 border-l-2 border-indigo-500'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-l-2 border-transparent'"
          class="group relative w-full text-left px-4 py-2.5 transition-colors cursor-pointer"
        >
          <div class="text-sm font-medium flex items-center gap-1.5">
            <Presentation class="w-3.5 h-3.5 shrink-0" /> 簡報
          </div>
          <div class="text-[10px] text-slate-400 mt-0.5 font-mono">{{ d.displayDate }}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">{{ d.pages ? `${d.pages} 頁預覽` : '產生中…' }}</div>
          <button
            @click.stop="deleteDeck(d)"
            :disabled="deletingName === d.name"
            class="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
            title="刪除此簡報"
          >
            <Loader2 v-if="deletingName === d.name" class="w-3.5 h-3.5 animate-spin" />
            <Trash2 v-else class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>

    <!-- Main area -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">

      <!-- Toolbar -->
      <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 bg-slate-50 dark:bg-slate-900 shrink-0">
        <div class="flex items-center gap-2">
          <button @click="sidebarOpen = !sidebarOpen" :class="sidebarOpen ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all" title="切換簡報清單">
            <PanelLeft class="w-4 h-4" />
          </button>
          <span class="text-sm font-bold text-slate-700 dark:text-slate-300">簡報生成</span>
        </div>
        <button
          v-if="currentDeck"
          @click="downloadDeck(currentDeck)"
          :disabled="isDownloading"
          class="bg-slate-200 dark:bg-slate-800 px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-1.5 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
        >
          <Loader2 v-if="isDownloading" class="w-3.5 h-3.5 animate-spin" />
          <Download v-else class="w-3.5 h-3.5" /> 下載 .pptx
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6 space-y-6">

        <!-- 規劃精靈 -->
        <div class="max-w-3xl mx-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm">

          <!-- 步驟 1：開始 -->
          <template v-if="phase === 'intro'">
            <div class="flex items-center gap-2 mb-2">
              <Sparkles class="w-4 h-4 text-indigo-500" />
              <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300">規劃一份新簡報</h3>
            </div>
            <p class="text-xs text-slate-400 mb-3 leading-relaxed">
              系統會先讀取此專案並上網做市場／技術研究，再反問你幾個關鍵問題，最後依你的回答規劃出有故事性的簡報（套用競賽模板）。
            </p>
            <textarea
              v-model="extraNote"
              rows="2"
              class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-700 dark:text-slate-200 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="（選填）有什麼特別想強調的方向或限制？例如：以市場行銷角度、12 頁、對客戶提案…"
            ></textarea>
            <div class="flex justify-end mt-3">
              <button
                @click="startPlan"
                class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1.5 hover:bg-indigo-700 transition-colors"
              >
                <Sparkles class="w-4 h-4" /> 開始規劃
              </button>
            </div>
          </template>

          <!-- 步驟 2：研究中 -->
          <template v-else-if="phase === 'discovering'">
            <div class="flex flex-col items-center py-8 text-center">
              <Loader2 class="w-6 h-6 animate-spin text-indigo-500 mb-3" />
              <div class="text-sm font-medium text-slate-600 dark:text-slate-300">AI 正在做市場／技術研究並準備問題…</div>
              <div class="text-xs text-slate-400 mt-1">可於右下聊天面板查看進度，約需 1–3 分鐘</div>
            </div>
          </template>

          <!-- 步驟 3：研究摘要 + 問答 -->
          <template v-else-if="phase === 'questions' && discovery">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <Sparkles class="w-4 h-4 text-indigo-500" />
                <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300">研究摘要與方向確認</h3>
              </div>
              <button @click="phase = 'intro'" class="text-xs text-slate-400 hover:text-slate-600">重新規劃</button>
            </div>

            <!-- 研究摘要 -->
            <div v-if="discovery.research_brief && discovery.research_brief.length" class="mb-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3">
              <div class="text-xs font-bold text-slate-500 dark:text-slate-400 mb-2">市場／技術研究重點</div>
              <ul class="space-y-1.5">
                <li v-for="(r, i) in discovery.research_brief" :key="i" class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex gap-1.5">
                  <span class="text-indigo-400 shrink-0">•</span>
                  <span>
                    {{ r.point }}
                    <a v-if="r.url" :href="r.url" target="_blank" rel="noopener" class="text-indigo-500 hover:underline ml-1 inline-flex items-center gap-0.5">
                      來源<ExternalLink class="w-3 h-3" />
                    </a>
                  </span>
                </li>
              </ul>
            </div>

            <!-- 問答 -->
            <div class="space-y-4">
              <div v-for="q in discovery.questions" :key="q.id">
                <label class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">{{ q.question }}</label>
                <p v-if="q.hint" class="text-[11px] text-slate-400 mb-1.5">{{ q.hint }}</p>

                <!-- single -->
                <div v-if="q.type === 'single'" class="space-y-1.5">
                  <label v-for="opt in q.options" :key="opt.value"
                    :class="answers[q.id] === opt.value ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-slate-200 dark:border-slate-700'"
                    class="flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm text-slate-600 dark:text-slate-300 hover:border-indigo-300 transition-colors">
                    <input type="radio" :name="q.id" :value="opt.value" v-model="answers[q.id]" class="accent-indigo-600" />
                    {{ opt.label }}
                  </label>
                </div>

                <!-- multi -->
                <div v-else-if="q.type === 'multi'" class="space-y-1.5">
                  <label v-for="opt in q.options" :key="opt.value"
                    :class="Array.isArray(answers[q.id]) && answers[q.id].includes(opt.value) ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-slate-200 dark:border-slate-700'"
                    class="flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm text-slate-600 dark:text-slate-300 hover:border-indigo-300 transition-colors">
                    <input type="checkbox" :value="opt.value" v-model="answers[q.id]" class="accent-indigo-600" />
                    {{ opt.label }}
                  </label>
                </div>

                <!-- open -->
                <textarea v-else v-model="answers[q.id]" rows="2"
                  :placeholder="q.placeholder || ''"
                  class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-700 dark:text-slate-200 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
              </div>
            </div>

            <!-- 視覺風格選擇 -->
            <div class="mt-5">
              <label class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">簡報視覺風格</label>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button
                  v-for="st in styleOptions"
                  :key="st.value"
                  type="button"
                  @click="selectedStyle = st.value"
                  :class="selectedStyle === st.value ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-slate-200 dark:border-slate-700'"
                  class="text-left px-3 py-2 rounded-lg border hover:border-indigo-300 transition-colors"
                >
                  <div class="flex items-center gap-1 mb-1">
                    <span v-for="c in st.swatches" :key="c" class="w-3 h-3 rounded-full" :style="{ backgroundColor: c }"></span>
                  </div>
                  <div class="text-xs font-bold text-slate-700 dark:text-slate-300">{{ st.label }}</div>
                  <div class="text-[10px] text-slate-400">{{ st.desc }}</div>
                </button>
              </div>
            </div>

            <div class="flex justify-end mt-4">
              <button
                @click="submitAnswers"
                class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1.5 hover:bg-indigo-700 transition-colors"
              >
                <Sparkles class="w-4 h-4" /> 設計故事大綱
              </button>
            </div>
          </template>

          <!-- 步驟 4：設計故事大綱中 -->
          <template v-else-if="phase === 'outlining'">
            <div class="flex flex-col items-center py-8 text-center">
              <Loader2 class="w-6 h-6 animate-spin text-indigo-500 mb-3" />
              <div class="text-sm font-medium text-slate-600 dark:text-slate-300">
                {{ outlineRevision > 1 ? 'AI 正在依你的回饋重新設計故事線…' : 'AI 正在把每一頁的目的想清楚、設計故事大綱…' }}
              </div>
              <div class="text-xs text-slate-400 mt-1">可於右下聊天面板查看進度，約需 1–3 分鐘</div>
            </div>
          </template>

          <!-- 步驟 5：故事大綱確認（必經關卡） -->
          <template v-else-if="phase === 'outline_review' && outline">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <BookOpen class="w-4 h-4 text-indigo-500" />
                <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300">故事大綱 · 第 {{ outlineRevision }} 版</h3>
              </div>
              <span
                v-if="outline.self_check"
                :class="outline.self_check.is_complete_story ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'"
                class="text-xs font-medium flex items-center gap-1"
              >
                <component :is="outline.self_check.is_complete_story ? CheckCircle2 : AlertTriangle" class="w-3.5 h-3.5" />
                {{ outline.self_check.is_complete_story ? 'AI 自我檢視：故事完整' : 'AI 自我檢視：有疑慮' }}
              </span>
            </div>

            <!-- 整體目的 -->
            <div class="mb-4 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-900/40 p-3">
              <div class="text-[11px] font-bold text-indigo-500 dark:text-indigo-400 mb-1">這份簡報的目的</div>
              <p class="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">{{ outline.deck_purpose }}</p>
              <div v-if="outline.core_message" class="text-xs text-slate-500 dark:text-slate-400 mt-2">
                核心訊息：<span class="font-medium text-slate-600 dark:text-slate-300">「{{ outline.core_message }}」</span>
              </div>
            </div>

            <!-- 自我檢視備註 -->
            <div v-if="outline.self_check && outline.self_check.notes" class="mb-4 text-xs text-slate-500 dark:text-slate-400 leading-relaxed border-l-2 border-slate-200 dark:border-slate-700 pl-3">
              {{ outline.self_check.notes }}
            </div>

            <!-- 逐頁大綱 -->
            <div class="space-y-2 mb-5">
              <div
                v-for="p in outline.pages"
                :key="p.index"
                class="rounded-lg border border-slate-200 dark:border-slate-800 p-3"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span class="w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-bold flex items-center justify-center shrink-0">{{ p.index }}</span>
                  <span class="text-sm font-bold text-slate-700 dark:text-slate-200">{{ p.one_liner }}</span>
                  <span v-if="p.type" class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-400 shrink-0">{{ p.type }}</span>
                </div>
                <p v-if="p.purpose" class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed pl-7">{{ p.purpose }}</p>
              </div>
            </div>

            <!-- 確認 or 回饋重來 -->
            <div class="border-t border-slate-200 dark:border-slate-800 pt-4">
              <p class="text-xs text-slate-500 dark:text-slate-400 mb-2">這樣的故事夠不夠打動人心？滿意就直接開始製作；不滿意可以寫下想法，讓 AI 重新設計故事線。</p>
              <textarea
                v-model="outlineFeedback"
                rows="2"
                class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-700 dark:text-slate-200 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-3"
                placeholder="（選填）例如：太像流水帳、開場不夠吸引人、希望更聚焦在效益、少放一些技術細節…"
              ></textarea>
              <div class="flex justify-end gap-2">
                <button
                  @click="refineOutline"
                  class="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                  <RefreshCw class="w-4 h-4" /> 重新設計故事線
                </button>
                <button
                  @click="approveOutline"
                  class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1.5 hover:bg-indigo-700 transition-colors"
                >
                  <Sparkles class="w-4 h-4" /> 這故事夠好，開始製作
                </button>
              </div>
            </div>
          </template>

          <!-- 步驟 6：生成中 -->
          <template v-else-if="phase === 'generating'">
            <div class="flex flex-col items-center py-8 text-center">
              <Loader2 class="w-6 h-6 animate-spin text-indigo-500 mb-3" />
              <div class="text-sm font-medium text-slate-600 dark:text-slate-300">正在依已確認的故事大綱製作簡報…</div>
              <div class="text-xs text-slate-400 mt-1">可於右下聊天面板查看進度</div>
            </div>
          </template>

          <!-- 步驟 7：完成 -->
          <template v-else-if="phase === 'done'">
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                <Sparkles class="w-4 h-4" /> 簡報已生成，預覽如下
              </div>
              <button @click="resetWizard" class="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1.5 hover:bg-indigo-700 transition-colors">
                <Sparkles class="w-4 h-4" /> 再規劃一份
              </button>
            </div>
          </template>
        </div>

        <!-- 預覽區 -->
        <div v-if="currentDeck" class="max-w-5xl mx-auto">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300">
              預覽 · {{ currentDeck.displayDate }}
            </h3>
            <span class="text-xs text-slate-400">{{ previewPages.length }} 頁</span>
          </div>
          <div v-if="previewPages.length === 0 && (isRendering || phase === 'generating')" class="text-center py-12 text-xs text-slate-400">
            <Loader2 class="w-5 h-5 animate-spin mx-auto mb-2" />
            預覽渲染中，請稍候…
          </div>
          <div v-else-if="previewPages.length === 0" class="text-center py-12 text-xs text-slate-400">
            此份簡報尚無預覽縮圖。<br>
            <button @click="fetchDecks" class="text-indigo-500 hover:underline mt-1">點此重新整理</button>
            ，或直接以右上「下載 .pptx」取得檔案。
          </div>
          <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div
              v-for="(p, idx) in previewPages"
              :key="p"
              @click="openLightbox(idx)"
              class="group relative border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden shadow-sm bg-white cursor-zoom-in"
            >
              <img :src="p" class="w-full block" loading="lazy" />
              <div class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/50 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
                第 {{ idx + 1 }} 頁 · 點擊放大
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- Lightbox：放大檢視 + 左右換頁 -->
    <div
      v-if="lightboxIndex !== null"
      class="fixed inset-0 z-50 bg-black/85 flex items-center justify-center"
      @click.self="closeLightbox"
    >
      <button
        @click="closeLightbox"
        class="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        title="關閉 (Esc)"
      >
        <X class="w-5 h-5" />
      </button>
      <button
        v-if="previewPages.length > 1"
        @click.stop="prevPage"
        class="absolute left-3 sm:left-6 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        title="上一頁 (←)"
      >
        <ChevronLeft class="w-7 h-7" />
      </button>
      <div class="max-w-[90vw] max-h-[88vh] flex flex-col items-center gap-3" @click.stop>
        <img :src="previewPages[lightboxIndex]" class="max-w-[90vw] max-h-[80vh] object-contain rounded-lg shadow-2xl" />
        <div class="text-white/80 text-sm font-medium">
          第 {{ lightboxIndex + 1 }} / {{ previewPages.length }} 頁
        </div>
      </div>
      <button
        v-if="previewPages.length > 1"
        @click.stop="nextPage"
        class="absolute right-3 sm:right-6 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        title="下一頁 (→)"
      >
        <ChevronRight class="w-7 h-7" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { PanelLeft, RefreshCw, Loader2, Download, Presentation, Sparkles, Trash2, ChevronLeft, ChevronRight, X, ExternalLink, BookOpen, CheckCircle2, AlertTriangle } from 'lucide-vue-next'

const props = defineProps({
  projectSlug: { type: String, required: true },
  projectName: { type: String, default: '' },
})

const emit = defineEmits(['presentation-ready'])

const sidebarOpen = ref(true)
const isLoadingList = ref(false)
const isRendering = ref(false)    // pptx 已產生、正在轉預覽縮圖
const isDownloading = ref(false)
const deletingName = ref(null)
const decks = ref([])
const currentDeck = ref(null)
const previewPages = ref([])
const lightboxIndex = ref(null)

// 規劃精靈狀態
const phase = ref('intro')        // intro | discovering | questions | outlining | outline_review | generating | done
const extraNote = ref('')
const planId = ref(null)
const discovery = ref(null)
const answers = ref({})
const selectedStyle = ref('professional')
const outline = ref(null)          // 目前顯示的故事大綱
const outlineRevision = ref(0)     // 目前大綱版本號（generate 需要「已確認」的版本）
const outlineFeedback = ref('')    // 使用者對大綱的回饋(要求重新設計時帶入)
const styleOptions = [
  { value: 'professional', label: '沉穩商務', desc: '綠 · 專業', swatches: ['#72A376', '#A8CDD7', '#676A55'] },
  { value: 'vivid', label: '活潑明亮', desc: '藍粉 · 生動', swatches: ['#A8CDD7', '#E8B7B7', '#CEC597'] },
  { value: 'minimal', label: '極簡留白', desc: '大字 · 留白', swatches: ['#676A55', '#C0BEAF', '#FFFFFF'] },
  { value: 'warm', label: '溫暖大地', desc: '金粉 · 溫暖', swatches: ['#CEC597', '#E8B7B7', '#72A376'] },
]

let pollTimer = null
let planTimer = null
let outlineTimer = null

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

onMounted(() => {
  fetchDecks()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  clearInterval(pollTimer)
  clearInterval(planTimer)
  clearInterval(outlineTimer)
})

// ── 簡報清單與預覽 ────────────────────────────────────────────────────────────

async function fetchDecks() {
  isLoadingList.value = true
  try {
    const res = await fetch(`/api/presentation/list?slug=${encodeURIComponent(props.projectSlug)}`, { headers: authHeaders() })
    if (res.ok) {
      const data = await res.json()
      decks.value = data.decks || []
      if (currentDeck.value) {
        const updated = decks.value.find(d => d.name === currentDeck.value.name)
        if (updated) selectDeck(updated)
      }
    }
  } catch (err) {
    console.error('[presentation] list error:', err)
  } finally {
    isLoadingList.value = false
  }
}

function buildPreviewUrls(deck) {
  const token = localStorage.getItem('clawpm_token') || ''
  const urls = []
  for (let i = 1; i <= (deck.pages || 0); i++) {
    const page = String(i).padStart(2, '0')
    urls.push(`/api/presentation/preview?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(deck.name)}&page=${page}&token=${encodeURIComponent(token)}`)
  }
  return urls
}

function selectDeck(deck) {
  currentDeck.value = deck
  previewPages.value = buildPreviewUrls(deck)
  lightboxIndex.value = null
}

// ── Phase 1：開始規劃（研究 + 產生問題）───────────────────────────────────────

async function startPlan() {
  phase.value = 'discovering'
  discovery.value = null
  planId.value = null
  try {
    const res = await fetch('/api/presentation/plan/start', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectSlug: props.projectSlug,
        projectName: props.projectName,
        note: extraNote.value.trim() || undefined,
      }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '啟動規劃失敗')
    }
    const data = await res.json()
    planId.value = data.planId

    emit('presentation-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startPlanPolling(data.planId)
  } catch (err) {
    alert(`啟動規劃失敗：${err.message}`)
    phase.value = 'intro'
  }
}

function startPlanPolling(id) {
  clearInterval(planTimer)
  let ticks = 0
  planTimer = setInterval(async () => {
    ticks++
    if (ticks > 200) { clearInterval(planTimer); if (phase.value === 'discovering') phase.value = 'intro'; return }
    try {
      const res = await fetch(
        `/api/presentation/plan/result?slug=${encodeURIComponent(props.projectSlug)}&planId=${encodeURIComponent(id)}`,
        { headers: authHeaders() }
      )
      if (!res.ok) return
      const data = await res.json()
      if (data.ready && data.discovery) {
        clearInterval(planTimer)
        discovery.value = data.discovery
        initAnswers(data.discovery)
        phase.value = 'questions'
      }
    } catch {}
  }, 3000)
}

function initAnswers(disc) {
  const a = {}
  for (const q of (disc.questions || [])) {
    if (q.type === 'multi') a[q.id] = []
    else a[q.id] = ''
  }
  answers.value = a
}

// ── Phase 2：依回答設計故事大綱（必經確認關卡）─────────────────────────────────

function buildAnswersPayload() {
  const payloadAnswers = { ...answers.value }
  if (extraNote.value.trim()) payloadAnswers._note = extraNote.value.trim()
  return payloadAnswers
}

async function submitAnswers() {
  phase.value = 'outlining'
  outline.value = null
  try {
    const res = await fetch('/api/presentation/outline/start', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectSlug: props.projectSlug,
        projectName: props.projectName,
        planId: planId.value,
        answers: buildAnswersPayload(),
        style: selectedStyle.value,
      }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '啟動大綱設計失敗')
    }
    const data = await res.json()
    emit('presentation-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startOutlinePolling(data.revision)
  } catch (err) {
    alert(`啟動大綱設計失敗：${err.message}`)
    phase.value = 'questions'
  }
}

function startOutlinePolling(revision) {
  clearInterval(outlineTimer)
  let ticks = 0
  outlineTimer = setInterval(async () => {
    ticks++
    if (ticks > 200) { clearInterval(outlineTimer); if (phase.value === 'outlining') phase.value = 'questions'; return }
    try {
      const res = await fetch(
        `/api/presentation/outline/result?slug=${encodeURIComponent(props.projectSlug)}&planId=${encodeURIComponent(planId.value)}&revision=${revision}`,
        { headers: authHeaders() }
      )
      if (!res.ok) return
      const data = await res.json()
      if (data.ready && data.outline) {
        clearInterval(outlineTimer)
        outline.value = data.outline
        outlineRevision.value = revision
        outlineFeedback.value = ''
        phase.value = 'outline_review'
      }
    } catch {}
  }, 3000)
}

async function refineOutline() {
  phase.value = 'outlining'
  try {
    const res = await fetch('/api/presentation/outline/start', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectSlug: props.projectSlug,
        projectName: props.projectName,
        planId: planId.value,
        answers: buildAnswersPayload(),
        style: selectedStyle.value,
        feedback: outlineFeedback.value.trim() || undefined,
        previousRevision: outlineRevision.value,
      }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '重新設計故事線失敗')
    }
    const data = await res.json()
    emit('presentation-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startOutlinePolling(data.revision)
  } catch (err) {
    alert(`重新設計故事線失敗：${err.message}`)
    phase.value = 'outline_review'
  }
}

// ── Phase 3：大綱確認後才生成 pptx ────────────────────────────────────────────

async function approveOutline() {
  phase.value = 'generating'
  try {
    const res = await fetch('/api/presentation/generate', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectSlug: props.projectSlug,
        projectName: props.projectName,
        planId: planId.value,
        revision: outlineRevision.value,
        style: selectedStyle.value,
      }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '啟動生成失敗')
    }
    const data = await res.json()
    emit('presentation-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startPolling(data.filename)
  } catch (err) {
    alert(`啟動生成失敗：${err.message}`)
    phase.value = 'outline_review'
  }
}

function startPolling(filename) {
  clearInterval(pollTimer)
  let ticks = 0
  let renderTicks = 0
  pollTimer = setInterval(async () => {
    ticks++
    if (ticks > 400) { clearInterval(pollTimer); isRendering.value = false; if (phase.value === 'generating') phase.value = 'done'; return }
    try {
      const res = await fetch(
        `/api/presentation/result?slug=${encodeURIComponent(props.projectSlug)}&filename=${encodeURIComponent(filename)}`,
        { headers: authHeaders() }
      )
      if (!res.ok) return
      const data = await res.json()
      if (!data.ready) return

      isRendering.value = true
      if (phase.value === 'generating') phase.value = 'done'
      await fetchDecks()
      const deck = decks.value.find(d => d.name === filename)
      if (deck) selectDeck(deck)

      if (deck && deck.pages > 0) {
        clearInterval(pollTimer)
        isRendering.value = false
        return
      }
      renderTicks++
      if (renderTicks > 50) { clearInterval(pollTimer); isRendering.value = false }
    } catch {}
  }, 3000)
}

function resetWizard() {
  phase.value = 'intro'
  discovery.value = null
  planId.value = null
  answers.value = {}
  outline.value = null
  outlineRevision.value = 0
  outlineFeedback.value = ''
}

// ── 下載 / 刪除 ───────────────────────────────────────────────────────────────

async function downloadDeck(deck) {
  if (isDownloading.value) return
  isDownloading.value = true
  try {
    const res = await fetch(
      `/api/presentation/download?slug=${encodeURIComponent(props.projectSlug)}&name=${encodeURIComponent(deck.name)}`,
      { headers: authHeaders() }
    )
    if (!res.ok) throw new Error('下載失敗')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${props.projectSlug}-${deck.name}.pptx`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (err) {
    alert(`下載失敗：${err.message}`)
  } finally {
    isDownloading.value = false
  }
}

async function deleteDeck(deck) {
  if (deletingName.value) return
  if (!confirm(`確定要刪除這份簡報（${deck.displayDate}）嗎？此動作無法復原。`)) return
  deletingName.value = deck.name
  try {
    const res = await fetch('/api/presentation/delete', {
      method: 'DELETE',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: props.projectSlug, name: deck.name }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || '刪除失敗')
    }
    if (currentDeck.value && currentDeck.value.name === deck.name) {
      currentDeck.value = null
      previewPages.value = []
    }
    await fetchDecks()
  } catch (err) {
    alert(`刪除失敗：${err.message}`)
  } finally {
    deletingName.value = null
  }
}

// ── 預覽放大燈箱 ──────────────────────────────────────────────────────────────

function openLightbox(idx) { lightboxIndex.value = idx }
function closeLightbox() { lightboxIndex.value = null }
function prevPage() {
  if (lightboxIndex.value === null || previewPages.value.length === 0) return
  lightboxIndex.value = (lightboxIndex.value - 1 + previewPages.value.length) % previewPages.value.length
}
function nextPage() {
  if (lightboxIndex.value === null || previewPages.value.length === 0) return
  lightboxIndex.value = (lightboxIndex.value + 1) % previewPages.value.length
}
function handleKeydown(e) {
  if (lightboxIndex.value === null) return
  if (e.key === 'Escape') closeLightbox()
  else if (e.key === 'ArrowLeft') prevPage()
  else if (e.key === 'ArrowRight') nextPage()
}
</script>
