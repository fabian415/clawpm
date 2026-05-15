<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Hero Banner -->
    <section class="bg-blue-600 rounded-2xl p-8 text-white flex justify-between items-center relative overflow-hidden shadow-lg shadow-blue-500/20">
      <div class="relative z-10">
        <h2 class="text-3xl font-bold mb-2">{{ greeting }}，{{ displayName }} 👋</h2>
        <p class="text-blue-100 mb-6">{{ welcomeMessage }}</p>
        <button @click="$emit('navigate', 'workflow')" class="bg-white text-blue-600 px-6 py-2.5 rounded-xl font-bold hover:bg-blue-50 transition-colors flex items-center gap-2 shadow-sm">
          <PlusCircle class="w-5 h-5" /> 上傳新會議
        </button>
      </div>
      <div class="relative z-10 hidden md:block">
        <div class="bg-white/20 backdrop-blur-md rounded-2xl p-4 border border-white/20">
          <div class="flex items-center gap-3 mb-2 text-sm">
            <span class="w-3 h-3 rounded-full animate-pulse" :class="containerStatusColor"></span>
            <span class="font-semibold">容器：{{ containerStatus }}</span>
          </div>
          <p class="text-xs opacity-80">{{ containerStatsText }}</p>
        </div>
      </div>
      <BrainCircuit class="absolute -right-12 -bottom-12 w-64 h-64 text-white/10 rotate-12" />
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Recent Projects -->
      <div class="lg:col-span-2 space-y-4">
        <h3 class="text-lg font-bold flex items-center gap-2">
          <Clock class="w-5 h-5" /> 最近專案
        </h3>
        <div v-if="isLoading" class="flex items-center justify-center py-12 text-slate-400">
          <Loader2 class="w-6 h-6 animate-spin" />
        </div>
        <div v-else-if="reviewerProjects.length === 0" class="py-12 text-center text-slate-400 text-sm">
          尚無專案資料，完成工作流程後將自動建立。
        </div>
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div
            v-for="p in reviewerProjects" :key="p.slug"
            @click="confirmDeleteSlug !== p.slug && $emit('open-reviewer-project', p.slug)"
            class="group p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-blue-500 hover:shadow-md transition-all"
            :class="confirmDeleteSlug !== p.slug ? 'cursor-pointer' : 'cursor-default'"
          >
            <div class="flex justify-between items-start mb-3">
              <h4 class="font-bold group-hover:text-blue-600 transition-colors flex-1 min-w-0 truncate pr-2">{{ p.name }}</h4>
              <div class="flex items-center gap-1.5 flex-shrink-0">
                <span v-if="p.readiness && confirmDeleteSlug !== p.slug" :class="maturityClass(p.readiness)" class="text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {{ p.readiness }}
                </span>
                <!-- 刪除確認 -->
                <div v-if="confirmDeleteSlug === p.slug" class="flex items-center gap-1" @click.stop>
                  <span class="text-xs text-red-600 font-medium whitespace-nowrap">確認刪除？</span>
                  <button @click.stop="deleteProject(p.slug)" :disabled="isDeleting" class="text-xs px-1.5 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 transition-colors">確認</button>
                  <button @click.stop="confirmDeleteSlug = null" class="text-xs px-1.5 py-0.5 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition-colors">取消</button>
                </div>
                <button
                  v-else
                  @click.stop="confirmDeleteSlug = p.slug"
                  class="opacity-0 group-hover:opacity-100 p-1 hover:text-red-600 text-slate-400 rounded transition-all"
                  title="刪除專案"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <p class="text-xs text-slate-500 mb-4">{{ p.stage || '—' }}</p>
            <div class="text-[10px] text-slate-400 flex items-center gap-1">
              <Calendar class="w-3 h-3" /> 更新於 {{ p.lastUpdated || '—' }}
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="space-y-4">
        <h3 class="text-lg font-bold">快速捷徑</h3>
        <div class="grid grid-cols-1 gap-3">
          <!-- Add Project -->
          <div class="bg-slate-100 dark:bg-slate-900 rounded-xl overflow-hidden">
            <button
              @click="toggleAddProject"
              class="w-full flex items-center justify-between p-4 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
            >
              <div class="flex items-center gap-3">
                <div class="p-2 bg-blue-100 text-blue-600 rounded-lg"><FolderPlus class="w-5 h-5" /></div>
                <span class="font-medium">新增專案</span>
              </div>
              <ChevronDown class="w-4 h-4 transition-transform duration-200" :class="showAddProject ? 'rotate-180' : ''" />
            </button>

            <!-- Inline form -->
            <div v-if="showAddProject" class="px-4 pb-4 space-y-3">
              <div class="flex gap-2">
                <input
                  v-model="newProjectName"
                  @keydown.enter.prevent="createProject"
                  type="text"
                  placeholder="輸入專案名稱..."
                  class="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autofocus
                />
                <button
                  @click="createProject"
                  :disabled="!newProjectName.trim() || isCreating"
                  class="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                >
                  <Plus class="w-4 h-4" />
                </button>
              </div>
              <p v-if="createError" class="text-red-500 text-xs">{{ createError }}</p>
              <p v-if="createSuccess" class="text-green-600 text-xs">{{ createSuccess }}</p>
            </div>
          </div>

          <button @click="$emit('navigate', 'settings')" class="w-full flex items-center justify-between p-4 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl transition-colors">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-purple-100 text-purple-600 rounded-lg"><Settings2 class="w-5 h-5" /></div>
              <span class="font-medium">容器設定</span>
            </div>
            <ChevronRight class="w-4 h-4" />
          </button>

          <button v-if="isAdmin" @click="$emit('navigate', 'account')" class="w-full flex items-center justify-between p-4 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl transition-colors">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-indigo-100 text-indigo-600 rounded-lg"><Users class="w-5 h-5" /></div>
              <span class="font-medium">帳號管理</span>
            </div>
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { PlusCircle, BrainCircuit, Clock, Calendar, ChevronRight, ChevronDown, Settings2, Loader2, FolderPlus, Plus, Users, Trash2 } from 'lucide-vue-next'

const props = defineProps({
  containerStatus: String,
  containerStatusColor: String,
  currentUser: Object,
  containerStats: Object,
  isAdmin: { type: Boolean, default: false },
})

defineEmits(['navigate', 'open-reviewer-project'])

const isLoading = ref(false)
const reviewerProjects = ref([])

const showAddProject = ref(false)
const newProjectName = ref('')
const isCreating = ref(false)
const createError = ref('')
const createSuccess = ref('')

const confirmDeleteSlug = ref(null)
const isDeleting = ref(false)

function toggleAddProject() {
  showAddProject.value = !showAddProject.value
  createError.value = ''
  createSuccess.value = ''
  if (!showAddProject.value) newProjectName.value = ''
}

async function createProject() {
  const name = newProjectName.value.trim()
  if (!name || isCreating.value) return

  isCreating.value = true
  createError.value = ''
  createSuccess.value = ''

  try {
    const res = await fetch('/api/project-insights/create', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '新增失敗')

    newProjectName.value = ''
    createSuccess.value = `「${data.name}」已建立`
    setTimeout(() => { createSuccess.value = '' }, 3000)
    await fetchReviewerProjects()
  } catch (err) {
    createError.value = err.message
  } finally {
    isCreating.value = false
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function deleteProject(slug) {
  isDeleting.value = true
  try {
    const res = await fetch(`/api/project-insights/delete?slug=${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      const data = await res.json()
      console.error('[dashboard] delete error:', data.error)
      return
    }
    confirmDeleteSlug.value = null
    await fetchReviewerProjects()
  } catch (err) {
    console.error('[dashboard] delete error:', err.message)
  } finally {
    isDeleting.value = false
  }
}

async function fetchReviewerProjects() {
  isLoading.value = true
  try {
    const res = await fetch('/api/project-insights/list', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    const projects = data.projects || []
    reviewerProjects.value = projects.sort((a, b) => {
      if (!a.lastUpdated) return 1
      if (!b.lastUpdated) return -1
      return b.lastUpdated.localeCompare(a.lastUpdated)
    })
  } catch (err) {
    console.error('[dashboard] reviewer fetch error:', err.message)
  } finally {
    isLoading.value = false
  }
}

function maturityClass(m) {
  if (!m) return 'bg-slate-100 dark:bg-slate-800 text-slate-500'
  const v = String(m).toLowerCase()
  if (v.includes('not ready')) return 'bg-slate-200 dark:bg-slate-700 text-slate-500'
  if (v.includes('internal')) return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
  if (v.includes('soft')) return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
  if (v.includes('public')) return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
  return 'bg-slate-100 dark:bg-slate-800 text-slate-400'
}

const containerStatsText = computed(() => {
  const s = props.containerStats
  const cpu = s?.cpuPercent != null ? `${s.cpuPercent}%` : '—'
  const memMB = s?.memoryUsedMB
  const mem = memMB != null
    ? (memMB >= 1024 ? `${(memMB / 1024).toFixed(1)}GB` : `${memMB}MB`)
    : '—'
  return `CPU 使用率：${cpu} / RAM：${mem}`
})

const displayName = computed(() =>
  props.currentUser?.name ?? props.currentUser?.email?.split('@')[0] ?? '使用者'
)

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 12) return '早安'
  if (h < 18) return '午安'
  return '晚安'
})

const welcomeMessages = [
  '歡迎回來！ClawPM 已準備好陪你征服今天的工作。',
  '又是充滿潛力的一天，讓我們一起把會議變成行動吧！',
  '你的洞察力是團隊的核心，今天也辛苦了。',
  '準備好了嗎？讓 ClawPM 幫你把每場會議的價值最大化。',
  '每次會議都是一個機會，讓我們把它變成真正的成果。',
  '歡迎回到你的智慧工作中心，今天有什麼想法想記錄下來？',
  '效率與洞察，從這裡出發。很高興再次見到你！',
  '好的開始是成功的一半，今天也要全力以赴！',
  '把想法化為行動，把討論化為決策，讓 ClawPM 幫你做到。',
  '每一場會議背後都藏著寶貴的智慧，讓我們一起挖掘它。',
  '專注當下，把每個對話都變成推動進展的燃料。',
  '團隊的力量從有效的溝通開始，你在這裡做得很好。',
  '今天的努力，會是明天決策的養分。繼續加油！',
  '清晰的紀錄造就清晰的方向，你選對工具了。',
  '不只是記錄，而是真正理解每一場對話的核心。',
]

function pickMessage() {
  return welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)]
}

const welcomeMessage = ref(pickMessage())
let welcomeTimer = null

onMounted(() => {
  welcomeTimer = setInterval(() => {
    welcomeMessage.value = pickMessage()
  }, 3 * 60 * 1000)
})

onUnmounted(() => {
  clearInterval(welcomeTimer)
})

onMounted(fetchReviewerProjects)
</script>
